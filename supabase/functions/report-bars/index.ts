// v1.0.43 — bounded snapshots plus broker-session collector evidence.
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
// Response: { accepted, series: [{ broker_symbol, timeframe, accepted_through }], warnings }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { authenticateTerminal } from "./_shared/auth.ts";
import {
  computeTrendStrengthV3,
  TREND_ANCHOR_TIMEFRAME,
  TREND_CONTEXT_TIMEFRAME,
  TREND_MODEL_VERSION,
  type TrendV3Bar,
} from "../_shared/trend-strength-v3.ts";
import { dispatchPushInBackground } from "../_shared/push-notifications.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_SERIES_PER_REQUEST = 400; // 50 symbols x 8 timeframes
const MAX_BARS_PER_SERIES = 1000;
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
  bootstrap_generation?: number;
  snapshot_complete?: boolean;
  bars: IncomingBar[];
}

interface IncomingCollectorDiagnostic {
  broker_symbol: string;
  timeframe: string;
  state: "idle" | "sync_requested" | "waiting_history" | "ready" |
    "awaiting_tick" | "upload_pending" | "uploading" | "retry_backoff" |
    "market_closed" | "error";
  source_latest_bar_time?: string;
  source_tick_time?: string;
  expected_bar_time?: string;
  last_error?: string;
  attempt_count?: number;
  retry_after_seconds?: number;
}

async function updateTrendStates(
  // deno-lint-ignore no-explicit-any
  admin: any,
  terminalId: string,
  rows: Array<{ symbol: string; timeframe: string; bar_time: string; open: number; high: number; low: number; close: number; volume: number; real_volume?: number | null }>,
): Promise<{ updated: number; warnings: string[] }> {
  // The meter is intentionally recalculated only when its M30 anchor or H1
  // context receives a newly closed candle. Faster charts no longer make the
  // day-trading score twitch, and slower charts no longer dilute it.
  const symbols = [...new Set(rows
    .filter((row) => row.timeframe === TREND_ANCHOR_TIMEFRAME || row.timeframe === TREND_CONTEXT_TIMEFRAME)
    .map((row) => row.symbol))];
  if (symbols.length === 0) return { updated: 0, warnings: [] };
  const warnings: string[] = [];
  const now = new Date().toISOString();
  const payload: Record<string, unknown>[] = [];
  const [{ data: windowRows, error: windowError }, { data: priorRows, error: priorError }] = await Promise.all([
    admin.rpc("get_trend_strength_bars", { p_terminal_id: terminalId, p_symbols: symbols }),
    admin.from("symbol_trend_state").select("symbol,regime").eq("terminal_id", terminalId).in("symbol", symbols),
  ]);
  if (windowError) return { updated: 0, warnings: [`Trend history window failed: ${windowError.message}`] };
  if (priorError) warnings.push(`Prior trend regime lookup failed: ${priorError.message}`);
  const barsBySeries = new Map<string, TrendV3Bar[]>();
  for (const bar of windowRows ?? []) {
    const key = `${bar.symbol}:${bar.timeframe}`;
    if (!barsBySeries.has(key)) barsBySeries.set(key, []);
    barsBySeries.get(key)!.push({
      bar_time: String(bar.bar_time), open: Number(bar.open), high: Number(bar.high), low: Number(bar.low),
      close: Number(bar.close), volume: Number(bar.volume), real_volume: bar.real_volume == null ? null : Number(bar.real_volume),
    });
  }
  const priorRegimeBySymbol = new Map((priorRows ?? []).map((row) => [String(row.symbol), String(row.regime)]));
  for (const symbol of symbols) {
    const anchorBars = barsBySeries.get(`${symbol}:${TREND_ANCHOR_TIMEFRAME}`) ?? [];
    const contextBars = barsBySeries.get(`${symbol}:${TREND_CONTEXT_TIMEFRAME}`) ?? [];
    const composite = computeTrendStrengthV3(anchorBars, contextBars, priorRegimeBySymbol.get(symbol));
    payload.push({
      terminal_id: terminalId,
      symbol,
      score: composite.score,
      direction: composite.direction,
      strength: composite.strength,
      confidence: composite.confidence,
      regime: composite.regime,
      timeframe_scores: composite.timeframe_scores,
      components: composite.components,
      source_bar_times: composite.source_bar_times,
      source_bar_time: composite.source_bar_time,
      model_version: TREND_MODEL_VERSION,
      computed_at: now,
    });
  }
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

  const auth = await authenticateTerminal(
    req,
    admin,
    "id,user_id,active_ea_instance_id,active_ea_instance_seen_at",
  );
  if (auth.error) {
    const status = auth.error === "missing_api_key" || auth.error === "invalid_api_key" ? 401 : 500;
    return jsonResponse({ error: auth.error, detail: auth.detail }, status);
  }
  const terminal = auth.terminal!;

  let body: {
    instance_id?: string;
    symbols?: IncomingSymbolBars[];
    diagnostics?: IncomingCollectorDiagnostic[];
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json_body" }, 400);
  }

  const activeInstanceId = typeof terminal.active_ea_instance_id === "string"
    ? terminal.active_ea_instance_id : "";
  const activeSeenMs = terminal.active_ea_instance_seen_at
    ? new Date(String(terminal.active_ea_instance_seen_at)).getTime() : 0;
  const activeLeaseFresh = Boolean(activeInstanceId) && Number.isFinite(activeSeenMs) &&
    Date.now() - activeSeenMs < 60_000;
  const reportingInstanceId = typeof body.instance_id === "string" ? body.instance_id.trim() : "";
  if (activeLeaseFresh && reportingInstanceId !== activeInstanceId) {
    return jsonResponse({ error: "ea_instance_standby" }, 409);
  }

  if (!Array.isArray(body.symbols)) return jsonResponse({ error: "missing_symbols_array" }, 400);
  if (body.diagnostics != null && !Array.isArray(body.diagnostics)) {
    return jsonResponse({ error: "invalid_diagnostics_array" }, 400);
  }
  if ((body.diagnostics?.length ?? 0) > MAX_SERIES_PER_REQUEST) {
    return jsonResponse({ error: "too_many_diagnostics", max: MAX_SERIES_PER_REQUEST }, 413);
  }
  if (body.symbols.length > MAX_SERIES_PER_REQUEST) {
    return jsonResponse({ error: "too_many_series", max: MAX_SERIES_PER_REQUEST }, 413);
  }

  for (const symbolPayload of body.symbols) {
    if (!symbolPayload || typeof symbolPayload.broker_symbol !== "string" || !Array.isArray(symbolPayload.bars)) {
      return jsonResponse({ error: "invalid_symbol_payload" }, 400);
    }
    if (symbolPayload.bars.length > MAX_BARS_PER_SERIES) {
      const timeframe = symbolPayload.timeframe ?? "M5";
      return jsonResponse({
        error: "too_many_bars_for_series",
        broker_symbol: symbolPayload.broker_symbol,
        timeframe,
        received: symbolPayload.bars.length,
        max: MAX_BARS_PER_SERIES,
      }, 413);
    }
    const timeframe = symbolPayload.timeframe ?? "M5";
    if (!SUPPORTED_TIMEFRAMES.has(timeframe)) {
      return jsonResponse({ error: "unsupported_timeframe", timeframe }, 400);
    }
  }
  for (const diagnostic of body.diagnostics ?? []) {
    if (!diagnostic || typeof diagnostic.broker_symbol !== "string" ||
      !SUPPORTED_TIMEFRAMES.has(diagnostic.timeframe)) {
      return jsonResponse({ error: "invalid_collector_diagnostic" }, 400);
    }
  }
  const requestedBarCount = body.symbols.reduce((total, series) => total + series.bars.length, 0);
  if (requestedBarCount > MAX_BARS_PER_REQUEST) {
    return jsonResponse({ error: "too_many_bars", max: MAX_BARS_PER_REQUEST }, 413);
  }

  const warnings: string[] = [];
  const brokerSymbols = [...new Set([
    ...body.symbols.map((s) => s.broker_symbol),
    ...(body.diagnostics ?? []).map((item) => item.broker_symbol),
  ].filter((s) => s.length > 0))];
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

  const collectorAttempts = (body.diagnostics ?? []).flatMap((diagnostic) => {
    const canonicalSymbol = canonicalByBroker.get(diagnostic.broker_symbol);
    if (!canonicalSymbol) {
      warnings.push(`No canonical mapping for diagnostic ${diagnostic.broker_symbol}; skipped.`);
      return [];
    }
    const sourceTime = diagnostic.source_latest_bar_time
      ? new Date(diagnostic.source_latest_bar_time) : null;
    const expectedTime = diagnostic.expected_bar_time
      ? new Date(diagnostic.expected_bar_time) : null;
    const sourceTickTime = diagnostic.source_tick_time
      ? new Date(diagnostic.source_tick_time) : null;
    return [{
      symbol: canonicalSymbol,
      timeframe: diagnostic.timeframe,
      state: diagnostic.state,
      source_latest_bar_time: sourceTime && !Number.isNaN(sourceTime.getTime())
        ? sourceTime.toISOString() : null,
      expected_bar_time: expectedTime && !Number.isNaN(expectedTime.getTime())
        ? expectedTime.toISOString() : null,
      source_tick_time: sourceTickTime && !Number.isNaN(sourceTickTime.getTime())
        ? sourceTickTime.toISOString() : null,
      last_error: diagnostic.last_error?.slice(0, 240) ?? null,
      attempt_count: Number.isInteger(diagnostic.attempt_count)
        ? Math.max(0, Number(diagnostic.attempt_count)) : 0,
      retry_after_seconds: Number.isInteger(diagnostic.retry_after_seconds)
        ? Math.max(0, Number(diagnostic.retry_after_seconds)) : 0,
    }];
  });
  if (collectorAttempts.length > 0) {
    const { error: diagnosticError } = await admin.rpc("record_price_feed_attempts", {
      p_terminal_id: terminal.id,
      p_attempts: collectorAttempts,
    });
    if (diagnosticError) {
      return jsonResponse({ error: "collector_diagnostic_failed", detail: diagnosticError.message }, 500);
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
  const ingestMetadata = new Map<string, { bootstrap_generation: number; snapshot_complete: boolean }>();

  for (const symbolPayload of body.symbols) {
    const canonicalSymbol = canonicalByBroker.get(symbolPayload.broker_symbol);
    if (!canonicalSymbol) {
      warnings.push(`No canonical mapping for broker symbol ${symbolPayload.broker_symbol}; skipped.`);
      continue;
    }

    const timeframe = symbolPayload.timeframe ?? "M5";
    ingestMetadata.set(`${canonicalSymbol}:${timeframe}`, {
      bootstrap_generation: Number.isInteger(symbolPayload.bootstrap_generation)
        ? Math.max(0, Number(symbolPayload.bootstrap_generation)) : 0,
      snapshot_complete: symbolPayload.snapshot_complete === true,
    });
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

  if (rows.length === 0) {
    return jsonResponse({ upserted: 0, diagnostics_recorded: collectorAttempts.length, warnings });
  }

  const brokerByCanonical = new Map<string, string>();
  for (const [brokerSymbol, canonicalSymbol] of canonicalByBroker.entries()) {
    if (!brokerByCanonical.has(canonicalSymbol)) brokerByCanonical.set(canonicalSymbol, brokerSymbol);
  }
  const acceptedByKey = new Map<string, {
    symbol: string;
    broker_symbol: string;
    timeframe: string;
    accepted_through: string;
    bar_count: number;
    bootstrap_generation: number;
    snapshot_complete: boolean;
  }>();
  for (const row of rows) {
    const key = `${row.symbol}:${row.timeframe}`;
    const accepted = acceptedByKey.get(key);
    if (accepted) {
      accepted.bar_count++;
      if (row.bar_time > accepted.accepted_through) accepted.accepted_through = row.bar_time;
    } else {
      acceptedByKey.set(key, {
        symbol: row.symbol,
        broker_symbol: brokerByCanonical.get(row.symbol) ?? row.symbol,
        timeframe: row.timeframe,
        accepted_through: row.bar_time,
        bar_count: 1,
        bootstrap_generation: ingestMetadata.get(key)?.bootstrap_generation ?? 0,
        snapshot_complete: ingestMetadata.get(key)?.snapshot_complete ?? false,
      });
    }
  }
  const acceptedSeries = [...acceptedByKey.values()];
  const batches = acceptedSeries.map((series) => ({
    symbol: series.symbol,
    timeframe: series.timeframe,
    latest_bar_time: series.accepted_through,
    bar_count: series.bar_count,
    bootstrap_generation: series.bootstrap_generation,
    snapshot_complete: series.snapshot_complete,
  }));
  // Store rows, enforce retention, advance checkpoints, and clear collector
  // health in one transaction. The EA may discard its outbox entry only after
  // this RPC succeeds and the exact accepted_through value is returned below.
  const { data: ingestResult, error: ingestError } = await admin.rpc("ingest_price_bar_batch", {
    p_terminal_id: terminal.id,
    p_rows: rows.map(({ terminal_id: _terminalId, ...row }) => row),
    p_batches: batches,
  });
  if (ingestError) {
    return jsonResponse({ error: "atomic_ingest_failed", detail: ingestError.message }, 500);
  }

  // M30/H1 closes are the source event for Trend Strength v3. Await those
  // bounded updates so the EA only receives success after the new score is
  // actually stored and available to Realtime. Background completion could
  // otherwise be interrupted after the price-ingest response was returned.
  const hasTrendSourceBars = rows.some((row) =>
    row.timeframe === TREND_ANCHOR_TIMEFRAME || row.timeframe === TREND_CONTEXT_TIMEFRAME
  );
  let trendUpdated = 0;
  if (hasTrendSourceBars) {
    const trendResult = await updateTrendStates(admin, terminal.id, rows);
    trendUpdated = trendResult.updated;
    warnings.push(...trendResult.warnings);
    if (trendUpdated > 0) dispatchPushInBackground(admin, [terminal.user_id]);
  }
  return jsonResponse({
    accepted: rows.length,
    // Keep the old field during the EA rollout; it historically meant rows
    // accepted for insertion, not necessarily newly-created database rows.
    upserted: rows.length,
    series: acceptedSeries.map(({
      broker_symbol, timeframe, accepted_through, bar_count,
      bootstrap_generation, snapshot_complete,
    }) => ({
      broker_symbol, timeframe, accepted_through, bar_count,
      bootstrap_generation, snapshot_complete,
    })),
    trend_update_scheduled: false,
    trend_updated: trendUpdated,
    diagnostics_recorded: collectorAttempts.length,
    pruned: Number((ingestResult as { pruned?: number } | null)?.pruned) || 0,
    warnings,
  });
});
