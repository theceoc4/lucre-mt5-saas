// v1.0.3 — signal-action ("tap-to-action")
//
// Called when the trader taps a delivered signal on the dashboard. Validates the
// signal hasn't expired (TTL) or already been acted on, checks ownership and risk
// caps, then inserts the ea_commands row. The dashboard never writes to
// ea_commands or signal_deliveries directly — this function does, with the
// service role, per the architecture spec.
//
// v1.0.12: signal.symbol is a canonical symbol name, resolved to this
// terminal's broker-specific string via symbol_mappings before the
// ea_commands insert — same treatment as manual-order.
//
// v1.0.3: wires the Adaptive Throttle Engine's output (agent_policies, see
// migration 025/032) into this execution gate — the first order path that
// actually reads it. Migration 032 already applies the throttle decision at
// signal-generation time (suggested_volume scaled, policy_decision escalated
// on INSERT); this re-checks the *current* policy immediately before
// execution as a safety net for the window between generation and a tap:
//   - decision = 'block'      -> reject the tap (signal_deliveries -> 'blocked'),
//                                 no ea_commands row is ever created.
//   - decision = 'downweight' -> if the signal's own policy_decision was still
//                                 'ok' at generation time (meaning migration
//                                 032's insert-time gate never saw this cell
//                                 flip), apply downweight_factor to the volume
//                                 sent to the EA now. If policy_decision was
//                                 already 'downweight'/'block' at generation,
//                                 suggested_volume already reflects the
//                                 discount, so it is NOT re-applied here —
//                                 avoids double-discounting the same cell.
// Manual orders are intentionally not gated this way — see manual-order's
// header comment; they carry no strategy_id/htf_regime for a policy to match.
//
// Request:  POST { signal_delivery_id: string }
// Response: { ea_command_id, status: "queued" }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveBrokerSymbol } from "../_shared/symbol-resolver.ts";
import { lookupThrottlePolicy } from "../_shared/throttle-gate.ts";

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

// Simplified UTC session bucketing. London/NY overlap (12:00-16:00 UTC) is the
// highest-liquidity window and is tagged 'overlap' rather than either session
// individually. This is a heuristic pending a real session-calendar source.
function sessionForNow(date: Date): "asia" | "london" | "ny" | "overlap" {
  const h = date.getUTCHours();
  if (h >= 0 && h < 7) return "asia";
  if (h >= 7 && h < 12) return "london";
  if (h >= 12 && h < 16) return "overlap";
  if (h >= 16 && h < 21) return "ny";
  return "asia";
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

  let body: { signal_delivery_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json_body" }, 400);
  }
  if (!body.signal_delivery_id) return jsonResponse({ error: "signal_delivery_id_required" }, 400);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: delivery, error: deliveryError } = await admin
    .from("signal_deliveries")
    .select("*, signals(*), mt5_terminals(id, user_id, max_open_positions)")
    .eq("id", body.signal_delivery_id)
    .maybeSingle();

  if (deliveryError) return jsonResponse({ error: "lookup_failed", detail: deliveryError.message }, 500);
  if (!delivery) return jsonResponse({ error: "signal_delivery_not_found" }, 404);

  const terminal = delivery.mt5_terminals as unknown as { id: string; user_id: string; max_open_positions: number };
  if (!terminal || terminal.user_id !== userData.user.id) return jsonResponse({ error: "forbidden" }, 403);

  // v1.0.2: pass the signal's strategy_id through onto the ea_commands row
  // so the EA can tag the resulting position (see migration 029). Previously
  // dropped on the floor here, leaving every EA-opened position permanently
  // unattributed to a strategy.
  const signal = delivery.signals as unknown as {
    id: string;
    terminal_id: string;
    strategy_id: string;
    symbol: string;
    side: "buy" | "sell";
    suggested_volume: number;
    suggested_sl: number | null;
    suggested_tp: number | null;
    session: string | null;
    htf_regime: string | null;
    near_news_event: boolean;
    news_event_id: string | null;
    policy_decision: "ok" | "downweight" | "block";
    expires_at: string;
  };
  if (!signal) return jsonResponse({ error: "signal_not_found" }, 404);

  const now = new Date();

  // TTL guard — never execute a stale signal.
  if (new Date(signal.expires_at).getTime() < now.getTime()) {
    await admin.from("signal_deliveries").update({ status: "expired" }).eq("id", delivery.id);
    return jsonResponse({ error: "signal_expired" }, 409);
  }

  // Already acted upon — idempotent no-op response, not an error, so a double
  // tap (or client retry) doesn't surface as a failure.
  if (["pending", "delivered"].includes(delivery.status) === false) {
    return jsonResponse({ error: "already_acted", status: delivery.status }, 409);
  }

  // Adaptive Throttle Engine gate (v1.0.3) — re-check the live policy for
  // this exact cell right before execution.
  const throttlePolicy = await lookupThrottlePolicy(admin, {
    terminal_id: terminal.id,
    strategy_id: signal.strategy_id ?? null,
    symbol: signal.symbol,
    session: signal.session,
    htf_regime: signal.htf_regime,
    near_news_event: signal.near_news_event,
  });

  if (throttlePolicy?.decision === "block") {
    await admin
      .from("signal_deliveries")
      .update({ status: "blocked", acted_at: now.toISOString() })
      .eq("id", delivery.id);
    return jsonResponse(
      { error: "blocked_by_risk_engine", reason: throttlePolicy.reason ?? null },
      423,
    );
  }

  let effectiveVolume = signal.suggested_volume;
  if (
    throttlePolicy?.decision === "downweight" &&
    throttlePolicy.downweight_factor != null &&
    signal.policy_decision !== "downweight" &&
    signal.policy_decision !== "block"
  ) {
    // The cell shifted to downweight after this signal was generated — the
    // insert-time gate (migration 032) never saw it, so apply the discount
    // now instead of shipping the un-discounted suggested_volume.
    effectiveVolume = Math.round(signal.suggested_volume * throttlePolicy.downweight_factor * 100) / 100;
  }

  // Hard risk cap: max open positions per terminal.
  const { count: openCount } = await admin
    .from("positions")
    .select("id", { count: "exact", head: true })
    .eq("terminal_id", terminal.id)
    .eq("status", "open");
  if ((openCount ?? 0) >= terminal.max_open_positions) {
    return jsonResponse({ error: "max_open_positions_reached", max: terminal.max_open_positions }, 422);
  }

  const symbolResolution = await resolveBrokerSymbol(admin, terminal.id, signal.symbol);
  if (symbolResolution.error) {
    const status = symbolResolution.error === "lookup_failed" ? 500 : 422;
    return jsonResponse(
      { error: symbolResolution.error, canonical_symbol: signal.symbol, detail: symbolResolution.detail },
      status,
    );
  }
  const brokerSymbol = symbolResolution.brokerSymbol!;

  const idempotencyKey = `tap:${delivery.id}`;

  const { data: command, error: insertError } = await admin
    .from("ea_commands")
    .insert({
      terminal_id: terminal.id,
      source: "manual_tap",
      command_type: "open",
      symbol: brokerSymbol,
      side: signal.side,
      volume: effectiveVolume,
      sl: signal.suggested_sl,
      tp: signal.suggested_tp,
      idempotency_key: idempotencyKey,
      signal_delivery_id: delivery.id,
      strategy_id: signal.strategy_id ?? null,
      session: signal.session ?? sessionForNow(now),
      htf_regime: signal.htf_regime,
      near_news_event: signal.near_news_event,
      news_event_id: signal.news_event_id,
    })
    .select()
    .single();

  if (insertError) {
    // Unique violation on (terminal_id, idempotency_key) means a duplicate tap
    // raced us — treat as already-handled rather than a hard failure.
    if (insertError.code === "23505") {
      return jsonResponse({ error: "already_acted", status: "tapped" }, 409);
    }
    return jsonResponse({ error: "insert_failed", detail: insertError.message }, 500);
  }

  await admin
    .from("signal_deliveries")
    .update({ status: "tapped", acted_at: now.toISOString(), ea_command_id: command.id })
    .eq("id", delivery.id);

  return jsonResponse({ ea_command_id: command.id, status: command.status });
});
