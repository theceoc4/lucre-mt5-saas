// Returns connection details for a terminal's high-entropy Realtime topic.
// The public topic carries empty command wake-up hints and private-stream lease
// requests only. Mark-to-market state is relayed separately to an owner-only
// private topic; commands and durable position state remain protected by ea-sync.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { authenticateTerminal } from "./_shared/auth.ts";

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const auth = await authenticateTerminal(req, admin, "id, realtime_topic_id");
  if (auth.error) {
    const status = auth.error === "missing_api_key" || auth.error === "invalid_api_key" ? 401 : 500;
    return reply({ error: auth.error, detail: auth.detail }, status);
  }

  const topicId = auth.terminal!.realtime_topic_id as string;
  return reply({
    apikey: anonKey,
    topic: `terminal:${topicId}`,
    realtime_url: `${url.replace(/^http/u, "ws")}/realtime/v1/websocket`,
  });
});
