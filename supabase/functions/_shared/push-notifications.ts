import webpush from "npm:web-push@3.6.7";

declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

type SupabaseAdmin = {
  from: (table: string) => any;
};

type PushEvent = {
  id: string;
  user_id: string;
  title: string;
  body: string;
  event_type: string;
  data: Record<string, unknown>;
  attempts: number;
};

function vapidConfigured(): boolean {
  return Boolean(
    Deno.env.get("VAPID_PUBLIC_KEY") &&
    Deno.env.get("VAPID_PRIVATE_KEY") &&
    Deno.env.get("VAPID_SUBJECT"),
  );
}

export async function dispatchPendingPushNotifications(
  admin: SupabaseAdmin,
  userIds?: string[],
): Promise<{ sent: number; failed: number; disabled: number }> {
  if (!vapidConfigured()) {
    console.warn("push-notifications: VAPID secrets are not configured");
    return { sent: 0, failed: 0, disabled: 0 };
  }

  webpush.setVapidDetails(
    Deno.env.get("VAPID_SUBJECT")!,
    Deno.env.get("VAPID_PUBLIC_KEY")!,
    Deno.env.get("VAPID_PRIVATE_KEY")!,
  );

  let query = admin.from("push_notification_events")
    .select("id,user_id,title,body,event_type,data,attempts")
    .in("status", ["pending", "failed"])
    .lte("next_attempt_at", new Date().toISOString())
    .lt("attempts", 5)
    .order("created_at", { ascending: true })
    .limit(50);
  if (userIds?.length) query = query.in("user_id", [...new Set(userIds)]);
  const { data: events, error } = await query;
  if (error) {
    console.error("push-notifications: outbox fetch failed", error.message);
    return { sent: 0, failed: 1, disabled: 0 };
  }

  let sent = 0;
  let failed = 0;
  let disabled = 0;
  for (const event of (events ?? []) as PushEvent[]) {
    const { data: claimed } = await admin.from("push_notification_events")
      .update({ status: "sending", attempts: event.attempts + 1, last_error: null })
      .eq("id", event.id)
      .in("status", ["pending", "failed"])
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    const { data: subscriptions, error: subscriptionsError } = await admin
      .from("push_subscriptions")
      .select("id,endpoint,p256dh,auth")
      .eq("user_id", event.user_id);
    if (subscriptionsError || !subscriptions?.length) {
      await admin.from("push_notification_events").update({
        status: "failed",
        last_error: subscriptionsError?.message ?? "no_active_subscriptions",
        next_attempt_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      }).eq("id", event.id);
      failed++;
      continue;
    }

    let delivered = false;
    const errors: string[] = [];
    for (const subscription of subscriptions) {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify({
            title: event.title,
            body: event.body,
            tag: `${event.event_type}:${event.id}`,
            data: event.data,
          }),
          { TTL: 120, urgency: event.event_type === "terminal_disconnected" ? "high" : "normal" },
        );
        delivered = true;
      } catch (sendError) {
        const statusCode = Number((sendError as { statusCode?: number }).statusCode ?? 0);
        errors.push(`${statusCode || "send"}:${sendError instanceof Error ? sendError.message : String(sendError)}`);
        if (statusCode === 404 || statusCode === 410) {
          await admin.from("push_subscriptions").delete().eq("id", subscription.id);
          disabled++;
        }
      }
    }

    if (delivered) {
      await admin.from("push_notification_events").update({
        status: "sent", sent_at: new Date().toISOString(), last_error: errors.length ? errors.join(" | ").slice(0, 1000) : null,
      }).eq("id", event.id);
      sent++;
    } else {
      const delayMinutes = Math.min(30, 2 ** Math.max(0, event.attempts));
      await admin.from("push_notification_events").update({
        status: "failed",
        last_error: errors.join(" | ").slice(0, 1000) || "delivery_failed",
        next_attempt_at: new Date(Date.now() + delayMinutes * 60_000).toISOString(),
      }).eq("id", event.id);
      failed++;
    }
  }
  return { sent, failed, disabled };
}

export function dispatchPushInBackground(admin: SupabaseAdmin, userIds?: string[]): void {
  const task = dispatchPendingPushNotifications(admin, userIds).catch((error) => {
    console.error("push-notifications: background dispatch failed", error);
  });
  // Supabase keeps the isolate alive while the push provider responds without
  // adding that network round trip to the EA's trading/sync response.
  EdgeRuntime.waitUntil(task);
}
