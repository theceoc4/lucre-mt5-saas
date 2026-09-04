type ContextInput = { terminalId: string; symbol: string; at: Date; origin: string; strategyName?: string | null; riskDefined?: boolean };
// Edge Functions use an ungenerated Supabase schema, so pinning this helper to
// createClient's default `unknown` database generic makes every selected row
// resolve to `never` with newer supabase-js releases. Keep the shared helper
// client-agnostic until generated Database types are introduced project-wide.
// deno-lint-ignore no-explicit-any
type SupabaseAdminClient = any;

function sessionFor(at: Date): "asia" | "london" | "ny" | "overlap" {
  const hour = at.getUTCHours();
  if (hour < 7 || hour >= 21) return "asia";
  if (hour < 12) return "london";
  if (hour < 16) return "overlap";
  return "ny";
}

// Kept intentionally deterministic and versioned. It gives manual/direct
// orders a consistent regime tag while price bars warm up; 'unknown' is never
// masqueraded as a strategy-grade trending/ranging observation.
async function regimeFor(admin: SupabaseAdminClient, terminalId: string, symbol: string) {
  const { data } = await admin.from("price_bars").select("close")
    .eq("terminal_id", terminalId).eq("symbol", symbol).eq("timeframe", "M5")
    .order("bar_time", { ascending: false }).limit(30);
  const closes: number[] = ((data ?? []) as Array<{ close: unknown }>)
    .map((bar) => Number(bar.close)).filter(Number.isFinite);
  if (closes.length < 20) return { regime: null, quality: "missing_market_data" };
  const latest = closes[0];
  const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
  const deviation = Math.sqrt(closes.reduce((a, b) => a + (b - mean) ** 2, 0) / closes.length);
  return { regime: deviation > 0 && Math.abs(latest - mean) / deviation >= 0.75 ? "trending" : "ranging", quality: "estimated" };
}

export async function captureMarketContext(admin: SupabaseAdminClient, input: ContextInput) {
  const session = sessionFor(input.at);
  const { regime, quality } = await regimeFor(admin, input.terminalId, input.symbol);
  const from = new Date(input.at.getTime() - 30 * 60_000).toISOString();
  const to = new Date(input.at.getTime() + 30 * 60_000).toISOString();
  const { data: events } = await admin.from("calendar_events")
    .select("id,title,currency,impact,event_time")
    .in("impact", ["medium", "high"]).gte("event_time", from).lte("event_time", to)
    .order("event_time", { ascending: true }).limit(1);
  const event = events?.[0] ?? null;
  return {
    session,
    htf_regime: regime,
    near_news_event: Boolean(event),
    news_event_id: event?.id ?? null,
    context: {
      version: 1,
      captured_at: input.at.toISOString(),
      origin: input.origin,
      strategy_name_at_entry: input.strategyName ?? "Discretionary manual",
      session_definition: "utc-v1",
      regime_model: "m5-zscore-v1",
      regime_quality: quality,
      news: event ? { id: event.id, title: event.title, currency: event.currency, impact: event.impact, event_time: event.event_time, minutes_from_entry: Math.round((new Date(event.event_time).getTime() - input.at.getTime()) / 60_000) } : null,
      risk_defined: Boolean(input.riskDefined),
    },
  };
}
