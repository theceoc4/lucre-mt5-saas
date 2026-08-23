// v1.0.3 — position-action (dashboard modify / close)
//
// Validates ownership and position existence, then inserts a dashboard_modify or
// dashboard_close command. Close commands inherit session/regime/near-news context
// from the position's originating open command (so scenario_stats attributes the
// trade to the conditions it was opened under) when that command can be found;
// otherwise context is computed fresh at close time as a fallback.
//
// v1.0.2: added clear_sl / clear_tp so a modify can explicitly null out an
// existing stop/target — previously sl/tp used a `?? position.sl` fallback,
// which meant there was no way to clear a level once set (known gap fixed
// this release). clear_sl/clear_tp take precedence over sl/tp if both are
// sent for the same field.
//
// v1.0.3: modify/close commands now carry the position's own strategy_id
// forward (see migration 029) for command-history audit consistency —
// positions.strategy_id is already the authoritative source (set from the
// EA's position report at open time), so this is a direct copy, not a fresh
// lookup.
//
// Request:  POST { position_id, action: "modify"|"close", sl?, tp?,
//                   clear_sl?, clear_tp?, max_deviation_points?, client_request_id? }
// Response: { ea_command_id, status: "queued" }

import { createClient } from "jsr:@supabase/supabase-js@2";

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
    position_id?: string;
    action?: "modify" | "close";
    sl?: number | null;
    tp?: number | null;
    clear_sl?: boolean;
    clear_tp?: boolean;
    max_deviation_points?: number;
    client_request_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json_body" }, 400);
  }

  if (!body.position_id) return jsonResponse({ error: "position_id_required" }, 400);
  if (body.action !== "modify" && body.action !== "close") {
    return jsonResponse({ error: "invalid_action" }, 400);
  }
  const hasSlChange = body.sl !== undefined || body.clear_sl === true;
  const hasTpChange = body.tp !== undefined || body.clear_tp === true;
  if (body.action === "modify" && !hasSlChange && !hasTpChange) {
    return jsonResponse({ error: "sl_or_tp_required_for_modify" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: position, error: positionError } = await admin
    .from("positions")
    .select("*, mt5_terminals(id, user_id)")
    .eq("id", body.position_id)
    .maybeSingle();

  if (positionError) return jsonResponse({ error: "lookup_failed", detail: positionError.message }, 500);
  if (!position) return jsonResponse({ error: "position_not_found" }, 404);

  const terminal = position.mt5_terminals as unknown as { id: string; user_id: string };
  if (!terminal || terminal.user_id !== userData.user.id) return jsonResponse({ error: "forbidden" }, 403);
  if (position.status !== "open") {
    return jsonResponse({ error: "position_not_open", status: position.status }, 409);
  }

  const now = new Date();

  if (body.action === "modify") {
    const idempotencyKey = body.client_request_id ?? `modify:${position.id}:${now.getTime()}`;
    const { data: command, error: insertError } = await admin
      .from("ea_commands")
      .insert({
        terminal_id: terminal.id,
        source: "dashboard_modify",
        command_type: "modify",
        symbol: position.symbol,
        side: position.side,
        volume: position.volume,
        sl: body.clear_sl ? null : (body.sl ?? position.sl),
        tp: body.clear_tp ? null : (body.tp ?? position.tp),
        mt5_ticket: position.mt5_ticket,
        max_deviation_points: body.max_deviation_points ?? 20,
        idempotency_key: idempotencyKey,
        strategy_id: position.strategy_id ?? null,
      })
      .select()
      .single();

    if (insertError) {
      if (insertError.code === "23505") return jsonResponse({ error: "duplicate_request" }, 409);
      return jsonResponse({ error: "insert_failed", detail: insertError.message }, 500);
    }
    return jsonResponse({ ea_command_id: command.id, status: command.status });
  }

  // action === "close"
  const idempotencyKey = `close:${position.id}`;

  // Inherit context from the position's originating open command, if we can find it.
  const { data: openCommand } = await admin
    .from("ea_commands")
    .select("session, htf_regime, near_news_event, news_event_id")
    .eq("terminal_id", terminal.id)
    .eq("mt5_ticket", position.mt5_ticket)
    .eq("command_type", "open")
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let session = openCommand?.session ?? null;
  let htfRegime = openCommand?.htf_regime ?? null;
  let nearNews = openCommand?.near_news_event ?? false;
  let newsEventId = openCommand?.news_event_id ?? null;

  if (!openCommand) {
    session = sessionForNow(now);
    const newsCheck = await nearNewsCheck(admin, now);
    nearNews = newsCheck.near;
    newsEventId = newsCheck.news_event_id;
  }

  const { data: command, error: insertError } = await admin
    .from("ea_commands")
    .insert({
      terminal_id: terminal.id,
      source: "dashboard_close",
      command_type: "close",
      symbol: position.symbol,
      side: position.side,
      volume: position.volume,
      mt5_ticket: position.mt5_ticket,
      max_deviation_points: body.max_deviation_points ?? 20,
      idempotency_key: idempotencyKey,
      strategy_id: position.strategy_id ?? null,
      session,
      htf_regime: htfRegime,
      near_news_event: nearNews,
      news_event_id: newsEventId,
    })
    .select()
    .single();

  if (insertError) {
    if (insertError.code === "23505") return jsonResponse({ error: "already_closing" }, 409);
    return jsonResponse({ error: "insert_failed", detail: insertError.message }, 500);
  }

  await admin.from("positions").update({ status: "closing", updated_at: now.toISOString() }).eq("id", position.id);

  return jsonResponse({ ea_command_id: command.id, status: command.status });
});
