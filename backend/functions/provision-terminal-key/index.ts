// v1.0.1 — provision-terminal-key
//
// Generates (or rotates) the plaintext API key an MT5 EA uses to authenticate to
// /ea-sync. The plaintext is returned exactly once in this response and never
// stored — only its SHA-256 hash is persisted, matching the design note in
// migration 003_mt5_terminals.sql ("key generation is handled by the edge
// function layer"). Caller must be the terminal's owning user (dashboard JWT).
//
// Request:  POST { terminal_id: string }
// Response: { terminal_id, api_key, api_key_last_four, rotated_at }

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

function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `mtk_live_${hex}`;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
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

  let body: { terminal_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json_body" }, 400);
  }
  if (!body.terminal_id) return jsonResponse({ error: "terminal_id_required" }, 400);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: terminal, error: terminalError } = await admin
    .from("mt5_terminals")
    .select("id, user_id")
    .eq("id", body.terminal_id)
    .maybeSingle();

  if (terminalError) return jsonResponse({ error: "lookup_failed", detail: terminalError.message }, 500);
  if (!terminal) return jsonResponse({ error: "terminal_not_found" }, 404);
  if (terminal.user_id !== userData.user.id) return jsonResponse({ error: "forbidden" }, 403);

  const plaintextKey = generateApiKey();
  const keyHash = await sha256Hex(plaintextKey);
  const lastFour = plaintextKey.slice(-4);
  const rotatedAt = new Date().toISOString();

  const { error: updateError } = await admin
    .from("mt5_terminals")
    .update({
      api_key_hash: keyHash,
      api_key_last_four: lastFour,
      api_key_last_rotated_at: rotatedAt,
    })
    .eq("id", body.terminal_id);

  if (updateError) return jsonResponse({ error: "update_failed", detail: updateError.message }, 500);

  return jsonResponse({
    terminal_id: body.terminal_id,
    api_key: plaintextKey,
    api_key_last_four: lastFour,
    rotated_at: rotatedAt,
  });
});
