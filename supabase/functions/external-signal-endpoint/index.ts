// v1.0.49 -- Owner-only lifecycle management for external strategy endpoints.
// Plaintext webhook tokens are returned only when created or rotated.

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
function randomToken(prefix: string, bytes = 24): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return `${prefix}_${
    [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return respond({ error: "method_not_allowed" }, 405);
  }
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return respond({ error: "missing_authorization" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData } = await caller.auth.getUser();
  if (!userData?.user) return respond({ error: "invalid_session" }, 401);
  const admin = createClient(supabaseUrl, serviceKey);

  let body: {
    action?: "create" | "rotate" | "disable" | "enable";
    strategy_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return respond({ error: "invalid_json_body" }, 400);
  }
  if (!body.strategy_id) return respond({ error: "strategy_id_required" }, 400);
  const { data: strategy } = await admin.from("strategies")
    .select("id,terminal_id,signal_source,mt5_terminals!inner(user_id)")
    .eq("id", body.strategy_id).maybeSingle();
  if (!strategy) return respond({ error: "strategy_not_found" }, 404);
  const ownerId = (strategy.mt5_terminals as { user_id?: string } | null)
    ?.user_id;
  if (ownerId !== userData.user.id) return respond({ error: "forbidden" }, 403);
  if (
    !["tradingview", "generic_webhook", "mt5_indicator"].includes(
      strategy.signal_source,
    )
  ) {
    return respond({ error: "strategy_is_not_external" }, 409);
  }

  const action = body.action ?? "create";
  if (action === "disable" || action === "enable") {
    const { data, error } = await admin.from("external_signal_endpoints")
      .update({ enabled: action === "enable" }).eq("strategy_id", strategy.id)
      .select(
        "id,public_id,provider,enabled,token_last_four,last_received_at,last_accepted_at,last_status,rotated_at",
      ).single();
    if (error) return respond({ error: "endpoint_update_failed" }, 500);
    return respond({ endpoint: data });
  }

  const token = randomToken("lhook", 32);
  const publicId = randomToken("hook", 10);
  const tokenHash = await sha256Hex(token);
  const row = {
    public_id: publicId,
    terminal_id: strategy.terminal_id,
    strategy_id: strategy.id,
    provider: strategy.signal_source,
    token_hash: tokenHash,
    token_last_four: token.slice(-4),
    enabled: true,
    rotated_at: new Date().toISOString(),
  };
  const { data, error } = await admin.from("external_signal_endpoints")
    .upsert(row, { onConflict: "strategy_id" })
    .select(
      "id,public_id,provider,enabled,token_last_four,last_received_at,last_accepted_at,last_status,rotated_at",
    ).single();
  if (error) {
    return respond(
      { error: "endpoint_save_failed", detail: error.message },
      500,
    );
  }
  const webhookUrl = `${supabaseUrl}/functions/v1/external-signal/${token}`;
  return respond({
    endpoint: data,
    webhook_url: webhookUrl,
    token_shown_once: true,
  });
});
