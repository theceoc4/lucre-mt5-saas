// v1.0.46 -- EA-key-authenticated relay for private live position snapshots.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { authenticateTerminal } from "./_shared/auth.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
});

interface PositionState {
  mt5_ticket: number;
  volume: number;
  current_price: number;
  unrealized_pl: number;
  sl: number | null;
  tp: number | null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validPosition(value: unknown): value is PositionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(row.mt5_ticket) && Number(row.mt5_ticket) > 0 &&
    finite(row.volume) && row.volume >= 0 &&
    finite(row.current_price) && row.current_price >= 0 &&
    finite(row.unrealized_pl) &&
    (row.sl === null || finite(row.sl)) &&
    (row.tp === null || finite(row.tp));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const auth = await authenticateTerminal(req, admin, "id");
  if (auth.error) {
    const status = auth.error === "missing_api_key" || auth.error === "invalid_api_key" ? 401 : 500;
    return reply({ error: auth.error, detail: auth.detail }, status);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return reply({ error: "invalid_json_body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return reply({ error: "invalid_position_state" }, 400);
  }
  const positions = (body as Record<string, unknown>).positions;
  if (!Array.isArray(positions) || positions.length > 100 || !positions.every(validPosition)) {
    return reply({ error: "invalid_position_state" }, 400);
  }

  const { error } = await admin.rpc("broadcast_private_position_state", {
    p_terminal_id: auth.terminal!.id,
    p_payload: { positions },
  });
  if (error) return reply({ error: "broadcast_failed", detail: error.message }, 500);
  return reply({ accepted: true });
});
