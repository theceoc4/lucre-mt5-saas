import { createClient } from "jsr:@supabase/supabase-js@2";

const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) || null : null;
const validTimezone = (value: unknown) => {
  const timezone = text(value, 100);
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return null;
  }
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers });
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  const auth = req.headers.get("Authorization");
  if (!auth) return reply({ error: "missing_authorization" }, 401);
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const userClient = createClient(url, anon, { global: { headers: { Authorization: auth } } });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) return reply({ error: "invalid_session" }, 401);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply({ error: "invalid_json" }, 400); }
  const admin = createClient(url, service);
  const userId = userData.user.id;

  if (body.action === "update_profile") {
    const { error } = await admin.from("profiles").update({
      display_name: text(body.display_name, 80), bio: text(body.bio, 500), location: text(body.location, 100),
      website: text(body.website, 300), trading_style: text(body.trading_style, 100),
    }).eq("id", userId);
    if (error) return reply({ error: "profile_update_failed", detail: error.message }, 500);
    return reply({ ok: true });
  }
  if (body.action === "update_timezone") {
    const timezone = validTimezone(body.timezone);
    if (!timezone) return reply({ error: "invalid_timezone" }, 422);
    const { error } = await admin.from("profiles").update({ timezone }).eq("id", userId);
    if (error) return reply({ error: "timezone_update_failed", detail: error.message }, 500);
    return reply({ ok: true, timezone });
  }
  if (body.action === "reset_account_data") {
    if (body.confirmation !== "RESET MY DATA") return reply({ error: "confirmation_required" }, 422);
    // Terminals are the ownership root for trading data. Their foreign-key
    // cascades remove commands, positions, trades, strategies, signals,
    // policies, bars and imported MT5 history, leaving login/profile intact.
    const { error } = await admin.from("mt5_terminals").delete().eq("user_id", userId);
    if (error) return reply({ error: "reset_failed", detail: error.message }, 500);
    return reply({ ok: true, message: "Account trading data reset." });
  }
  if (body.action === "delete_account") {
    if (body.confirmation !== "DELETE MY ACCOUNT") return reply({ error: "confirmation_required" }, 422);
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) return reply({ error: "account_delete_failed", detail: error.message }, 500);
    return reply({ ok: true });
  }
  return reply({ error: "invalid_action" }, 400);
});
