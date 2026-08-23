// v1.0.12 — ea-stream
//
// Optional low-latency companion to ea-sync. The EA opens a WebSocket here
// (EAStream.mqh) and authenticates the same way as every other EA-facing
// function: x-api-key header -> SHA-256 -> mt5_terminals.api_key_hash.
//
// Purpose: ea-sync's 1-2s poll interval is fine for most flows but adds up
// to 1-2s of pure queueing latency for a manual/scalping order before the EA
// even sees it exist. Rather than shortening the poll interval globally
// (more load, still bounded by round-trip time), this function acts as a
// Supabase Realtime CLIENT (service role, from inside the edge function --
// not a browser subscribing directly) listening for postgres_changes INSERT
// events on ea_commands filtered to this terminal_id. The moment a new
// command is inserted, this function pushes a tiny "wake" text frame down
// the EA's socket. EAStream.mqh treats "wake" purely as a hint to call
// EASync_Run() immediately instead of waiting for its next timer tick --
// polling stays the single source of truth for what commands actually exist
// and what their status is. If this socket is down, disconnected, or never
// connects at all, nothing breaks: ea-sync's normal poll cadence is the
// fallback and remains fully authoritative.
//
// This is deliberately a hint channel, not a delivery channel: it never
// carries command payloads itself, so a dropped or garbled frame here has
// zero correctness impact, only a latency impact bounded by the existing
// poll interval.
//
// Edge function WebSocket workers on Supabase recycle roughly every 5-7
// minutes; EAStream.mqh reconnects with exponential backoff (2s -> 60s cap)
// whenever the socket closes, so brief gaps during recycling are expected
// and harmless given the polling fallback.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { authenticateTerminal } from "./_shared/auth.ts";

Deno.serve(async (req: Request) => {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket upgrade", { status: 400 });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    realtime: { params: { eventsPerSecond: 5 } },
  });

  const auth = await authenticateTerminal(req, admin, "id");
  if (auth.error) {
    const status = auth.error === "missing_api_key" || auth.error === "invalid_api_key" ? 401 : 500;
    return new Response(JSON.stringify({ error: auth.error }), { status });
  }
  const terminalId = auth.terminal!.id as string;

  const { socket, response } = Deno.upgradeWebSocket(req);

  let channel: ReturnType<typeof admin.channel> | null = null;
  let pingInterval: number | null = null;

  socket.onopen = () => {
    channel = admin
      .channel(`ea-stream-${terminalId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "ea_commands",
          filter: `terminal_id=eq.${terminalId}`,
        },
        () => {
          try {
            socket.send("wake");
          } catch {
            // Socket already closing; the reconnect/backoff loop in
            // EAStream.mqh will re-establish and resubscribe.
          }
        },
      )
      .subscribe();

    pingInterval = setInterval(() => {
      try {
        socket.send("ping");
      } catch {
        // no-op; onclose/onerror will handle cleanup.
      }
    }, 25_000);
  };

  socket.onmessage = (event) => {
    if (event.data === "ping") {
      try {
        socket.send("pong");
      } catch {
        // no-op
      }
    }
  };

  const cleanup = () => {
    if (pingInterval !== null) clearInterval(pingInterval);
    if (channel) admin.removeChannel(channel);
  };

  socket.onclose = cleanup;
  socket.onerror = cleanup;

  return response;
});
