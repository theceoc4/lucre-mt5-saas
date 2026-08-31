// v1.0.8 — calendar-sync
//
// Ingests economic calendar data pushed by the MT5 EA, which reads it from
// MetaTrader's own native Economic Calendar API (CalendarValueHistory /
// CalendarValueLast — see mt5_ea/CalendarSync.mqh in this repo). There is no
// public HTTP endpoint for MT5's calendar; it only exists inside a running
// terminal/EA process, so the EA itself is the ingestion worker and this
// function is its landing point — exactly the same shape as ea-sync
// (v1.0.0), reusing the same x-api-key terminal-auth model rather than a
// second credential type.
//
// Any one authenticated terminal may push a calendar snapshot: the
// underlying MetaQuotes calendar feed is not broker- or account-specific,
// so this is global reference data (same as calendar_events always was),
// not scoped to the pushing terminal. All writes go through the
// service-role-only public.ingest_calendar_events() RPC (migration 028),
// which validates and upserts each event individually — one malformed row
// never fails the whole batch.
//
// Request body:
// {
//   events: [{
//     mql5_value_id: number,       // required — MqlCalendarValue.id, the
//                                   // idempotency key for this occurrence
//     mql5_event_id?: number,      // MqlCalendarEvent.id (event definition)
//     event_time: string,          // required, ISO 8601
//     country?: string,
//     currency?: string,           // 3-letter ISO, omit/null for a
//                                   // currency-less event (e.g. holiday)
//     impact?: 'low'|'medium'|'high',   // either this...
//     importance?: number,              // ...or the raw MQL5
//                                        // CALENDAR_IMPORTANCE (0-3) —
//                                        // mapped to impact server-side
//     title: string,                // required
//     forecast?: number | null,
//     previous?: number | null,
//     actual?: number | null,
//     higher_is_bullish?: boolean | null,
//   }]
// }
//
// Response: { inserted, updated, skipped: [{ index, reason }] }

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Hard ceiling on events-per-request. MT5's calendar window used by the EA
// (see mt5_ea/CalendarSync.mqh, default -1/+14 days) realistically returns
// low hundreds of rows even across every country; this is a defensive cap
// against a misconfigured EA sending an unbounded window, not a normal
// operating limit.
const MAX_EVENTS_PER_REQUEST = 2000;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// MQL5 ENUM_CALENDAR_EVENT_IMPORTANCE: NONE=0, LOW=1, MODERATE=2, HIGH=3.
// NONE and LOW both collapse to our 'low' tier — there is no "no impact"
// bucket in calendar_events.impact (migration 006 check constraint).
function importanceToImpact(importance: number): "low" | "medium" | "high" | null {
  if (importance === 3) return "high";
  if (importance === 2) return "medium";
  if (importance === 0 || importance === 1) return "low";
  return null;
}

interface IncomingEvent {
  mql5_value_id?: number;
  mql5_event_id?: number;
  event_time?: string;
  country?: string | null;
  currency?: string | null;
  impact?: string;
  importance?: number;
  title?: string;
  forecast?: number | null;
  previous?: number | null;
  actual?: number | null;
  higher_is_bullish?: boolean | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  const apiKey = req.headers.get("x-api-key");
  if (!apiKey) return jsonResponse({ error: "missing_api_key" }, 401);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Same terminal-key auth as ea-sync: any registered terminal may push a
  // calendar snapshot (this is global reference data, not terminal-scoped).
  const keyHash = await sha256Hex(apiKey);
  const { data: terminal, error: terminalError } = await admin
    .from("mt5_terminals")
    .select("id")
    .eq("api_key_hash", keyHash)
    .maybeSingle();

  if (terminalError) return jsonResponse({ error: "lookup_failed", detail: terminalError.message }, 500);
  if (!terminal) return jsonResponse({ error: "invalid_api_key" }, 401);

  let body: { events?: IncomingEvent[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json_body" }, 400);
  }

  if (!Array.isArray(body.events)) {
    return jsonResponse({ error: "events_must_be_array" }, 400);
  }
  if (body.events.length === 0) {
    return jsonResponse({ inserted: 0, updated: 0, skipped: [] });
  }
  if (body.events.length > MAX_EVENTS_PER_REQUEST) {
    return jsonResponse(
      { error: "too_many_events", max: MAX_EVENTS_PER_REQUEST, received: body.events.length },
      400,
    );
  }

  // Resolve impact from either field before handing off to the RPC, which
  // only understands the string form. Rows with neither impact nor a
  // resolvable importance are passed through with impact omitted so the
  // RPC's own validation (and its per-row skip reporting) is the single
  // source of truth for "invalid" — this function doesn't duplicate that
  // logic, it just does the enum translation the RPC has no reason to know.
  const preparedEvents = body.events.map((e) => {
    let impact = e.impact;
    if (!impact && typeof e.importance === "number") {
      impact = importanceToImpact(e.importance) ?? undefined;
    }
    return {
      mql5_value_id: e.mql5_value_id,
      mql5_event_id: e.mql5_event_id ?? null,
      event_time: e.event_time,
      country: e.country ?? null,
      currency: e.currency ?? null,
      impact: impact ?? null,
      title: e.title,
      forecast: e.forecast ?? null,
      previous: e.previous ?? null,
      actual: e.actual ?? null,
      higher_is_bullish: e.higher_is_bullish ?? null,
    };
  });

  const { data: result, error: ingestError } = await admin.rpc("ingest_calendar_events", {
    p_events: preparedEvents,
  });

  if (ingestError) {
    return jsonResponse({ error: "ingest_failed", detail: ingestError.message }, 500);
  }

  const validTimes = preparedEvents.map((event) => event.event_time).filter(Boolean).map((value) => new Date(String(value)))
    .filter((value) => !Number.isNaN(value.getTime()));
  const actualTimes = preparedEvents.filter((event) => event.actual != null && event.event_time).map((event) => new Date(String(event.event_time)))
    .filter((value) => !Number.isNaN(value.getTime()));
  await admin.from("market_feed_health").upsert({
    feed_name: "economic_calendar", last_received_at: new Date().toISOString(),
    last_event_time: validTimes.length ? new Date(Math.max(...validTimes.map((value) => value.getTime()))).toISOString() : null,
    last_actual_release_at: actualTimes.length ? new Date(Math.max(...actualTimes.map((value) => value.getTime()))).toISOString() : null,
    last_source_terminal_id: terminal.id, rows_received: preparedEvents.length, updated_at: new Date().toISOString(),
  }, { onConflict: "feed_name" });

  return jsonResponse(result);
});
