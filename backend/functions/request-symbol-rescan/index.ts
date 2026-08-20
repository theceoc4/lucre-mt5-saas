// v1.0.12 — request-symbol-rescan
//
// Backs the dashboard's "Rescan Symbols" button. Dashboard-facing (Supabase
// JWT auth via the standard userClient.auth.getUser() pattern used by
// position-action/signal-action/manual-order), NOT the EA's x-api-key
// scheme.
//
// Just flips mt5_terminals.force_symbol_rescan to true after verifying the
// terminal belongs to the calling user. Kept as its own tiny edge function
// rather than a direct dashboard write so every ea_commands-adjacent write
// path goes through a function that can validate ownership and (later) add
// rate limiting — even though this particular flag isn't part of the
// trade-execution path itself.
//
// The EA picks the flag up on its very next ea-sync poll (piggybacked on
// the existing response payload) and clears it itself via report-symbols
// once the scan completes — no polling or webhook needed from this side.
//
// Request:  POST { terminal_id }
// Response: { status: "requested" }

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

  const { error: updateError } = await admin
    .from("mt5_terminals")
    .update({ force_symbol_rescan: true })
    .eq("id", terminal.id);

  if (updateError) return jsonResponse({ error: "update_failed", detail: updateError.message }, 500);

  return jsonResponse({ status: "requested" });
});
