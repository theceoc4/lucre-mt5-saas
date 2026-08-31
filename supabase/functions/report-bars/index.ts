// v1.0.30 — report-bars
//
// The MT5 EA posts newly closed bars for selected symbol/timeframe series.
// This function reverse-resolves each broker-native spelling to the terminal's
// canonical symbol before inserting price_bars, so strategy definitions and
// indicator calculations stay broker-independent.
//
// This function is EA-key authenticated (x-api-key -> api_key_hash) and must
// be deployed with verify_jwt:false, like ea-sync/report-symbols. That deploy
// setting lives outside this source file.
//
// Request:  { symbols: [{ broker_symbol, timeframe, source_digits, bars: [...] }] }
// Response: { upserted, warnings }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { authenticateTerminal } from "./_shared/auth.ts";
import {
  advanceTrendIndicatorState,
  computeCompositeTrend,
  initializeTrendIndicatorState,
  TREND_BAR_LIMIT,
  TREND_MODEL_VERSION,
  TREND_TIMEFRAME_WEIGHTS,
  type TrendIndicatorState,
  type TimeframeTrend,
  type TrendBar,
} from "./_shared/trend-strength.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_SERIES_PER_REQUEST = 400; // 50 symbols x 8 timeframes
const MAX_BARS_PER_SYMBOL = 1000;
const MAX_BARS_PER_REQUEST = 2200;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

interface IncomingBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  spread?: number;
  real_volume?: number;
}

interface IncomingSymbolBars {
  broker_symbol: string;
  timeframe?: string; // omitted by pre-v1.0.22 EAs, meaning M5
  source_digits?: number;
  bars: IncomingBar[];
}

async function updateTrendStates(
  // deno-lint-ignore no-explicit-any
  admin: any,
  terminalId: string,
  rows: Array<{ symbol: string; timeframe: string; bar_time: string; open: number; high: number; low: number; close: number; volume: number }>,
): Promise<{ updated: number; warnings: string[] }> {
  const uniqueSeries = [...new Map(rows
    .filter((row) => row.timeframe in TREND_TIMEFRAME_WEIGHTS)
    .map((row) => [`${row.symbol}:${row.timeframe}`, row])).values()];
  if (uniqueSeries.length === 0) return { updated: 0, warnings: [] };

  const symbols = [...new Set(uniqueSeries.map((series) => series.symbol))];
  const { data: calculationRows, error: calculationError } = await admin
    .from("symbol_trend_calculation_state")
    .select("symbol,timeframe,indicator_state,timeframe_result,model_version")
    .eq("terminal_id", terminalId)
    .in("symbol", symbols);
  if (calculationError) {
    return { updated: 0, warnings: [`Trend calculation-state lookup failed: ${calculationError.message}`] };
  }

  const calculations = new Map<string, { indicator?: TrendIndicatorState; result?: TimeframeTrend; version?: string }>();
  const nextBySymbol = new Map<string, Record<string, TimeframeTrend>>();
  for (const row of calculationRows ?? []) {
    const symbol = String(row.symbol);
    const timeframe = String(row.timeframe);
    calculations.set(`${symbol}:${timeframe}`, {
      indicator: row.indicator_state as TrendIndicatorState,
      result: row.timeframe_result as TimeframeTrend,
      version: String(row.model_version),
    });
    if (row.timeframe_result) {
      if (!nextBySymbol.has(symbol)) nextBySymbol.set(symbol, {});
      nextBySymbol.get(symbol)![timeframe] = row.timeframe_result as TimeframeTrend;
    }
  }

  const warnings: string[] = [];
  const calculationUpserts: Record<string, unknown>[] = [];
  for (const { symbol, timeframe } of uniqueSeries) {
    const key = `${symbol}:${timeframe}`;
    const prior = calculations.get(key);
    const incomingBars: TrendBar[] = rows.filter((row) => row.symbol === symbol && row.timeframe === timeframe)
      .map((row) => ({
        bar_time: row.bar_time, open: row.open, high: row.high, low: row.low,
        close: row.close, volume: row.volume,
      }));
    let computed = prior?.version === TREND_MODEL_VERSION && prior.indicator
      ? advanceTrendIndicatorState(timeframe, prior.indicator, incomingBars, prior.result?.regime)
      : null;

    // A series is warmed once (or after a model version change), then every
    // later update advances solely from the candle(s) in the EA request.
    if (!computed) {
      const { data, error } = await admin.from("price_bars")
        .select("bar_time,open,high,low,close,volume")
        .eq("terminal_id", terminalId).eq("symbol", symbol).eq("timeframe", timeframe)
        .order("bar_time", { ascending: false }).limit(TREND_BAR_LIMIT);
      if (error) {
        warnings.push(`${symbol} ${timeframe} trend warmup failed: ${error.message}`);
        continue;
      }
      const history: TrendBar[] = [...(data ?? [])].reverse().map((bar) => ({
        bar_time: String(bar.bar_time), open: Number(bar.open), high: Number(bar.high),
        low: Number(bar.low), close: Number(bar.close), volume: Number(bar.volume),
      }));
      computed = initializeTrendIndicatorState(timeframe, history, prior?.result?.regime);
    }
    if (!computed) continue; // fewer than 60 closed candles: still warming up
    if (!nextBySymbol.has(symbol)) nextBySymbol.set(symbol, {});
    nextBySymbol.get(symbol)![timeframe] = computed.result;
    calculationUpserts.push({
      terminal_id: terminalId, symbol, timeframe,
      indicator_state: computed.indicatorState,
      timeframe_result: computed.result,
      source_bar_time: computed.result.source_bar_time,
      model_version: TREND_MODEL_VERSION,
      updated_at: new Date().toISOString(),
    });
  }

  if (calculationUpserts.length > 0) {
    const { error } = await admin.from("symbol_trend_calculation_state")
      .upsert(calculationUpserts, { onConflict: "terminal_id,symbol,timeframe" });
    if (error) warnings.push(`Trend calculation-state upsert failed: ${error.message}`);
  }

  const now = new Date().toISOString();
  const payload = symbols.map((symbol) => {
    const timeframeScores = nextBySymbol.get(symbol) ?? {};
    const composite = computeCompositeTrend(timeframeScores);
    return {
      terminal_id: terminalId,
      symbol,
      score: composite.score,
      direction: composite.direction,
      strength: composite.strength,
      confidence: composite.confidence,
      regime: composite.regime,
      timeframe_scores: timeframeScores,
      components: composite.components,
      source_bar_times: composite.source_bar_times,
      source_bar_time: composite.source_bar_time,
      model_version: TREND_MODEL_VERSION,
      computed_at: now,
    };
  });
  const { error: upsertError } = await admin
    .from("symbol_trend_state")
    .upsert(payload, { onConflict: "terminal_id,symbol" });
  if (upsertError) warnings.push(`Trend state upsert failed: ${upsertError.message}`);
  if (!upsertError) {
    const historyRows = payload.filter((row) => row.source_bar_time).map((row) => ({
      terminal_id: row.terminal_id, symbol: row.symbol, source_bar_time: row.source_bar_time,
      score: row.score, confidence: row.confidence, regime: row.regime,
      timeframe_scores: row.timeframe_scores, model_version: row.model_version, computed_at: row.computed_at,
    }));
    if (historyRows.length > 0) {
      const { error: historyError } = await admin.from("symbol_trend_history")
        .upsert(historyRows, { onConflict: "terminal_id,symbol,source_bar_time" });
      if (historyError) warnings.push(`Trend history upsert failed: ${historyError.message}`);
    }
  }
  return { updated: upsertError ? 0 : payload.length, warnings };
}

const SUPPORTED_TIMEFRAMES = new Set(["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const auth = await authenticateTerminal(req, admin, "id");
  if (auth.error) {
    const status = auth.error === "missing_api_key" || auth.error === "invalid_api_key" ? 401 : 500;
    return jsonResponse({ error: auth.error, detail: auth.detail }, status);
  }
  const terminal = auth.terminal!;

  let body: { symbols?: IncomingSymbolBars[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json_body" }, 400);
  }

  if (!Array.isArray(body.symbols)) return jsonResponse({ error: "missing_symbols_array" }, 400);
  if (body.symbols.length > MAX_SERIES_PER_REQUEST) {
    return jsonResponse({ error: "too_many_series", max: MAX_SERIES_PER_REQUEST }, 413);
  }

  for (const symbolPayload of body.symbols) {
    if (!symbolPayload || typeof symbolPayload.broker_symbol !== "string" || !Array.isArray(symbolPayload.bars)) {
      return jsonResponse({ error: "invalid_symbol_payload" }, 400);
    }
    if (symbolPayload.bars.length > MAX_BARS_PER_SYMBOL) {
      return jsonResponse({
        error: "too_many_bars_for_symbol",
        broker_symbol: symbolPayload.broker_symbol,
        max: MAX_BARS_PER_SYMBOL,
      }, 413);
    }
    const timeframe = symbolPayload.timeframe ?? "M5";
    if (!SUPPORTED_TIMEFRAMES.has(timeframe)) {
      return jsonResponse({ error: "unsupported_timeframe", timeframe }, 400);
    }
  }
  const requestedBarCount = body.symbols.reduce((total, series) => total + series.bars.length, 0);
  if (requestedBarCount > MAX_BARS_PER_REQUEST) {
    return jsonResponse({ error: "too_many_bars", max: MAX_BARS_PER_REQUEST }, 413);
  }

  const warnings: string[] = [];
  const brokerSymbols = [...new Set(body.symbols.map((s) => s.broker_symbol).filter((s) => s.length > 0))];
  if (brokerSymbols.length === 0) return jsonResponse({ upserted: 0, warnings });

  const { data: mappingRows, error: mappingsError } = await admin
    .from("symbol_mappings")
    .select("canonical_symbol, broker_symbol")
    .eq("terminal_id", terminal.id)
    .in("broker_symbol", brokerSymbols)
    .not("broker_symbol", "is", null)
    .neq("match_type", "unavailable");

  if (mappingsError) return jsonResponse({ error: "mapping_lookup_failed", detail: mappingsError.message }, 500);

  const canonicalByBroker = new Map<string, string>();
  for (const mapping of mappingRows ?? []) {
    // A terminal should not map two canonicals to one broker symbol; keeping the
    // first row is safer than rejecting the entire small, frequent EA payload.
    if (!canonicalByBroker.has(mapping.broker_symbol)) {
      canonicalByBroker.set(mapping.broker_symbol, mapping.canonical_symbol);
    }
  }

  const rows: Array<{
    terminal_id: string;
    symbol: string;
    timeframe: string;
    bar_time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    source_digits: number | null;
    spread: number | null;
    real_volume: number | null;
  }> = [];

  for (const symbolPayload of body.symbols) {
    const canonicalSymbol = canonicalByBroker.get(symbolPayload.broker_symbol);
    if (!canonicalSymbol) {
      warnings.push(`No canonical mapping for broker symbol ${symbolPayload.broker_symbol}; skipped.`);
      continue;
    }

    const timeframe = symbolPayload.timeframe ?? "M5";
    const sourceDigits = Number.isInteger(symbolPayload.source_digits) &&
        Number(symbolPayload.source_digits) >= 0 && Number(symbolPayload.source_digits) <= 12
      ? Number(symbolPayload.source_digits)
      : null;

    for (const bar of symbolPayload.bars) {
      const barTime = typeof bar?.time === "string" ? new Date(bar.time) : null;
      if (!barTime || Number.isNaN(barTime.getTime())) {
        warnings.push(`Invalid bar time for ${symbolPayload.broker_symbol}; bar skipped.`);
        continue;
      }
      if (![bar.open, bar.high, bar.low, bar.close, bar.volume].every(isFiniteNumber)) {
        warnings.push(`Non-numeric OHLCV value for ${symbolPayload.broker_symbol} at ${bar.time}; bar skipped.`);
        continue;
      }
      if (bar.high < bar.low || bar.volume < 0) {
        warnings.push(`Invalid range or volume for ${symbolPayload.broker_symbol} at ${bar.time}; bar skipped.`);
        continue;
      }

      rows.push({
        terminal_id: terminal.id,
        symbol: canonicalSymbol,
        timeframe,
        bar_time: barTime.toISOString(),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        source_digits: sourceDigits,
        spread: Number.isInteger(bar.spread) && Number(bar.spread) >= 0 ? Number(bar.spread) : null,
        real_volume: isFiniteNumber(bar.real_volume) && Number(bar.real_volume) >= 0 ? Number(bar.real_volume) : null,
      });
    }
  }

  if (rows.length === 0) return jsonResponse({ upserted: 0, warnings });

  const { error: upsertError } = await admin
    .from("price_bars")
    .upsert(rows, {
      onConflict: "terminal_id,symbol,timeframe,bar_time",
      ignoreDuplicates: true,
    });

  if (upsertError) return jsonResponse({ error: "upsert_failed", detail: upsertError.message }, 500);

  // Reuse this authenticated minute-level ingestion request instead of adding
  // a cron sweep or browser poll. Only affected series are recalculated, then
  // one compact current-state row is upserted per affected symbol.
  EdgeRuntime.waitUntil(
    updateTrendStates(admin, terminal.id, rows).then((result) => {
      if (result.warnings.length) console.warn("Trend update warnings", result.warnings);
    }).catch((error) => console.error("Trend update failed", error)),
  );
  return jsonResponse({ upserted: rows.length, trend_update_scheduled: true, warnings });
});
