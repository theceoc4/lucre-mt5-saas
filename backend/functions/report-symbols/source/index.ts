// v1.0.12 — report-symbols
//
// The EA's SymbolMap module posts here with its full broker symbol universe
// (SymbolsTotal(false)/SymbolName(i,false) — every symbol the broker offers,
// visible or not) whenever it runs a scan: once on EA startup, then either
// on the periodic auto-refresh timer (SymbolMapRefreshHours input) or
// on-demand when the dashboard's "Rescan Symbols" button sets
// mt5_terminals.force_symbol_rescan and the EA picks that up on its next
// ea-sync poll.
//
// Auth mirrors ea-sync exactly: plaintext x-api-key -> SHA-256 -> match
// against mt5_terminals.api_key_hash. Not a dashboard-facing function, so
// verify_jwt = false, same as ea-sync.
//
// Request body: { symbols: string[] }
// Response: { terminal_id, exact, auto_mapped, needs_review, unavailable, total_canonical }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { authenticateTerminal } from "../_shared/auth.ts";
import { matchBrokerSymbols } from "../_shared/symbol-resolver.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const auth = await authenticateTerminal(req, admin, "id");
  if (auth.error) {
    const status = auth.error === "missing_api_key" || auth.error === "invalid_api_key" ? 401 : 500;
    return jsonResponse({ error: auth.error, detail: auth.detail }, status);
  }
  const terminal = auth.terminal!;

  let body: { symbols?: string[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json_body" }, 400);
  }

  if (!Array.isArray(body.symbols) || body.symbols.length === 0) {
    return jsonResponse({ error: "missing_symbols_array" }, 400);
  }

  // v1.0.14 -- fold in any user-typed pairs awaiting their first scan (see
  // bind-symbol) so they're matched against this broker's real symbol
  // universe alongside the built-in canonical list, not just the static one.
  const { data: pendingRows, error: pendingError } = await admin
    .from("symbol_mappings")
    .select("canonical_symbol, asset_class")
    .eq("terminal_id", terminal.id)
    .eq("match_type", "pending_manual");

  if (pendingError) {
    return jsonResponse({ error: "pending_lookup_failed", detail: pendingError.message }, 500);
  }

  const extraCanonical = (pendingRows || []).map((r) => ({
    symbol: r.canonical_symbol,
    asset_class: r.asset_class,
  }));

  const matches = matchBrokerSymbols(body.symbols, extraCanonical);
  const nowIso = new Date().toISOString();

  const rows = matches.map((m) => ({
    terminal_id: terminal.id,
    canonical_symbol: m.canonical_symbol,
    asset_class: m.asset_class,
    broker_symbol: m.broker_symbol,
    match_type: m.match_type,
    candidates: m.candidates,
    needs_review: m.needs_review,
    last_synced_at: nowIso,
  }));

  // Upsert every canonical symbol — including 'unavailable' ones — so the
  // dashboard's mapping table always reflects the full canonical list for
  // this terminal, not just the ones that happened to resolve.
  const { error: upsertError } = await admin
    .from("symbol_mappings")
    .upsert(rows, { onConflict: "terminal_id,canonical_symbol" });

  if (upsertError) {
    return jsonResponse({ error: "upsert_failed", detail: upsertError.message }, 500);
  }

  const { error: terminalUpdateError } = await admin
    .from("mt5_terminals")
    .update({ force_symbol_rescan: false, last_symbol_scan_at: nowIso })
    .eq("id", terminal.id);

  if (terminalUpdateError) {
    return jsonResponse({ error: "terminal_update_failed", detail: terminalUpdateError.message }, 500);
  }

  const counts = { exact: 0, auto_mapped: 0, needs_review: 0, unavailable: 0 };
  for (const m of matches) {
    if (m.match_type === "exact") counts.exact++;
    else if (m.match_type === "auto_prefix") counts.auto_mapped++;
    else if (m.needs_review) counts.needs_review++;
    else counts.unavailable++;
  }

  return jsonResponse({
    terminal_id: terminal.id,
    total_canonical: matches.length,
    ...counts,
  });
});
