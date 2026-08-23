// v1.0.14 — bind-symbol
//
// Backs item 13's "add new pair" workflow on the Pairs page: user taps "+",
// types a pair (e.g. "USDSEK"), taps submit. This function does NOT talk to
// the broker directly (only the EA can — MT5's symbol universe is only
// visible from inside the terminal). Instead it:
//
//   1. Validates the terminal belongs to the calling user.
//   2. Normalizes the typed text into a canonical-symbol-shaped string.
//   3. Upserts a `pending_manual` placeholder row into symbol_mappings for
//      this terminal + symbol (idempotent — resubmitting the same pair just
//      re-flags it for scanning, never duplicates).
//   4. Sets mt5_terminals.force_symbol_rescan = true, the same flag the
//      existing "Rescan Symbols" button uses.
//
// The EA picks the rescan flag up on its next ea-sync poll and reports its
// full broker symbol universe to report-symbols, which now folds every
// `pending_manual` row into the same matchBrokerSymbols() pass used for the
// built-in canonical list (see _shared/symbol-resolver.ts) — so the typed
// pair binds "just like the initial pairs" if the broker actually offers it,
// or ends up `unavailable`/`needs_review` exactly like any other symbol that
// doesn't cleanly match, with no separate code path required.
//
// Request:  POST { terminal_id, symbol }
// Response: { status: "scanning", canonical_symbol }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { CANONICAL_SYMBOLS } from "./_shared/canonical-symbols.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Best-effort asset-class guess for display grouping only — it has zero
// effect on whether the symbol actually matches at the broker; that's
// decided purely by string comparison in matchBrokerSymbols().
function guessAssetClass(symbol: string): "fx" | "metal" | "index" | "crypto" {
  if (/^(XAU|XAG|XPT|XPD)/.test(symbol)) return "metal";
  const CRYPTO_BASES = ["BTC", "ETH", "LTC", "XRP", "BCH", "ADA", "SOL", "DOGE", "DOT", "BNB"];
  if (CRYPTO_BASES.some((c) => symbol.startsWith(c))) return "crypto";
  const FX_CODES = ["USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF"];
  if (symbol.length === 6 && FX_CODES.includes(symbol.slice(0, 3)) && FX_CODES.includes(symbol.slice(3, 6))) {
    return "fx";
  }
  return "index";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "missing_authorization" }, 401);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return jsonResponse({ error: "invalid_session" }, 401);

  let body: { terminal_id?: string; symbol?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json_body" }, 400);
  }
  if (!body.terminal_id) return jsonResponse({ error: "terminal_id_required" }, 400);
  if (!body.symbol || typeof body.symbol !== "string") return jsonResponse({ error: "symbol_required" }, 400);

  const symbol = body.symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (symbol.length < 3 || symbol.length > 20) {
    return jsonResponse({ error: "invalid_symbol_format" }, 400);
  }

  // v1.0.16 -- reject typed pairs that duplicate a *built-in* canonical
  // symbol (case-insensitive). Without this check, a pending_manual row
  // gets created with the same canonical_symbol as a CANONICAL_SYMBOLS
  // entry, so report-symbols' matchBrokerSymbols() emits two rows sharing
  // the same (terminal_id, canonical_symbol) key in one upsert batch --
  // Postgres rejects that whole batch with "ON CONFLICT DO UPDATE command
  // cannot affect row a second time", which silently breaks symbol sync
  // for every pair on the terminal, not just the duplicate one. Built-in
  // pairs are already selectable from the picker, so there's never a
  // legitimate reason to also type one in here.
  const isBuiltIn = CANONICAL_SYMBOLS.some((c) => c.symbol.toUpperCase() === symbol);
  if (isBuiltIn) {
    return jsonResponse(
      { error: "symbol_already_builtin", detail: `${symbol} is already available in the pair picker -- select it there instead of adding it manually.` },
      409,
    );
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: terminal, error: terminalError } = await admin
    .from("mt5_terminals")
    .select("id, user_id")
    .eq("id", body.terminal_id)
    .maybeSingle();

  if (terminalError) return jsonResponse({ error: "lookup_failed", detail: terminalError.message }, 500);
  if (!terminal) return jsonResponse({ error: "terminal_not_found" }, 404);
  if (terminal.user_id !== userData.user.id) return jsonResponse({ error: "forbidden" }, 403);

  const { data: existing } = await admin
    .from("symbol_mappings")
    .select("id, match_type, broker_symbol, needs_review")
    .eq("terminal_id", terminal.id)
    .eq("canonical_symbol", symbol)
    .maybeSingle();

  if (existing && existing.match_type !== "unavailable" && existing.match_type !== "pending_manual") {
    return jsonResponse({ error: "symbol_already_mapped", detail: `${symbol} is already tracked for this terminal.` }, 409);
  }

  const { error: upsertError } = await admin.from("symbol_mappings").upsert(
    {
      terminal_id: terminal.id,
      canonical_symbol: symbol,
      asset_class: guessAssetClass(symbol),
      broker_symbol: null,
      match_type: "pending_manual",
      candidates: [],
      needs_review: false,
      last_synced_at: new Date().toISOString(),
    },
    { onConflict: "terminal_id,canonical_symbol" },
  );

  if (upsertError) return jsonResponse({ error: "upsert_failed", detail: upsertError.message }, 500);

  const { error: rescanError } = await admin
    .from("mt5_terminals")
    .update({ force_symbol_rescan: true })
    .eq("id", terminal.id);

  if (rescanError) return jsonResponse({ error: "update_failed", detail: rescanError.message }, 500);

  return jsonResponse({ status: "scanning", canonical_symbol: symbol });
});
