// v1.0.2 — manual-order
//
// Places a brand-new manual position from the dashboard (no signal behind it).
// Validates ownership and hard risk caps, tags session/near-news context, then
// inserts into ea_commands. htf_regime is left NULL here — see the comment on
// ea_commands.htf_regime (migration 014) for why: no standalone regime-detection
// source exists yet for orders with no signal to inherit it from.
//
// v1.0.2: added optional sl_pips/tp_pips, for the Pairs view's per-symbol quick
// Buy/Sell buttons with Auto SL/TP enabled. The dashboard has no live price feed
// and cannot compute an absolute sl/tp client-side, so it sends a pip distance
// instead; the EA resolves it to an absolute level from its own live price at
// fill time (see migration 016). sl_pips/tp_pips are mutually exclusive with
// sl/tp respectively — send one or the other per field, not both.
//
// v1.0.12: body.symbol is now always treated as the canonical symbol name
// (e.g. EURUSD, not EURUSD.a). Resolved to this terminal's broker-specific
// string via symbol_mappings BEFORE the ea_commands insert — a command
// inserted with a symbol string the broker doesn't recognize is a doomed
// command, so we fail here with a clear, typed error instead.
//
// Request:  POST {
//   terminal_id, symbol, side: "buy"|"sell", volume, sl?, tp?, sl_pips?, tp_pips?,
//   max_deviation_points?, client_request_id?
// }
// Response: { ea_command_id, status: "queued" }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveBrokerSymbol } from "./_shared/symbol-resolver.ts";
import { captureMarketContext } from "../_shared/market-context.ts";

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

function sessionForNow(date: Date): "asia" | "london" | "ny" | "overlap" {
  const h = date.getUTCHours();
  if (h >= 0 && h < 7) return "asia";
  if (h >= 7 && h < 12) return "london";
  if (h >= 12 && h < 16) return "overlap";
  if (h >= 16 && h < 21) return "ny";
  return "asia";
}

async function nearNewsCheck(
  admin: ReturnType<typeof createClient>,
  at: Date,
  windowMinutes = 30,
): Promise<{ near: boolean; news_event_id: string | null }> {
  const from = new Date(at.getTime() - windowMinutes * 60_000).toISOString();
  const to = new Date(at.getTime() + windowMinutes * 60_000).toISOString();
  const { data } = await admin
    .from("calendar_events")
    .select("id")
    .in("impact", ["medium", "high"])
    .gte("event_time", from)
    .lte("event_time", to)
    .order("event_time", { ascending: true })
    .limit(1);
  if (data && data.length > 0) return { near: true, news_event_id: data[0].id };
  return { near: false, news_event_id: null };
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

  let body: {
    terminal_id?: string;
    symbol?: string;
    side?: "buy" | "sell";
    volume?: number;
    sl?: number;
    tp?: number;
    sl_pips?: number;
    tp_pips?: number;
    max_deviation_points?: number;
    client_request_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json_body" }, 400);
  }

  const required = ["terminal_id", "symbol", "side", "volume"] as const;
  for (const field of required) {
    if (body[field] === undefined || body[field] === null) {
      return jsonResponse({ error: `${field}_required` }, 400);
    }
  }
  if (body.side !== "buy" && body.side !== "sell") return jsonResponse({ error: "invalid_side" }, 400);
  if (!(body.volume! > 0)) return jsonResponse({ error: "invalid_volume" }, 400);
  if (body.sl !== undefined && body.sl_pips !== undefined) {
    return jsonResponse({ error: "sl_and_sl_pips_conflict" }, 400);
  }
  if (body.tp !== undefined && body.tp_pips !== undefined) {
    return jsonResponse({ error: "tp_and_tp_pips_conflict" }, 400);
  }
  if (body.sl_pips !== undefined && !(body.sl_pips > 0)) {
    return jsonResponse({ error: "invalid_sl_pips" }, 400);
  }
  if (body.tp_pips !== undefined && !(body.tp_pips > 0)) {
    return jsonResponse({ error: "invalid_tp_pips" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: terminal, error: terminalError } = await admin
    .from("mt5_terminals")
    .select("id, user_id, max_manual_lot_size, max_daily_loss_usd, max_open_positions")
    .eq("id", body.terminal_id)
    .maybeSingle();

  if (terminalError) return jsonResponse({ error: "lookup_failed", detail: terminalError.message }, 500);
  if (!terminal) return jsonResponse({ error: "terminal_not_found" }, 404);
  if (terminal.user_id !== userData.user.id) return jsonResponse({ error: "forbidden" }, 403);

  const symbolResolution = await resolveBrokerSymbol(admin, terminal.id, body.symbol!);
  if (symbolResolution.error) {
    const status = symbolResolution.error === "lookup_failed" ? 500 : 422;
    return jsonResponse(
      { error: symbolResolution.error, canonical_symbol: body.symbol, detail: symbolResolution.detail },
      status,
    );
  }
  const brokerSymbol = symbolResolution.brokerSymbol!;

  // Risk cap 1: max manual lot size.
  if (body.volume! > terminal.max_manual_lot_size) {
    return jsonResponse(
      { error: "max_manual_lot_size_exceeded", max: terminal.max_manual_lot_size },
      422,
    );
  }

  // Risk cap 2: max daily realized loss (UTC calendar day). The open-position
  // cap is enforced atomically by the ea_commands reservation trigger, which
  // includes in-flight queued commands as well as reported positions.
  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);
  const { data: todaysTrades } = await admin
    .from("trade_history")
    .select("profit")
    .eq("terminal_id", terminal.id)
    .gte("close_time", startOfDayUtc.toISOString());
  const realizedPl = (todaysTrades ?? []).reduce((sum, t) => sum + Number(t.profit), 0);
  if (realizedPl <= -terminal.max_daily_loss_usd) {
    return jsonResponse(
      { error: "max_daily_loss_reached", max_daily_loss_usd: terminal.max_daily_loss_usd, realized_today: realizedPl },
      422,
    );
  }

  const now = new Date();
  const riskDefined = (body.sl !== undefined && body.sl > 0) || (body.sl_pips !== undefined && body.sl_pips > 0);
  const marketContext = await captureMarketContext(admin, {
    terminalId: terminal.id, symbol: body.symbol!, at: now, origin: "dashboard_manual", riskDefined,
  });
  const idempotencyKey = body.client_request_id ?? crypto.randomUUID();

  const { data: command, error: insertError } = await admin
    .from("ea_commands")
    .insert({
      terminal_id: terminal.id,
      source: "manual_order",
      command_type: "open",
      symbol: brokerSymbol,
      side: body.side,
      volume: body.volume,
      sl: body.sl ?? null,
      tp: body.tp ?? null,
      sl_pips: body.sl_pips ?? null,
      tp_pips: body.tp_pips ?? null,
      max_deviation_points: body.max_deviation_points ?? 20,
      idempotency_key: idempotencyKey,
      session: marketContext.session,
      htf_regime: marketContext.htf_regime,
      near_news_event: marketContext.near_news_event,
      news_event_id: marketContext.news_event_id,
      strategy_name_at_entry: "Discretionary manual",
      origin_detail: "dashboard_manual",
      risk_defined: riskDefined,
      entry_context: marketContext.context,
    })
    .select()
    .single();

  if (insertError) {
    if (insertError.message.includes("max_open_positions_reached")) {
      return jsonResponse({ error: "max_open_positions_reached", max: terminal.max_open_positions }, 422);
    }
    if (insertError.code === "23505") {
      return jsonResponse({ error: "duplicate_request" }, 409);
    }
    return jsonResponse({ error: "insert_failed", detail: insertError.message }, 500);
  }

  return jsonResponse({ ea_command_id: command.id, status: command.status });
});
