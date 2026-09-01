// v1.0.38 -- Authenticated, targeted candle-series repair request.

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const TIMEFRAMES = new Set(["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"]);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
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

  let body: { terminal_id?: string; symbol?: string; timeframe?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json_body" }, 400);
  }

  if (!body.terminal_id) return jsonResponse({ error: "terminal_id_required" }, 400);
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{3,20}$/.test(symbol)) return jsonResponse({ error: "invalid_symbol_format" }, 400);
  const timeframe = typeof body.timeframe === "string" ? body.timeframe.trim().toUpperCase() : "";
  if (!TIMEFRAMES.has(timeframe)) return jsonResponse({ error: "unsupported_timeframe" }, 400);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: terminal, error: terminalError } = await admin
    .from("mt5_terminals")
    .select("id,user_id,status,ea_version")
    .eq("id", body.terminal_id)
    .maybeSingle();
  if (terminalError) return jsonResponse({ error: "lookup_failed", detail: terminalError.message }, 500);
  if (!terminal) return jsonResponse({ error: "terminal_not_found" }, 404);
  if (terminal.user_id !== userData.user.id) return jsonResponse({ error: "forbidden" }, 403);

  const { data, error } = await admin.rpc("request_price_feed_repair", {
    p_terminal_id: terminal.id,
    p_symbol: symbol,
    p_timeframe: timeframe,
    p_requested_by: userData.user.id,
    p_reason: "dashboard",
  });
  if (error) return jsonResponse({ error: "repair_request_failed", detail: error.message }, 500);
  if (data?.status === "series_not_enabled") return jsonResponse({ error: "series_not_enabled" }, 409);
  if (data?.status === "already_requested") return jsonResponse(data, 202);

  return jsonResponse({
    ...data,
    terminal_status: terminal.status,
    ea_version: terminal.ea_version,
  }, 202);
});

