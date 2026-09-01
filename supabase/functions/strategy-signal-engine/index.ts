// v1.0.38 — active-feed readiness, auto-repair, and per-pair evaluation health.
// v1.0.31 — progressive indicator stacks with bounded AND/OR evaluation.
// v1.0.30 — strategy-signal-engine
//
// Internal once-per-minute sweep invoked by pg_cron -> pg_net. It evaluates all
// enabled terminal strategies against their configured CLOSED-candle timeframe, creates
// deduplicated signals, and queues auto-execution commands only after the live
// adaptive policy and terminal position caps have been checked. Migration 040
// requires the Vault-backed scheduler secret before this service-role handler
// performs any work.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveBrokerSymbol } from "./_shared/symbol-resolver.ts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Side = "buy" | "sell";
type Session = "asia" | "london" | "ny" | "overlap";
type Regime = "trending" | "ranging";
type PolicyDecision = "ok" | "downweight" | "block";
type EvaluationStatus = "session_blocked" | "symbol_disabled" | "missing_bars" | "stale_candles" |
  "no_setup" | "direction_blocked" | "spread_blocked" | "cooldown_blocked" | "duplicate_bar" |
  "shadow_signal" | "manual_signal" | "ea_version_blocked" | "policy_blocked" | "risk_blocked" |
  "broker_mapping_failed" | "command_failed" | "command_queued";

const TIMEFRAME_SECONDS: Record<string, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400, W1: 604800,
};

type PriceBar = {
  bar_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  spread?: number | null;
};

type StrategyRow = {
  id: string;
  terminal_id: string;
  name: string;
  kind: "momentum_breakout" | "confirmed_trend_pullback" | string;
  timeframe: string;
  symbols: string[];
  delivery_mode: "auto" | "manual_confirm";
  max_lot_size: number | string;
  risk_percent: number | string;
  signal_ttl_seconds: number | string;
  config: Record<string, unknown> | null;
  run_mode: "shadow" | "live";
  bias_timeframe?: string | null;
  rule_definition?: RuleDefinition | null;
  exit_config?: Record<string, unknown> | null;
  allowed_sessions?: Session[] | null;
  direction_mode?: "both" | "long_only" | "short_only";
  cooldown_minutes?: number | string;
  max_concurrent_positions?: number | string;
  max_spread_points?: number | string | null;
  news_posture?: "avoid" | "neutral" | "exploit";
  news_window_minutes?: number | string;
  news_min_impact?: "low" | "medium" | "high";
  news_exploit_size_multiplier?: number | string;
};

type RuleCondition = {
  metric: "rsi14" | "adx14" | "ema_spread_atr" | "close_ema20_atr" | "breakout20_atr" |
    "atr_ratio" | "volume_ratio" | "spread_ratio" | "trend_score" | "linearity";
  timeframe: string;
  operator: "gt" | "gte" | "lt" | "lte" | "eq";
  value: number;
};

type LegacyRuleDefinition = { version: 1; long?: RuleCondition[]; short?: RuleCondition[] };
type IndicatorKind = "ema_crossover" | "rsi" | "adx" | "price_vs_ema" | "breakout" |
  "atr_volatility" | "volume_confirmation" | "trend_strength" | "linearity";
type IndicatorClause = {
  indicator: IndicatorKind;
  join?: "and" | "or";
  params?: Record<string, number | string>;
};
type IndicatorRuleDefinition = { version: 2; indicators: IndicatorClause[] };
type RuleDefinition = LegacyRuleDefinition | IndicatorRuleDefinition;
type NewsContext = {
  near: boolean;
  news_event_id: string | null;
  minutes_to_event: number | null;
  impact: string | null;
  implied_side: Side | null;
  has_direction: boolean;
};

type SignalCandidate = {
  side: Side;
  entryPrice: number;
  suggestedSl: number;
  suggestedTp: number;
  score: number;
  entryAtr: number;
  initialRiskDistance: number;
  // News policy starts here. An agent_policies cell can tighten this further.
  policyDecision: PolicyDecision;
};

type TerminalPositionBudget = {
  remaining: number;
  max: number;
  initialOpenCount: number;
};

const EPSILON = 1e-12;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function versionAtLeast(actual: unknown, required: string): boolean {
  const parse = (value: unknown) => String(value ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(actual);
  const right = parse(required);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) > (right[i] ?? 0);
  }
  return true;
}

function positiveConfig(config: Record<string, unknown> | null, key: string, fallback: number): number {
  const value = numberValue(config?.[key], fallback);
  return value > 0 ? value : fallback;
}

// Simplified UTC session bucketing, copied from signal-action/index.ts.
function sessionForNow(date: Date): Session {
  const h = date.getUTCHours();
  if (h >= 0 && h < 7) return "asia";
  if (h >= 7 && h < 12) return "london";
  if (h >= 12 && h < 16) return "overlap";
  if (h >= 16 && h < 21) return "ny";
  return "asia";
}

// One canonical, symbol-aware news lookup. The prior implementation queried
// any global medium/high event and could downweight EURUSD for an unrelated
// currency before the database trigger refined the context.
async function newsContextForStrategy(
  // deno-lint-ignore no-explicit-any
  admin: any,
  strategy: StrategyRow,
  symbol: string,
  at: Date,
): Promise<NewsContext> {
  const windowMinutes = Math.max(1, Math.min(240, numberValue(strategy.news_window_minutes, 30)));
  const minImpact = String(strategy.news_min_impact ?? "medium");
  const { data, error } = await admin.rpc("news_context", {
    p_symbol: symbol, p_at: at.toISOString(), p_window_minutes: windowMinutes, p_min_impact: minImpact,
  });
  if (error || !data || data.length === 0) {
    if (error) console.error(`strategy-signal-engine: news context failed for ${symbol}: ${error.message}`);
    return { near: false, news_event_id: null, minutes_to_event: null, impact: null, implied_side: null, has_direction: false };
  }
  const event = data[0];
  const minutes = numberValue(event.minutes_to_event, 0);
  let impliedSide: Side | null = null;
  const currency = typeof event.currency === "string" ? event.currency.toUpperCase() : "";
  const baseline = event.forecast ?? event.previous;
  if (symbol.length === 6 && currency && event.actual != null && baseline != null && Number(event.actual) !== Number(baseline)) {
    const bullishCurrency = (Number(event.actual) > Number(baseline)) === Boolean(event.effective_higher_is_bullish);
    if (currency === symbol.slice(0, 3).toUpperCase()) impliedSide = bullishCurrency ? "buy" : "sell";
    if (currency === symbol.slice(3, 6).toUpperCase()) impliedSide = bullishCurrency ? "sell" : "buy";
  }
  return {
    near: true, news_event_id: event.event_id, minutes_to_event: minutes,
    impact: event.impact ?? null, implied_side: impliedSide, has_direction: impliedSide !== null,
  };
}

function computeEMA(closes: number[], period: number): number[] {
  const result = Array<number>(closes.length).fill(Number.NaN);
  if (period <= 0 || closes.length < period) return result;

  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i];
  result[period - 1] = seed / period;

  const multiplier = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * multiplier + result[i - 1] * (1 - multiplier);
  }
  return result;
}

// Standard Wilder RSI: the first usable value is at `period`, then average
// gains/losses are smoothed as (prior*(period-1) + current)/period.
function computeRSI(closes: number[], period = 14): number[] {
  const result = Array<number>(closes.length).fill(Number.NaN);
  if (closes.length <= period || period <= 0) return result;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain += Math.max(change, 0);
    avgLoss += Math.max(-change, 0);
  }
  avgGain /= period;
  avgLoss /= period;

  const toRsi = (gain: number, loss: number): number => {
    if (loss === 0) return gain === 0 ? 50 : 100;
    return 100 - 100 / (1 + gain / loss);
  };
  result[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[i] = toRsi(avgGain, avgLoss);
  }
  return result;
}

function computeATR(bars: PriceBar[], period = 14): number[] {
  const result = Array<number>(bars.length).fill(Number.NaN);
  if (bars.length < period || period <= 0) return result;

  const tr = bars.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    const previousClose = bars[i - 1].close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
  });

  let atr = tr.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = atr;
  for (let i = period; i < bars.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    result[i] = atr;
  }
  return result;
}

// Standard Wilder ADX: +DI/-DI use smoothed true range and directional moves;
// the first ADX is seeded from `period` DX observations at index 2*period-1.
function computeADX(bars: PriceBar[], period = 14): number[] {
  const result = Array<number>(bars.length).fill(Number.NaN);
  if (bars.length < period * 2 || period <= 0) return result;

  const tr = Array<number>(bars.length).fill(0);
  const plusDm = Array<number>(bars.length).fill(0);
  const minusDm = Array<number>(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    plusDm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
  }

  let smoothTr = 0;
  let smoothPlus = 0;
  let smoothMinus = 0;
  for (let i = 1; i <= period; i++) {
    smoothTr += tr[i];
    smoothPlus += plusDm[i];
    smoothMinus += minusDm[i];
  }

  const dx = Array<number>(bars.length).fill(Number.NaN);
  const calculateDx = (i: number) => {
    const plusDi = smoothTr > 0 ? (100 * smoothPlus) / smoothTr : 0;
    const minusDi = smoothTr > 0 ? (100 * smoothMinus) / smoothTr : 0;
    const denominator = plusDi + minusDi;
    dx[i] = denominator > 0 ? (100 * Math.abs(plusDi - minusDi)) / denominator : 0;
  };

  calculateDx(period);
  for (let i = period + 1; i < bars.length; i++) {
    smoothTr = smoothTr - smoothTr / period + tr[i];
    smoothPlus = smoothPlus - smoothPlus / period + plusDm[i];
    smoothMinus = smoothMinus - smoothMinus / period + minusDm[i];
    calculateDx(i);
  }

  const firstAdxIndex = period * 2 - 1;
  let adx = 0;
  for (let i = period; i <= firstAdxIndex; i++) adx += dx[i];
  adx /= period;
  result[firstAdxIndex] = adx;
  for (let i = firstAdxIndex + 1; i < bars.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
    result[i] = adx;
  }
  return result;
}

function allFinite(...values: number[]): boolean {
  return values.every((value) => Number.isFinite(value));
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function correlationWithTime(values: number[]): number {
  if (values.length < 2) return 0;
  const xMean = (values.length - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let covariance = 0, xVariance = 0, yVariance = 0;
  values.forEach((value, index) => {
    const x = index - xMean, y = value - yMean;
    covariance += x * y; xVariance += x * x; yVariance += y * y;
  });
  const denominator = Math.sqrt(xVariance * yVariance);
  return denominator > EPSILON ? covariance / denominator : 0;
}

function metricValue(metric: RuleCondition["metric"], bars: PriceBar[]): number {
  if (bars.length < 60) return Number.NaN;
  const closes = bars.map((bar) => bar.close);
  const index = bars.length - 1;
  const atrValues = computeATR(bars, 14);
  const atr = atrValues[index];
  if (!finite(atr) || atr <= EPSILON) return Number.NaN;
  if (metric === "rsi14") return computeRSI(closes, 14)[index];
  if (metric === "adx14") return computeADX(bars, 14)[index];
  const ema20 = computeEMA(closes, 20)[index];
  const ema50 = computeEMA(closes, 50)[index];
  if (metric === "ema_spread_atr") return (ema20 - ema50) / atr;
  if (metric === "close_ema20_atr") return (closes[index] - ema20) / atr;
  if (metric === "breakout20_atr") {
    const prior = bars.slice(-21, -1);
    const high = Math.max(...prior.map((bar) => bar.high));
    const low = Math.min(...prior.map((bar) => bar.low));
    return closes[index] > high ? (closes[index] - high) / atr
      : closes[index] < low ? (closes[index] - low) / atr : 0;
  }
  if (metric === "atr_ratio") {
    const recent = atrValues.filter(Number.isFinite).slice(-50);
    const baseline = median(recent);
    return baseline > EPSILON ? atr / baseline : 1;
  }
  if (metric === "volume_ratio") {
    const baseline = median(bars.slice(-31, -1).map((bar) => bar.volume));
    return baseline > EPSILON ? bars[index].volume / baseline : 1;
  }
  if (metric === "spread_ratio") {
    const spreads = bars.slice(-31, -1).map((bar) => Number(bar.spread)).filter((value) => Number.isFinite(value) && value > 0);
    const baseline = median(spreads);
    return baseline > EPSILON && Number(bars[index].spread) > 0 ? Number(bars[index].spread) / baseline : 1;
  }
  const linearity = Math.abs(correlationWithTime(closes.slice(-30)));
  if (metric === "linearity") return linearity;
  if (metric === "trend_score") {
    const rsi = computeRSI(closes, 14)[index];
    const adx = computeADX(bars, 14)[index];
    const direction = clamp01(Math.abs((ema20 - ema50) / atr)) * Math.sign(ema20 - ema50);
    const confidence = clamp01((adx - 15) / 25) * (0.5 + 0.5 * linearity);
    return 100 * (0.75 * direction + 0.25 * Math.max(-1, Math.min(1, (rsi - 50) / 20))) * confidence;
  }
  return Number.NaN;
}

function compareRule(actual: number, operator: RuleCondition["operator"], expected: number): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  if (operator === "gt") return actual > expected;
  if (operator === "gte") return actual >= expected;
  if (operator === "lt") return actual < expected;
  if (operator === "lte") return actual <= expected;
  return Math.abs(actual - expected) <= 1e-6;
}

function customRuleSide(
  conditions: RuleCondition[] | undefined,
  barsByTimeframe: Map<string, PriceBar[]>,
): { matched: boolean; metrics: Record<string, number> } {
  if (!conditions || conditions.length === 0) return { matched: false, metrics: {} };
  const metrics: Record<string, number> = {};
  for (const condition of conditions) {
    const bars = barsByTimeframe.get(condition.timeframe) ?? [];
    const actual = metricValue(condition.metric, bars);
    metrics[`${condition.timeframe}.${condition.metric}`] = actual;
    if (!compareRule(actual, condition.operator, Number(condition.value))) return { matched: false, metrics };
  }
  return { matched: true, metrics };
}

function indicatorNumber(
  params: Record<string, number | string> | undefined,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.min(maximum, Math.max(minimum, numberValue(params?.[key], fallback)));
}

function evaluateIndicatorClause(
  clause: IndicatorClause,
  bars: PriceBar[],
): { buy: boolean; sell: boolean; metrics: Record<string, number | string> } {
  const empty = { buy: false, sell: false, metrics: {} };
  if (bars.length < 10) return empty;
  const params = clause.params ?? {};
  const index = bars.length - 1;
  const closes = bars.map((bar) => bar.close);
  const current = bars[index];

  if (clause.indicator === "ema_crossover") {
    const fastPeriod = Math.floor(indicatorNumber(params, "fast_period", 20, 2, 200));
    const slowPeriod = Math.floor(indicatorNumber(params, "slow_period", 50, 3, 400));
    if (fastPeriod >= slowPeriod || bars.length <= slowPeriod) return empty;
    const fast = computeEMA(closes, fastPeriod), slow = computeEMA(closes, slowPeriod);
    const trigger = params.trigger === "fresh_cross" ? "fresh_cross" : "alignment";
    const buy = trigger === "fresh_cross"
      ? fast[index] > slow[index] && fast[index - 1] <= slow[index - 1]
      : fast[index] > slow[index];
    const sell = trigger === "fresh_cross"
      ? fast[index] < slow[index] && fast[index - 1] >= slow[index - 1]
      : fast[index] < slow[index];
    return { buy, sell, metrics: { fast_ema: fast[index], slow_ema: slow[index], trigger } };
  }

  if (clause.indicator === "rsi") {
    const period = Math.floor(indicatorNumber(params, "period", 14, 2, 100));
    const value = computeRSI(closes, period)[index];
    const buyAbove = indicatorNumber(params, "buy_above", 55, 1, 99);
    const sellBelow = indicatorNumber(params, "sell_below", 45, 1, 99);
    return { buy: finite(value) && value >= buyAbove, sell: finite(value) && value <= sellBelow, metrics: { rsi: value } };
  }

  if (clause.indicator === "adx") {
    const period = Math.floor(indicatorNumber(params, "period", 14, 2, 100));
    const value = computeADX(bars, period)[index];
    const minimum = indicatorNumber(params, "minimum", 25, 1, 100);
    const matched = finite(value) && value >= minimum;
    return { buy: matched, sell: matched, metrics: { adx: value } };
  }

  const atrValues = computeATR(bars, 14);
  const atr = atrValues[index];
  if (!finite(atr) || atr <= EPSILON) return empty;

  if (clause.indicator === "price_vs_ema") {
    const period = Math.floor(indicatorNumber(params, "ema_period", 20, 2, 400));
    const ema = computeEMA(closes, period)[index];
    const distance = (current.close - ema) / atr;
    const minimum = indicatorNumber(params, "minimum_atr", 0, 0, 10);
    return { buy: distance >= minimum, sell: distance <= -minimum, metrics: { price_ema_atr: distance } };
  }

  if (clause.indicator === "breakout") {
    const lookback = Math.floor(indicatorNumber(params, "lookback", 20, 3, 200));
    const prior = bars.slice(-(lookback + 1), -1);
    if (prior.length < lookback) return empty;
    const high = Math.max(...prior.map((bar) => bar.high));
    const low = Math.min(...prior.map((bar) => bar.low));
    const minimum = indicatorNumber(params, "minimum_atr", 0, 0, 10);
    const highDistance = (current.close - high) / atr;
    const lowDistance = (current.close - low) / atr;
    return { buy: highDistance >= minimum, sell: lowDistance <= -minimum, metrics: { breakout_high_atr: highDistance, breakout_low_atr: lowDistance } };
  }

  if (clause.indicator === "atr_volatility") {
    const period = Math.floor(indicatorNumber(params, "period", 14, 2, 100));
    const baselineBars = Math.floor(indicatorNumber(params, "baseline", 50, 10, 200));
    const values = computeATR(bars, period);
    const value = values[index];
    const baseline = median(values.filter(Number.isFinite).slice(-(baselineBars + 1), -1));
    const ratio = baseline > EPSILON ? value / baseline : Number.NaN;
    const minimum = indicatorNumber(params, "minimum_ratio", 1, 0.1, 10);
    const matched = finite(ratio) && ratio >= minimum;
    return { buy: matched, sell: matched, metrics: { atr_ratio: ratio } };
  }

  if (clause.indicator === "volume_confirmation") {
    const lookback = Math.floor(indicatorNumber(params, "lookback", 30, 5, 200));
    const baseline = median(bars.slice(-(lookback + 1), -1).map((bar) => bar.volume));
    const ratio = baseline > EPSILON ? current.volume / baseline : Number.NaN;
    const minimum = indicatorNumber(params, "minimum_ratio", 1, 0.1, 10);
    const matched = finite(ratio) && ratio >= minimum;
    return { buy: matched, sell: matched, metrics: { volume_ratio: ratio } };
  }

  if (clause.indicator === "trend_strength") {
    const score = metricValue("trend_score", bars);
    const buyAbove = indicatorNumber(params, "buy_above", 35, -100, 100);
    const sellBelow = indicatorNumber(params, "sell_below", -35, -100, 100);
    return { buy: finite(score) && score >= buyAbove, sell: finite(score) && score <= sellBelow, metrics: { trend_score: score } };
  }

  if (clause.indicator === "linearity") {
    const lookback = Math.floor(indicatorNumber(params, "lookback", 30, 5, 200));
    const correlation = correlationWithTime(closes.slice(-lookback));
    const minimum = indicatorNumber(params, "minimum", 0.6, 0, 1);
    return { buy: correlation >= minimum, sell: correlation <= -minimum, metrics: { correlation } };
  }
  return empty;
}

function indicatorRuleSides(
  definition: IndicatorRuleDefinition,
  bars: PriceBar[],
): { buy: boolean; sell: boolean; metrics: Record<string, unknown> } {
  const clauses = definition.indicators.slice(0, 4);
  if (clauses.length === 0) return { buy: false, sell: false, metrics: {} };
  let buy = false, sell = false;
  const metrics: Record<string, unknown> = {};
  clauses.forEach((clause, index) => {
    const result = evaluateIndicatorClause(clause, bars);
    metrics[`${index + 1}.${clause.indicator}`] = result.metrics;
    if (index === 0) { buy = result.buy; sell = result.sell; return; }
    if (clause.join === "or") { buy = buy || result.buy; sell = sell || result.sell; }
    else { buy = buy && result.buy; sell = sell && result.sell; }
  });
  return { buy, sell, metrics };
}

function indicatorWarmupBars(definition: IndicatorRuleDefinition | null | undefined): number {
  if (!definition || definition.version !== 2) return 240;
  let required = 80;
  for (const clause of definition.indicators.slice(0, 4)) {
    const params = clause.params ?? {};
    if (clause.indicator === "ema_crossover") required = Math.max(required, indicatorNumber(params, "slow_period", 50, 3, 400) + 3);
    else if (clause.indicator === "adx") required = Math.max(required, indicatorNumber(params, "period", 14, 2, 100) * 2 + 3);
    else if (clause.indicator === "atr_volatility") required = Math.max(required,
      indicatorNumber(params, "period", 14, 2, 100) + indicatorNumber(params, "baseline", 50, 10, 200) + 3);
    else if (clause.indicator === "breakout" || clause.indicator === "volume_confirmation" || clause.indicator === "linearity") {
      required = Math.max(required, indicatorNumber(params, "lookback", 30, 3, 200) + 3);
    } else if (clause.indicator === "rsi") required = Math.max(required, indicatorNumber(params, "period", 14, 2, 100) + 3);
    else if (clause.indicator === "price_vs_ema") required = Math.max(required, indicatorNumber(params, "ema_period", 20, 2, 400) + 3);
  }
  return Math.min(500, Math.ceil(required));
}

function candidateFromSide(
  strategy: StrategyRow,
  bars: PriceBar[],
  side: Side,
  score: number,
  news: NewsContext,
): SignalCandidate | null {
  const current = bars[bars.length - 1];
  const atr = computeATR(bars, 14)[bars.length - 1];
  if (!current || !finite(atr) || atr <= EPSILON) return null;
  const exits = strategy.exit_config ?? {};
  const stopAtr = positiveConfig(exits, "stop_atr", positiveConfig(strategy.config, "stop_atr", 1.8));
  const swingLookback = Math.max(2, Math.min(50, Math.floor(positiveConfig(exits, "swing_lookback", 5))));
  const targetR = positiveConfig(exits, "target_r", positiveConfig(strategy.config, "target_r", 2.0));
  const recent = bars.slice(-swingLookback);
  const swingStop = side === "buy"
    ? current.close - (Math.min(...recent.map((bar) => bar.low)) - 0.2 * atr)
    : (Math.max(...recent.map((bar) => bar.high)) + 0.2 * atr) - current.close;
  const risk = Math.max(stopAtr * atr, swingStop);
  if (!(risk > EPSILON) || risk > positiveConfig(exits, "max_stop_atr", 4) * atr) return null;
  const newsCaution = news.near && (strategy.news_posture ?? "avoid") === "avoid";
  const newsFactor = positiveConfig(strategy.config, "news_score_factor", 0.5);
  const finalScore = newsCaution ? clamp01(score * newsFactor) : clamp01(score);
  return {
    side, entryPrice: current.close,
    suggestedSl: side === "buy" ? current.close - risk : current.close + risk,
    suggestedTp: side === "buy" ? current.close + targetR * risk : current.close - targetR * risk,
    score: finalScore, entryAtr: atr, initialRiskDistance: risk,
    policyDecision: newsCaution ? "downweight" : "ok",
  };
}

function evaluateStrategy(
  strategy: StrategyRow,
  barsByTimeframe: Map<string, PriceBar[]>,
  news: NewsContext,
): SignalCandidate | null {
  const bars = barsByTimeframe.get(strategy.timeframe) ?? [];
  const currentIndex = bars.length - 1;
  const previousIndex = currentIndex - 1;
  const current = bars[currentIndex];
  const previous = bars[previousIndex];
  if (!current || !previous) return null;

  const config = strategy.config;
  const closes = bars.map((bar) => bar.close);
  const atr = computeATR(bars, Math.max(2, Math.min(100, Math.floor(positiveConfig(config, "atr_period", 14)))));
  const rsi = computeRSI(closes, Math.max(2, Math.min(100, Math.floor(positiveConfig(config, "rsi_period", 14)))));
  const adx = computeADX(bars, Math.max(2, Math.min(100, Math.floor(positiveConfig(config, "adx_period", 14)))));
  const currentAtr = atr[currentIndex];
  const currentRsi = rsi[currentIndex];
  const currentAdx = adx[currentIndex];
  const newsScoreFactor = positiveConfig(config, "news_score_factor", 0.5);
  const newsCaution = news.near && (strategy.news_posture ?? "avoid") === "avoid";
  const applyNewsDownweight = (candidate: Omit<SignalCandidate, "policyDecision">): SignalCandidate => ({
    ...candidate,
    score: newsCaution ? clamp01(candidate.score * newsScoreFactor) : candidate.score,
    policyDecision: newsCaution ? "downweight" : "ok",
  });

  if (!allFinite(currentAtr, currentRsi, currentAdx) || currentAtr <= EPSILON) return null;

  if (strategy.kind === "custom_rules") {
    const definition = strategy.rule_definition;
    if (!definition) return null;
    if (definition.version === 2) {
      const result = indicatorRuleSides(definition, bars);
      if (result.buy === result.sell) return null; // ambiguous or no match
      return candidateFromSide(strategy, bars, result.buy ? "buy" : "sell", 0.72, news);
    }
    if (definition.version === 1) {
      const long = customRuleSide(definition.long, barsByTimeframe);
      const short = customRuleSide(definition.short, barsByTimeframe);
      if (long.matched === short.matched) return null;
      return candidateFromSide(strategy, bars, long.matched ? "buy" : "sell", 0.72, news);
    }
    return null;
  }

  if (strategy.kind === "multi_timeframe_trend_pullback") {
    const biasTimeframe = strategy.bias_timeframe || String(config?.bias_timeframe ?? "H4");
    const biasBars = barsByTimeframe.get(biasTimeframe) ?? [];
    if (biasBars.length < 60) return null;
    const biasCloses = biasBars.map((bar) => bar.close);
    const biasIndex = biasBars.length - 1;
    const biasFast = computeEMA(biasCloses, Math.floor(positiveConfig(config, "bias_ema_fast", 20)))[biasIndex];
    const biasSlow = computeEMA(biasCloses, Math.floor(positiveConfig(config, "bias_ema_slow", 50)))[biasIndex];
    const biasAdx = computeADX(biasBars, 14)[biasIndex];
    const entryEma = computeEMA(closes, Math.floor(positiveConfig(config, "entry_ema", 20)));
    if (!allFinite(biasFast, biasSlow, biasAdx, entryEma[currentIndex], entryEma[previousIndex])) return null;
    const minBiasAdx = positiveConfig(config, "bias_adx_min", 25);
    const longMatch = biasFast > biasSlow && biasAdx >= minBiasAdx && previous.low <= entryEma[previousIndex] &&
      current.close > entryEma[currentIndex] && current.close > current.open && currentRsi >= positiveConfig(config, "rsi_long_min", 50);
    const shortMatch = biasFast < biasSlow && biasAdx >= minBiasAdx && previous.high >= entryEma[previousIndex] &&
      current.close < entryEma[currentIndex] && current.close < current.open && currentRsi <= positiveConfig(config, "rsi_short_max", 50);
    if (longMatch === shortMatch) return null;
    return candidateFromSide(strategy, bars, longMatch ? "buy" : "sell", 0.76, news);
  }

  if (strategy.kind === "range_mean_reversion") {
    const period = Math.max(10, Math.min(100, Math.floor(positiveConfig(config, "band_period", 20))));
    if (closes.length < period + 2 || currentAdx > positiveConfig(config, "adx_max", 20)) return null;
    const window = closes.slice(-period);
    const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
    const deviation = Math.sqrt(window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / window.length);
    const band = positiveConfig(config, "band_deviation", 2) * deviation;
    const previousWindow = closes.slice(-period - 1, -1);
    const previousMean = previousWindow.reduce((sum, value) => sum + value, 0) / previousWindow.length;
    const previousDeviation = Math.sqrt(previousWindow.reduce((sum, value) => sum + (value - previousMean) ** 2, 0) / previousWindow.length);
    const longMatch = previous.close < previousMean - positiveConfig(config, "band_deviation", 2) * previousDeviation &&
      current.close > mean - band && currentRsi <= positiveConfig(config, "rsi_oversold", 38);
    const shortMatch = previous.close > previousMean + positiveConfig(config, "band_deviation", 2) * previousDeviation &&
      current.close < mean + band && currentRsi >= positiveConfig(config, "rsi_overbought", 62);
    if (longMatch === shortMatch) return null;
    return candidateFromSide(strategy, bars, longMatch ? "buy" : "sell", 0.70, news);
  }

  if (strategy.kind === "volatility_compression_breakout") {
    const atrValues = computeATR(bars, 14).filter(Number.isFinite);
    const baselineAtr = median(atrValues.slice(-60, -1));
    const atrRatio = baselineAtr > EPSILON ? currentAtr / baselineAtr : 1;
    const lookback = Math.max(8, Math.min(50, Math.floor(positiveConfig(config, "breakout_lookback", 20))));
    const prior = bars.slice(-lookback - 1, -1);
    const priorHigh = Math.max(...prior.map((bar) => bar.high));
    const priorLow = Math.min(...prior.map((bar) => bar.low));
    const priorAtr = median(atrValues.slice(-Math.min(10, atrValues.length), -1));
    const wasCompressed = baselineAtr > EPSILON && priorAtr / baselineAtr <= positiveConfig(config, "compression_atr_ratio", 0.85);
    const volumeRatio = metricValue("volume_ratio", bars);
    const longMatch = wasCompressed && current.close > priorHigh && atrRatio >= positiveConfig(config, "expansion_atr_ratio", 1.0) &&
      volumeRatio >= positiveConfig(config, "volume_ratio_min", 1.0);
    const shortMatch = wasCompressed && current.close < priorLow && atrRatio >= positiveConfig(config, "expansion_atr_ratio", 1.0) &&
      volumeRatio >= positiveConfig(config, "volume_ratio_min", 1.0);
    if (longMatch === shortMatch) return null;
    return candidateFromSide(strategy, bars, longMatch ? "buy" : "sell", 0.74, news);
  }

  if (strategy.kind === "news_continuation") {
    const settleMinutes = positiveConfig(config, "settle_minutes", 5);
    if (!news.has_direction || news.minutes_to_event == null || news.minutes_to_event > 0 || Math.abs(news.minutes_to_event) < settleMinutes) return null;
    const lookback = Math.max(2, Math.min(20, Math.floor(positiveConfig(config, "breakout_lookback", 3))));
    const prior = bars.slice(-lookback - 1, -1);
    const brokeUp = current.close > Math.max(...prior.map((bar) => bar.high));
    const brokeDown = current.close < Math.min(...prior.map((bar) => bar.low));
    if ((news.implied_side === "buy" && !brokeUp) || (news.implied_side === "sell" && !brokeDown)) return null;
    return candidateFromSide(strategy, bars, news.implied_side!, 0.78, { ...news, near: false });
  }

  if (strategy.kind === "momentum_breakout") {
    const emaFast = computeEMA(closes, Math.floor(positiveConfig(config, "ema_fast", 9)));
    const emaSlow = computeEMA(closes, Math.floor(positiveConfig(config, "ema_slow", 21)));
    const currentFast = emaFast[currentIndex];
    const currentSlow = emaSlow[currentIndex];
    if (!allFinite(currentFast, currentSlow)) return null;
    const breakoutLookback = Math.max(3, Math.min(100, Math.floor(positiveConfig(config, "breakout_lookback", 12))));
    const lookback = bars.slice(Math.max(0, currentIndex - breakoutLookback), currentIndex);
    if (lookback.length < breakoutLookback) return null;
    const priorHigh = Math.max(...lookback.map((bar) => bar.high));
    const priorLow = Math.min(...lookback.map((bar) => bar.low));
    const candleRange = Math.max(EPSILON, current.high - current.low);
    const bullishBody = (current.close - current.open) / candleRange;
    const bearishBody = (current.open - current.close) / candleRange;
    const spreadQuality = clamp01(Math.abs(currentFast - currentSlow) / currentAtr);
    const adxQuality = clamp01((currentAdx - 18) / 22);
    const recent = bars.slice(-5);
    const swingLow = Math.min(...recent.map((bar) => bar.low));
    const swingHigh = Math.max(...recent.map((bar) => bar.high));

    if (
      currentFast > currentSlow && current.close > priorHigh && currentAdx >= positiveConfig(config, "adx_min", 18) &&
      currentRsi >= positiveConfig(config, "rsi_long_min", 52) && currentRsi <= positiveConfig(config, "rsi_long_max", 74) && bullishBody >= positiveConfig(config, "body_min", 0.5) &&
      currentFast - currentSlow >= positiveConfig(config, "ema_separation_atr", 0.12) * currentAtr
    ) {
      const breakoutQuality = clamp01((current.close - priorHigh) / currentAtr);
      const stopDistance = Math.max(positiveConfig(config, "stop_atr", 1.5) * currentAtr, current.close - (swingLow - 0.2 * currentAtr));
      if (stopDistance > positiveConfig(config, "max_stop_atr", 2.8) * currentAtr) return null;
      const rewardMultiple = currentAdx >= positiveConfig(config, "strong_adx", 30) ? positiveConfig(config, "strong_target_r", 2.2) : positiveConfig(config, "target_r", 1.8);
      return applyNewsDownweight({
        side: "buy", entryPrice: current.close,
        suggestedSl: current.close - stopDistance,
        suggestedTp: current.close + rewardMultiple * stopDistance,
        score: clamp01(0.55 + 0.15 * adxQuality + 0.15 * spreadQuality + 0.15 * breakoutQuality),
        entryAtr: currentAtr, initialRiskDistance: stopDistance,
      });
    }
    if (
      currentFast < currentSlow && current.close < priorLow && currentAdx >= positiveConfig(config, "adx_min", 18) &&
      currentRsi >= positiveConfig(config, "rsi_short_min", 26) && currentRsi <= positiveConfig(config, "rsi_short_max", 48) && bearishBody >= positiveConfig(config, "body_min", 0.5) &&
      currentSlow - currentFast >= positiveConfig(config, "ema_separation_atr", 0.12) * currentAtr
    ) {
      const breakoutQuality = clamp01((priorLow - current.close) / currentAtr);
      const stopDistance = Math.max(positiveConfig(config, "stop_atr", 1.5) * currentAtr, (swingHigh + 0.2 * currentAtr) - current.close);
      if (stopDistance > positiveConfig(config, "max_stop_atr", 2.8) * currentAtr) return null;
      const rewardMultiple = currentAdx >= positiveConfig(config, "strong_adx", 30) ? positiveConfig(config, "strong_target_r", 2.2) : positiveConfig(config, "target_r", 1.8);
      return applyNewsDownweight({
        side: "sell", entryPrice: current.close,
        suggestedSl: current.close + stopDistance,
        suggestedTp: current.close - rewardMultiple * stopDistance,
        score: clamp01(0.55 + 0.15 * adxQuality + 0.15 * spreadQuality + 0.15 * breakoutQuality),
        entryAtr: currentAtr, initialRiskDistance: stopDistance,
      });
    }
    return null;
  }

  if (strategy.kind === "confirmed_trend_pullback") {
    const emaFast = computeEMA(closes, Math.floor(positiveConfig(config, "ema_fast", 20)));
    const emaSlow = computeEMA(closes, Math.floor(positiveConfig(config, "ema_slow", 50)));
    const currentFast = emaFast[currentIndex];
    const previousFast = emaFast[previousIndex];
    const currentSlow = emaSlow[currentIndex];
    const previousSlow = emaSlow[previousIndex];
    const slopeSlow = emaSlow[currentIndex - 5];
    if (!allFinite(currentFast, previousFast, currentSlow, previousSlow, slopeSlow)) return null;
    const recent = bars.slice(-5);
    const swingLow = Math.min(...recent.map((bar) => bar.low));
    const swingHigh = Math.max(...recent.map((bar) => bar.high));
    const spreadQuality = clamp01(Math.abs(currentFast - currentSlow) / currentAtr);
    const adxQuality = clamp01((currentAdx - 25) / 20);
    // Keep the moderate preset to one execution leg under the existing score
    // multiplier policy; selectivity comes from confirmation, not larger size.
    const score = Math.min(0.69, 0.50 + 0.10 * adxQuality + 0.09 * spreadQuality);

    if (
      currentFast > currentSlow && currentSlow > slopeSlow && currentAdx >= positiveConfig(config, "adx_min", 25) &&
      currentFast - currentSlow >= positiveConfig(config, "ema_separation_atr", 0.25) * currentAtr && currentRsi >= positiveConfig(config, "rsi_long_min", 50) && currentRsi <= positiveConfig(config, "rsi_long_max", 65) &&
      previous.low <= previousFast && previous.close <= previousFast && previous.close > previousSlow &&
      current.close > currentFast && current.close > current.open
    ) {
      const risk = Math.max(positiveConfig(config, "stop_atr", 1.8) * currentAtr, current.close - (swingLow - 0.25 * currentAtr));
      if (risk > positiveConfig(config, "max_stop_atr", 3.2) * currentAtr) return null;
      const suggestedSl = current.close - risk;
      const rewardMultiple = currentAdx >= positiveConfig(config, "strong_adx", 35) ? positiveConfig(config, "strong_target_r", 2.6) : positiveConfig(config, "target_r", 2.2);
      return applyNewsDownweight({
        side: "buy", entryPrice: current.close, suggestedSl,
        suggestedTp: current.close + rewardMultiple * risk, score,
        entryAtr: currentAtr, initialRiskDistance: risk,
      });
    }
    if (
      currentFast < currentSlow && currentSlow < slopeSlow && currentAdx >= positiveConfig(config, "adx_min", 25) &&
      currentSlow - currentFast >= positiveConfig(config, "ema_separation_atr", 0.25) * currentAtr && currentRsi >= positiveConfig(config, "rsi_short_min", 35) && currentRsi <= positiveConfig(config, "rsi_short_max", 50) &&
      previous.high >= previousFast && previous.close >= previousFast && previous.close < previousSlow &&
      current.close < currentFast && current.close < current.open
    ) {
      const risk = Math.max(positiveConfig(config, "stop_atr", 1.8) * currentAtr, (swingHigh + 0.25 * currentAtr) - current.close);
      if (risk > positiveConfig(config, "max_stop_atr", 3.2) * currentAtr) return null;
      const suggestedSl = current.close + risk;
      const rewardMultiple = currentAdx >= positiveConfig(config, "strong_adx", 35) ? positiveConfig(config, "strong_target_r", 2.6) : positiveConfig(config, "target_r", 2.2);
      return applyNewsDownweight({
        side: "sell", entryPrice: current.close, suggestedSl,
        suggestedTp: current.close - rewardMultiple * risk, score,
        entryAtr: currentAtr, initialRiskDistance: risk,
      });
    }
  }

  return null;
}

async function policyForCell(
  // deno-lint-ignore no-explicit-any
  admin: any,
  terminalId: string,
  strategyId: string,
  symbol: string,
  session: Session,
  regime: Regime,
  nearNews: boolean,
): Promise<{ decision: PolicyDecision; factor: number; error?: string }> {
  const { data, error } = await admin
    .from("agent_policies")
    .select("decision, downweight_factor")
    .eq("terminal_id", terminalId)
    .eq("strategy_id", strategyId)
    .eq("symbol", symbol)
    .eq("session", session)
    .eq("htf_regime", regime)
    .eq("near_news_event", nearNews)
    .maybeSingle();
  if (error) return { decision: "block", factor: 0, error: error.message };

  const decision: PolicyDecision = data?.decision === "block" || data?.decision === "downweight" ? data.decision : "ok";
  const factor = clamp01(numberValue(data?.downweight_factor, 1));
  return { decision, factor };
}

async function reservePositionSlot(
  // deno-lint-ignore no-explicit-any
  admin: any,
  terminalId: string,
  budgets: Map<string, TerminalPositionBudget>,
): Promise<{ reserved: boolean; error?: string }> {
  let budget = budgets.get(terminalId);
  if (!budget) {
    const { data: terminal, error: terminalError } = await admin
      .from("mt5_terminals")
      .select("max_open_positions")
      .eq("id", terminalId)
      .maybeSingle();
    if (terminalError || !terminal) return { reserved: false, error: terminalError?.message ?? "terminal_not_found" };

    const { count: openCount, error: countError } = await admin
      .from("positions")
      .select("id", { count: "exact", head: true })
      .eq("terminal_id", terminalId)
      .eq("status", "open");
    if (countError) return { reserved: false, error: countError.message };

    const max = Math.max(0, Math.floor(numberValue(terminal.max_open_positions, 0)));
    const initialOpenCount = openCount ?? 0;
    budget = { max, initialOpenCount, remaining: Math.max(0, max - initialOpenCount) };
    budgets.set(terminalId, budget);
  }

  // This is called immediately before every multiplier-leg insert. The initial
  // DB count is read once per terminal, then the local remaining budget is
  // decremented for every queued leg, preventing this sweep from overshooting
  // a cap before the EA's subsequent position reports arrive.
  if (budget.remaining <= 0) return { reserved: false };
  budget.remaining--;
  return { reserved: true };
}

async function manageOpenStrategyPositions(
  // deno-lint-ignore no-explicit-any
  admin: any,
  strategies: StrategyRow[],
  eaVersionByTerminal: Map<string, unknown>,
  nowIso: string,
): Promise<number> {
  if (strategies.length === 0) return 0;
  const strategyById = new Map(strategies.map((strategy) => [strategy.id, strategy]));
  const terminalIds = [...new Set(strategies.map((strategy) => strategy.terminal_id))];
  const { data: positions, error } = await admin.from("positions")
    .select("id,terminal_id,strategy_id,mt5_ticket,symbol,side,open_price,current_price,sl,tp,initial_risk_distance,entry_context,management_stage,last_management_bar_time")
    .in("terminal_id", terminalIds).eq("status", "open").eq("auto_manage", true);
  if (error) {
    console.error("strategy-signal-engine: managed-position fetch failed", error.message);
    return 0;
  }

  let queued = 0;
  for (const position of positions ?? []) {
    const strategy = strategyById.get(String(position.strategy_id));
    if (!strategy || !versionAtLeast(eaVersionByTerminal.get(strategy.terminal_id), "1.0.29")) continue;
    const { count: pendingManagementCount } = await admin.from("ea_commands")
      .select("id", { count: "exact", head: true })
      .eq("terminal_id", position.terminal_id)
      .eq("mt5_ticket", position.mt5_ticket)
      .eq("command_type", "modify_sl_tp")
      .in("status", ["queued", "sent", "acknowledged"]);
    if ((pendingManagementCount ?? 0) > 0) continue;
    const risk = Number(position.initial_risk_distance);
    const open = Number(position.open_price);
    const mark = Number(position.current_price);
    if (!(risk > EPSILON) || !Number.isFinite(open) || !Number.isFinite(mark)) continue;
    const context = position.entry_context && typeof position.entry_context === "object" ? position.entry_context : {};
    const canonicalSymbol = typeof context.canonical_symbol === "string" ? context.canonical_symbol : position.symbol;
    const { data: descendingBars, error: barsError } = await admin.from("price_bars")
      .select("bar_time,open,high,low,close,volume")
      .eq("terminal_id", position.terminal_id).eq("symbol", canonicalSymbol).eq("timeframe", strategy.timeframe)
      .order("bar_time", { ascending: false }).limit(60);
    if (barsError || !descendingBars || descendingBars.length < 55) continue;
    const bars: PriceBar[] = [...descendingBars].reverse().map((bar) => ({
      bar_time: String(bar.bar_time), open: Number(bar.open), high: Number(bar.high),
      low: Number(bar.low), close: Number(bar.close), volume: Number(bar.volume),
    }));
    const sourceBarTime = bars[bars.length - 1].bar_time;
    if (position.last_management_bar_time && sourceBarTime <= position.last_management_bar_time) continue;
    const atrValues = computeATR(bars, 14);
    const adxValues = computeADX(bars, 14);
    const ema20 = computeEMA(bars.map((bar) => bar.close), 20);
    const atr = atrValues[atrValues.length - 1];
    const adx = adxValues[adxValues.length - 1];
    const latestClose = bars[bars.length - 1].close;
    const latestEma = ema20[ema20.length - 1];
    if (!allFinite(atr, adx, latestClose, latestEma) || atr <= EPSILON) continue;
    const favorable = position.side === "buy" ? mark - open : open - mark;
    const currentR = favorable / risk;
    const exitConfig = strategy.exit_config ?? {};
    const breakEvenAtR = positiveConfig(exitConfig, "breakeven_r", 1);
    const trailAtR = positiveConfig(exitConfig, "trailing_start_r", 1.5);
    if (currentR < breakEvenAtR) {
      await admin.from("positions").update({ last_management_bar_time: sourceBarTime }).eq("id", position.id);
      continue;
    }

    const isBuy = position.side === "buy";
    const currentSl = Number(position.sl) || 0;
    const currentTp = Number(position.tp) || 0;
    const breakEven = isBuy ? open + 0.05 * atr : open - 0.05 * atr;
    let desiredSl = breakEven;
    let stage = 1;
    if (currentR >= trailAtR) {
      stage = 2;
      const recent = bars.slice(-5);
      const trailMultiple = positiveConfig(exitConfig, "trail_atr", strategy.kind === "confirmed_trend_pullback" ? 1.8 : 1.5);
      if (isBuy) {
        const swing = Math.min(...recent.map((bar) => bar.low)) - 0.2 * atr;
        desiredSl = Math.max(breakEven, Math.min(swing, latestClose - trailMultiple * atr));
      } else {
        const swing = Math.max(...recent.map((bar) => bar.high)) + 0.2 * atr;
        desiredSl = Math.min(breakEven, Math.max(swing, latestClose + trailMultiple * atr));
      }
    }
    const stopImproves = isBuy ? desiredSl > currentSl + EPSILON : currentSl <= 0 || desiredSl < currentSl - EPSILON;
    if ((isBuy && desiredSl >= mark) || (!isBuy && desiredSl <= mark)) {
      await admin.from("positions").update({ last_management_bar_time: sourceBarTime }).eq("id", position.id);
      continue;
    }

    const strongContinuation = adx >= positiveConfig(exitConfig, "extend_adx", 30) && (isBuy ? latestClose > latestEma : latestClose < latestEma);
    const extendedR = positiveConfig(exitConfig, "extended_target_r", strategy.kind === "confirmed_trend_pullback" ? 3.0 : 2.6);
    const extendedTp = isBuy ? open + extendedR * risk : open - extendedR * risk;
    const tpImproves = strongContinuation && (isBuy
      ? extendedTp > currentTp + EPSILON
      : currentTp <= 0 || extendedTp < currentTp - EPSILON);
    if (!stopImproves && !tpImproves) {
      await admin.from("positions").update({ last_management_bar_time: sourceBarTime }).eq("id", position.id);
      continue;
    }

    const { error: commandError } = await admin.from("ea_commands").insert({
      terminal_id: position.terminal_id,
      source: "auto_signal",
      command_type: "modify_sl_tp",
      mt5_ticket: position.mt5_ticket,
      sl: stopImproves ? desiredSl : currentSl,
      tp: tpImproves ? extendedTp : currentTp,
      strategy_id: strategy.id,
      idempotency_key: `manage:${position.id}:${sourceBarTime}`,
      auto_manage: true,
      management_stage: stage,
      management_source_bar_time: sourceBarTime,
      strategy_name_at_entry: strategy.name,
      origin_detail: "adaptive_trade_management",
      risk_defined: true,
      entry_context: { version: 1, action: stage === 1 ? "break_even" : "atr_structure_trail", current_r: currentR },
    });
    if (!commandError) queued++;
    else if (commandError.code !== "23505") {
      console.error(`strategy-signal-engine: management command failed for ${position.id}: ${commandError.message}`);
    }
  }
  return queued;
}

async function settleShadowSignals(
  // deno-lint-ignore no-explicit-any
  admin: any,
  strategy: StrategyRow,
  symbol: string,
  bars: PriceBar[],
  nowIso: string,
): Promise<void> {
  const { data: pending, error } = await admin.from("strategy_shadow_signals")
    .select("id,side,entry_price,sl,tp,initial_risk_distance,source_bar_time,expires_at,mfe_r,mae_r")
    .eq("strategy_id", strategy.id).eq("symbol", symbol).eq("timeframe", strategy.timeframe).eq("status", "pending");
  if (error || !pending) return;
  for (const signal of pending) {
    const risk = Number(signal.initial_risk_distance);
    const entry = Number(signal.entry_price);
    const subsequent = bars.filter((bar) => bar.bar_time > signal.source_bar_time);
    let mfeR = Number(signal.mfe_r) || 0, maeR = Number(signal.mae_r) || 0;
    let status: "pending" | "won" | "lost" | "expired" = "pending";
    let resultR: number | null = null;
    for (const bar of subsequent) {
      const favorable = signal.side === "buy" ? bar.high - entry : entry - bar.low;
      const adverse = signal.side === "buy" ? entry - bar.low : bar.high - entry;
      mfeR = Math.max(mfeR, favorable / risk);
      maeR = Math.max(maeR, adverse / risk);
      const hitStop = signal.side === "buy" ? bar.low <= Number(signal.sl) : bar.high >= Number(signal.sl);
      const hitTarget = signal.side === "buy" ? bar.high >= Number(signal.tp) : bar.low <= Number(signal.tp);
      // OHLC cannot reveal intrabar ordering; when both are touched, use the
      // conservative result instead of inflating simulated performance.
      if (hitStop) { status = "lost"; resultR = -1; break; }
      if (hitTarget) { status = "won"; resultR = Math.abs(Number(signal.tp) - entry) / risk; break; }
    }
    if (status === "pending" && new Date(signal.expires_at).getTime() <= new Date(nowIso).getTime()) {
      status = "expired";
      const last = bars[bars.length - 1]?.close ?? entry;
      resultR = (signal.side === "buy" ? last - entry : entry - last) / risk;
    }
    await admin.from("strategy_shadow_signals").update({
      status, result_r: resultR, mfe_r: mfeR, mae_r: maeR,
      resolved_at: status === "pending" ? null : nowIso,
    }).eq("id", signal.id);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const suppliedSecret = req.headers.get("x-lucre-scheduler-secret");
  if (!suppliedSecret) return jsonResponse({ error: "unauthorized" }, 401);

  // The verifier is SECURITY DEFINER but executable only by service_role. It
  // compares against the Vault value and returns only a boolean, so the Edge
  // Function never needs to receive or retain the scheduler secret itself.
  const { data: authorized, error: authorizationError } = await admin.rpc(
    "verify_strategy_engine_scheduler_secret",
    { supplied_secret: suppliedSecret },
  );
  if (authorizationError) {
    console.error("strategy-signal-engine: scheduler authorization check failed", authorizationError.message);
    return jsonResponse({ error: "scheduler_authorization_unavailable" }, 503);
  }
  if (authorized !== true) return jsonResponse({ error: "unauthorized" }, 401);

  try {
    const { data: strategies, error: strategiesError } = await admin
      .from("strategies")
      .select("id, terminal_id, name, kind, timeframe, symbols, delivery_mode, max_lot_size, risk_percent, signal_ttl_seconds, config, run_mode, bias_timeframe, rule_definition, exit_config, allowed_sessions, direction_mode, cooldown_minutes, max_concurrent_positions, max_spread_points, news_posture, news_window_minutes, news_min_impact, news_exploit_size_multiplier")
      .eq("enabled", true)
      .in("kind", ["momentum_breakout", "confirmed_trend_pullback", "multi_timeframe_trend_pullback", "range_mean_reversion", "volatility_compression_breakout", "news_continuation", "custom_rules"]);
    if (strategiesError) return jsonResponse({ error: "strategies_fetch_failed", detail: strategiesError.message }, 500);
    const activeStrategies = strategies ?? [];
    if (activeStrategies.length === 0) return jsonResponse({ processed: 0, signals_generated: 0, commands_queued: 0 });

    const terminalIds = [...new Set(activeStrategies.map((strategy) => strategy.terminal_id))];
    const { data: terminalCapabilities, error: capabilitiesError } = terminalIds.length > 0
      ? await admin.from("mt5_terminals").select("id,ea_version").in("id", terminalIds)
      : { data: [], error: null };
    if (capabilitiesError) return jsonResponse({ error: "terminal_capabilities_fetch_failed", detail: capabilitiesError.message }, 500);
    const eaVersionByTerminal = new Map((terminalCapabilities ?? []).map((terminal) => [terminal.id, terminal.ea_version]));
    const { data: symbolSettings, error: symbolSettingsError } = await admin
      .from("symbol_settings")
      .select("terminal_id, symbol, enabled")
      .in("terminal_id", terminalIds);
    if (symbolSettingsError) {
      return jsonResponse({ error: "symbol_settings_fetch_failed", detail: symbolSettingsError.message }, 500);
    }
    const supportedTimeframes = new Set(["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"]);
    const settingsByTerminalSymbol = new Map(
      (symbolSettings ?? []).map((setting) => [`${setting.terminal_id}:${setting.symbol}`, setting]),
    );
    const { data: feedStates, error: feedStatesError } = await admin
      .from("price_feed_series_state")
      .select("terminal_id,symbol,timeframe,status,bootstrap_required,history_bar_count,latest_bar_time,repair_requested_at")
      .in("terminal_id", terminalIds);
    if (feedStatesError) {
      return jsonResponse({ error: "price_feed_states_fetch_failed", detail: feedStatesError.message }, 500);
    }
    const feedStateBySeries = new Map(
      (feedStates ?? []).map((state) => [
        `${state.terminal_id}:${state.symbol}:${state.timeframe}`,
        state,
      ]),
    );

    const now = new Date();
    const nowIso = now.toISOString();
    const session = sessionForNow(now);
    const { data: calendarHealth } = await admin.from("market_feed_health")
      .select("last_received_at").eq("feed_name", "economic_calendar").maybeSingle();
    const calendarFresh = calendarHealth?.last_received_at &&
      now.getTime() - new Date(calendarHealth.last_received_at).getTime() <= 15 * 60_000;
    const budgets = new Map<string, TerminalPositionBudget>();
    let processed = 0;
    let signalsGenerated = 0;
    let commandsQueued = 0;
    const repairRequests = new Set<string>();
    const evaluationStates = new Map<string, Record<string, unknown>>();
    const recordEvaluation = (
      strategy: StrategyRow,
      symbol: string,
      status: EvaluationStatus,
      sourceBarTime: string | null = null,
      candleAgeSeconds: number | null = null,
      detail: Record<string, unknown> = {},
    ) => evaluationStates.set(`${strategy.id}:${symbol}`, {
      strategy_id: strategy.id,
      terminal_id: strategy.terminal_id,
      symbol,
      timeframe: strategy.timeframe,
      status,
      source_bar_time: sourceBarTime,
      candle_age_seconds: candleAgeSeconds == null ? null : Math.max(0, Math.round(candleAgeSeconds)),
      detail,
    });

    for (const rawStrategy of activeStrategies) {
      const strategy = rawStrategy as StrategyRow;
      if (!Array.isArray(strategy.symbols)) continue;
      if (!supportedTimeframes.has(strategy.timeframe)) continue;
      if (strategy.kind === "news_continuation" && !calendarFresh) continue;
      if (Array.isArray(strategy.allowed_sessions) && !strategy.allowed_sessions.includes(session)) {
        for (const symbol of strategy.symbols) {
          if (typeof symbol === "string" && symbol.length > 0) {
            recordEvaluation(strategy, symbol, "session_blocked", null, null, { current_session: session });
          }
        }
        continue;
      }
      const timeframe = strategy.timeframe;

      for (const symbol of strategy.symbols) {
        if (typeof symbol !== "string" || symbol.length === 0) continue;

        const symbolSetting = settingsByTerminalSymbol.get(`${strategy.terminal_id}:${symbol}`);
        if (symbolSetting && !symbolSetting.enabled) {
          recordEvaluation(strategy, symbol, "symbol_disabled");
          continue;
        }

        const requiredTimeframes = new Set<string>([timeframe]);
        if (strategy.bias_timeframe) requiredTimeframes.add(strategy.bias_timeframe);
        if (strategy.kind === "multi_timeframe_trend_pullback" && !strategy.bias_timeframe) requiredTimeframes.add("H4");
        if (strategy.rule_definition?.version === 1) {
          for (const condition of [...(strategy.rule_definition.long ?? []), ...(strategy.rule_definition.short ?? [])]) {
            if (supportedTimeframes.has(condition.timeframe)) requiredTimeframes.add(condition.timeframe);
          }
        }
        const barsByTimeframe = new Map<string, PriceBar[]>();
        let missingBars = false;
        for (const requiredTimeframe of requiredTimeframes) {
          const requiredHistoryBars = requiredTimeframe === timeframe && strategy.rule_definition?.version === 2
            ? Math.max(240, indicatorWarmupBars(strategy.rule_definition))
            : 240;
          const feedState = feedStateBySeries.get(
            `${strategy.terminal_id}:${symbol}:${requiredTimeframe}`,
          );
          if (!feedState || feedState.bootstrap_required || feedState.history_bar_count < requiredHistoryBars) {
            recordEvaluation(strategy, symbol, "missing_bars", feedState?.latest_bar_time ?? null, null, {
              required_timeframe: requiredTimeframe,
              feed_status: feedState?.status ?? "missing",
              bootstrap_required: feedState?.bootstrap_required ?? true,
              available_bars: feedState?.history_bar_count ?? 0,
              required_history_bars: requiredHistoryBars,
            });
            missingBars = true; break;
          }
          const barLimit = requiredHistoryBars;
          const { data: descendingBars, error: barsError } = await admin.from("price_bars")
            .select("bar_time, open, high, low, close, volume, spread")
            .eq("terminal_id", strategy.terminal_id).eq("symbol", symbol).eq("timeframe", requiredTimeframe)
            .order("bar_time", { ascending: false }).limit(barLimit);
          if (barsError || !descendingBars || descendingBars.length < 60) {
            if (barsError) console.error(`strategy-signal-engine: price_bars fetch failed for ${strategy.id}/${symbol}/${requiredTimeframe}: ${barsError.message}`);
            recordEvaluation(strategy, symbol, "missing_bars", null, null, {
              required_timeframe: requiredTimeframe,
              available_bars: descendingBars?.length ?? 0,
              error: barsError?.message ?? null,
            });
            missingBars = true; break;
          }
          barsByTimeframe.set(requiredTimeframe, [...descendingBars].reverse().map((bar) => ({
            bar_time: bar.bar_time, open: Number(bar.open), high: Number(bar.high), low: Number(bar.low),
            close: Number(bar.close), volume: Number(bar.volume), spread: bar.spread == null ? null : Number(bar.spread),
          })).filter((bar) => allFinite(bar.open, bar.high, bar.low, bar.close, bar.volume)));
        }
        if (missingBars) continue;
        const bars = barsByTimeframe.get(timeframe) ?? [];
        if (bars.length < 60) continue;

        const sourceBarTime = bars[bars.length - 1].bar_time;
        const candleAgeSeconds = Math.max(0, (now.getTime() - new Date(sourceBarTime).getTime()) / 1000);
        const staleAfterSeconds = Math.max(180, (TIMEFRAME_SECONDS[timeframe] ?? 60) * 2.5);
        if (candleAgeSeconds > staleAfterSeconds) {
          recordEvaluation(strategy, symbol, "stale_candles", sourceBarTime, candleAgeSeconds, {
            stale_after_seconds: staleAfterSeconds,
          });
          const repairKey = `${strategy.terminal_id}:${symbol}:${timeframe}`;
          const repairRequestedAt = feedStateBySeries.get(repairKey)?.repair_requested_at;
          const repairIsCoolingDown = repairRequestedAt &&
            now.getTime() - new Date(repairRequestedAt).getTime() < 5 * 60_000;
          if (!repairIsCoolingDown && !repairRequests.has(repairKey)) {
            repairRequests.add(repairKey);
            const { error: repairError } = await admin.rpc("request_price_feed_repair", {
              p_terminal_id: strategy.terminal_id,
              p_symbol: symbol,
              p_timeframe: timeframe,
              p_requested_by: null,
              p_reason: "automatic_stale",
            });
            if (repairError) console.error(
              `strategy-signal-engine: automatic feed repair failed for ${repairKey}: ${repairError.message}`,
            );
          }
          continue;
        }

        const adx = computeADX(bars, 14);
        const latestAdx = adx[adx.length - 1];
        if (!finite(latestAdx)) continue;
        const regime: Regime = latestAdx >= 25 ? "trending" : "ranging";
        processed++;

        await settleShadowSignals(admin, strategy, symbol, bars, nowIso);

        const news = await newsContextForStrategy(admin, strategy, symbol, now);
        const candidate = evaluateStrategy(strategy, barsByTimeframe, news);
        if (!candidate) {
          recordEvaluation(strategy, symbol, "no_setup", sourceBarTime, candleAgeSeconds);
          continue;
        }
        if (news.has_direction && news.minutes_to_event != null && news.minutes_to_event <= 0 && news.implied_side !== candidate.side) {
          recordEvaluation(strategy, symbol, "policy_blocked", sourceBarTime, candleAgeSeconds, { reason: "opposes_released_news" });
          continue;
        }
        if (strategy.direction_mode === "long_only" && candidate.side === "sell") {
          recordEvaluation(strategy, symbol, "direction_blocked", sourceBarTime, candleAgeSeconds, { candidate_side: candidate.side });
          continue;
        }
        if (strategy.direction_mode === "short_only" && candidate.side === "buy") {
          recordEvaluation(strategy, symbol, "direction_blocked", sourceBarTime, candleAgeSeconds, { candidate_side: candidate.side });
          continue;
        }
        const latestSpread = Number(bars[bars.length - 1].spread);
        if (strategy.max_spread_points != null && Number.isFinite(latestSpread) && latestSpread > numberValue(strategy.max_spread_points, Number.POSITIVE_INFINITY)) {
          recordEvaluation(strategy, symbol, "spread_blocked", sourceBarTime, candleAgeSeconds, { spread_points: latestSpread, maximum: strategy.max_spread_points });
          continue;
        }

        const cooldownMinutes = Math.max(0, Math.floor(numberValue(strategy.cooldown_minutes, 0)));
        if (cooldownMinutes > 0) {
          const { count: cooldownSignals } = await admin.from("signals").select("id", { count: "exact", head: true })
            .eq("strategy_id", strategy.id).eq("symbol", symbol)
            .gte("generated_at", new Date(now.getTime() - cooldownMinutes * 60_000).toISOString());
          if ((cooldownSignals ?? 0) > 0) {
            recordEvaluation(strategy, symbol, "cooldown_blocked", sourceBarTime, candleAgeSeconds, { cooldown_minutes: cooldownMinutes });
            continue;
          }
        }

        const ttlSeconds = Math.max(1, Math.floor(numberValue(strategy.signal_ttl_seconds, 60)));
        const { data: recentSignal, error: recentSignalError } = await admin
          .from("signals")
          .select("id")
          .eq("terminal_id", strategy.terminal_id)
          .eq("strategy_id", strategy.id)
          .eq("symbol", symbol)
          .eq("timeframe", timeframe)
          .eq("source_bar_time", sourceBarTime)
          .limit(1)
          .maybeSingle();
        if (recentSignalError) {
          console.error(`strategy-signal-engine: idempotency lookup failed for ${strategy.id}/${symbol}: ${recentSignalError.message}`);
          continue;
        }
        if (recentSignal) {
          recordEvaluation(strategy, symbol, "duplicate_bar", sourceBarTime, candleAgeSeconds);
          continue;
        }

        if (strategy.run_mode === "shadow") {
          const shadowBars = Math.max(5, Math.min(500, Math.floor(positiveConfig(strategy.config, "shadow_horizon_bars", 50))));
          const timeframeSeconds: Record<string, number> = {
            M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400, W1: 604800,
          };
          const { error: shadowError } = await admin.from("strategy_shadow_signals").insert({
            terminal_id: strategy.terminal_id, strategy_id: strategy.id, symbol, timeframe,
            source_bar_time: sourceBarTime, side: candidate.side, entry_price: candidate.entryPrice,
            sl: candidate.suggestedSl, tp: candidate.suggestedTp,
            initial_risk_distance: candidate.initialRiskDistance,
            expires_at: new Date(now.getTime() + shadowBars * timeframeSeconds[timeframe] * 1000).toISOString(),
            evaluation_context: {
              version: 1, strategy_kind: strategy.kind, definition_version: 1,
              regime, news, score: candidate.score, rule_definition: strategy.rule_definition ?? null,
            },
          });
          if (shadowError && shadowError.code !== "23505") {
            console.error(`strategy-signal-engine: shadow insert failed for ${strategy.id}/${symbol}: ${shadowError.message}`);
            recordEvaluation(strategy, symbol, "command_failed", sourceBarTime, candleAgeSeconds, { stage: "shadow_insert", error: shadowError.message });
          } else {
            recordEvaluation(strategy, symbol, "shadow_signal", sourceBarTime, candleAgeSeconds, { candidate_side: candidate.side });
          }
          continue;
        }

        const baseVolume = Math.max(0, numberValue(strategy.max_lot_size, 0));
        const baseRiskPercent = Math.min(5, Math.max(0.01, numberValue(strategy.risk_percent, 0.5)));
        if (baseVolume <= 0) {
          console.error(`strategy-signal-engine: strategy ${strategy.id} has non-positive max_lot_size; signal skipped`);
          recordEvaluation(strategy, symbol, "risk_blocked", sourceBarTime, candleAgeSeconds, { reason: "non_positive_max_lot_size" });
          continue;
        }

        const { data: signal, error: signalError } = await admin
          .from("signals")
          .insert({
            terminal_id: strategy.terminal_id,
            strategy_id: strategy.id,
            symbol,
            timeframe,
            source_bar_time: sourceBarTime,
            side: candidate.side,
            suggested_volume: baseVolume,
            suggested_risk_percent: baseRiskPercent,
            suggested_sl: candidate.suggestedSl,
            suggested_tp: candidate.suggestedTp,
            entry_atr: candidate.entryAtr,
            entry_spread_points: bars[bars.length - 1].spread ?? null,
            initial_risk_distance: candidate.initialRiskDistance,
            entry_price_ref: candidate.entryPrice,
            session,
            htf_regime: regime,
            near_news_event: news.near,
            news_event_id: news.news_event_id,
            score: candidate.score,
            policy_decision: candidate.policyDecision,
            ttl_seconds: ttlSeconds,
            generated_at: nowIso,
            expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
          })
          .select("id")
          .single();
        if (signalError || !signal) {
          console.error(`strategy-signal-engine: signal insert failed for ${strategy.id}/${symbol}: ${signalError?.message ?? "no row returned"}`);
          recordEvaluation(strategy, symbol, "command_failed", sourceBarTime, candleAgeSeconds, { stage: "signal_insert", error: signalError?.message ?? "no row returned" });
          continue;
        }
        signalsGenerated++;

        const { data: delivery, error: deliveryError } = await admin
          .from("signal_deliveries")
          .insert({
            signal_id: signal.id,
            terminal_id: strategy.terminal_id,
            delivery_mode: strategy.delivery_mode,
            status: "pending",
          })
          .select("id")
          .single();
        if (deliveryError || !delivery) {
          console.error(`strategy-signal-engine: delivery insert failed for signal ${signal.id}: ${deliveryError?.message ?? "no row returned"}`);
          recordEvaluation(strategy, symbol, "command_failed", sourceBarTime, candleAgeSeconds, { stage: "delivery_insert", error: deliveryError?.message ?? "no row returned" });
          continue;
        }

        if (strategy.delivery_mode === "manual_confirm") {
          recordEvaluation(strategy, symbol, "manual_signal", sourceBarTime, candleAgeSeconds, { signal_id: signal.id, candidate_side: candidate.side });
          continue;
        }

        if (!versionAtLeast(eaVersionByTerminal.get(strategy.terminal_id), "1.0.29")) {
          await admin.from("signal_deliveries").update({ status: "failed", acted_at: nowIso }).eq("id", delivery.id);
          console.warn(`strategy-signal-engine: terminal ${strategy.terminal_id} requires EA v1.0.29 for risk-sized auto execution`);
          recordEvaluation(strategy, symbol, "ea_version_blocked", sourceBarTime, candleAgeSeconds, { required_version: "1.0.29", installed_version: eaVersionByTerminal.get(strategy.terminal_id) ?? null });
          continue;
        }

        const policy = await policyForCell(admin, strategy.terminal_id, strategy.id, symbol, session, regime, news.near);
        if (policy.error) {
          await admin.from("signals").update({ policy_decision: "block" }).eq("id", signal.id);
          await admin.from("signal_deliveries").update({ status: "failed", acted_at: nowIso }).eq("id", delivery.id);
          console.error(`strategy-signal-engine: policy lookup failed for ${strategy.id}/${symbol}: ${policy.error}`);
          recordEvaluation(strategy, symbol, "policy_blocked", sourceBarTime, candleAgeSeconds, { reason: "policy_lookup_failed", error: policy.error });
          continue;
        }

        const finalDecision: PolicyDecision = policy.decision === "block" || candidate.policyDecision === "block"
          ? "block"
          : policy.decision === "downweight" || candidate.policyDecision === "downweight"
          ? "downweight"
          : "ok";
        await admin.from("signals").update({ policy_decision: finalDecision }).eq("id", signal.id);

        if (finalDecision === "block") {
          await admin.from("signal_deliveries").update({ status: "cancelled", acted_at: nowIso }).eq("id", delivery.id);
          recordEvaluation(strategy, symbol, "policy_blocked", sourceBarTime, candleAgeSeconds, { reason: "adaptive_or_news_policy" });
          continue;
        }

        const avoidNewsFactor = news.near && (strategy.news_posture ?? "avoid") === "avoid"
          ? positiveConfig(strategy.config, "news_volume_factor", 0.5) : 1;
        const exploitNewsFactor = news.has_direction && news.minutes_to_event != null && news.minutes_to_event <= 0 &&
            strategy.news_posture === "exploit" && news.implied_side === candidate.side
          ? Math.min(3, positiveConfig(strategy as unknown as Record<string, unknown>, "news_exploit_size_multiplier", 1.5)) * (regime === "trending" ? 1.25 : 1)
          : 1;
        const effectiveRiskPercent = baseRiskPercent *
          (policy.decision === "downweight" ? policy.factor : 1) * avoidNewsFactor * exploitNewsFactor;
        if (!Number.isFinite(effectiveRiskPercent) || effectiveRiskPercent <= 0) {
          await admin.from("signals").update({ policy_decision: "block" }).eq("id", signal.id);
          await admin.from("signal_deliveries").update({ status: "cancelled", acted_at: nowIso }).eq("id", delivery.id);
          recordEvaluation(strategy, symbol, "risk_blocked", sourceBarTime, candleAgeSeconds, { reason: "non_positive_effective_risk" });
          continue;
        }

        const { data: riskGate, error: riskGateError } = await admin.rpc("portfolio_risk_gate", {
          p_terminal_id: strategy.terminal_id,
          p_strategy_id: strategy.id,
          p_symbol: symbol,
          p_proposed_risk_percent: effectiveRiskPercent,
        });
        if (riskGateError || !riskGate?.[0]?.allowed) {
          await admin.from("signals").update({ policy_decision: "block" }).eq("id", signal.id);
          await admin.from("signal_deliveries").update({ status: "cancelled", acted_at: nowIso }).eq("id", delivery.id);
          if (riskGateError) console.error(`strategy-signal-engine: portfolio risk gate failed: ${riskGateError.message}`);
          recordEvaluation(strategy, symbol, "risk_blocked", sourceBarTime, candleAgeSeconds, { reason: "portfolio_risk_gate", error: riskGateError?.message ?? null });
          continue;
        }

        // Any downweight (adaptive-policy or near-news) caps the multiplier at
        // one. Otherwise score 0.85+ gets three entries, 0.70+ gets two.
        const positionCount = finalDecision === "downweight" ? 1 : candidate.score >= 0.85 ? 3 : candidate.score >= 0.7 ? 2 : 1;
        const riskPercentPerLeg = effectiveRiskPercent / positionCount;
        const resolution = await resolveBrokerSymbol(admin, strategy.terminal_id, symbol);
        if (resolution.error || !resolution.brokerSymbol) {
          await admin.from("signal_deliveries").update({ status: "failed", acted_at: nowIso }).eq("id", delivery.id);
          console.error(`strategy-signal-engine: broker symbol resolution failed for ${strategy.id}/${symbol}: ${resolution.error ?? "empty broker symbol"}`);
          recordEvaluation(strategy, symbol, "broker_mapping_failed", sourceBarTime, candleAgeSeconds, { error: resolution.error ?? "empty broker symbol" });
          continue;
        }

        let firstCommandId: string | null = null;
        let insertedLegs = 0;
        let insertFailure: string | null = null;
        for (let leg = 1; leg <= positionCount; leg++) {
          const reservation = await reservePositionSlot(admin, strategy.terminal_id, budgets);
          if (reservation.error) {
            insertFailure = reservation.error;
            break;
          }
          if (!reservation.reserved) break; // cap reached; do not overshoot it

          // signal_deliveries has a 1:1 ea_command_id FK so only the first
          // multiplier position is linked back to the delivery record —
          // positions 2/3 are still fully attributed via ea_commands.strategy_id
          // and the shared idempotency_key prefix, just not joinable from
          // signal_deliveries directly. A future migration could add a join
          // table if per-multiplier-leg delivery tracking becomes necessary.
          const commandRow: Record<string, unknown> = {
            terminal_id: strategy.terminal_id,
            source: "auto_signal",
            command_type: "open",
            symbol: resolution.brokerSymbol,
            side: candidate.side,
            volume: baseVolume,
            risk_percent: riskPercentPerLeg,
            sl: candidate.suggestedSl,
            tp: candidate.suggestedTp,
            entry_atr: candidate.entryAtr,
            entry_spread_points: bars[bars.length - 1].spread ?? null,
            initial_risk_distance: candidate.initialRiskDistance,
            auto_manage: true,
            idempotency_key: `sig:${signal.id}:${leg}`,
            signal_delivery_id: leg === 1 ? delivery.id : null,
            strategy_id: strategy.id,
            session,
            htf_regime: regime,
            near_news_event: news.near,
            news_event_id: news.news_event_id,
            strategy_name_at_entry: strategy.name,
            origin_detail: "strategy_auto",
            risk_defined: true,
            entry_context: {
              version: 2, captured_at: nowIso, origin: "strategy_auto",
              strategy_name_at_entry: strategy.name, session_definition: "utc-v1",
              regime_model: `adx14-${timeframe.toLowerCase()}-v1`, regime_quality: "strategy_grade",
              risk_defined: true, timeframe, strategy_kind: strategy.kind,
              canonical_symbol: symbol,
              risk_percent_total: effectiveRiskPercent, risk_percent_leg: riskPercentPerLeg,
              initial_atr: candidate.entryAtr, initial_risk_distance: candidate.initialRiskDistance,
              entry_spread_points: bars[bars.length - 1].spread ?? null,
            },
          };
          const { data: command, error: commandError } = await admin
            .from("ea_commands")
            .insert(commandRow)
            .select("id")
            .single();
          if (commandError || !command) {
            insertFailure = commandError?.message ?? "no command row returned";
            break;
          }
          if (!firstCommandId) firstCommandId = command.id;
          insertedLegs++;
          commandsQueued++;
        }

        if (insertedLegs > 0 && firstCommandId) {
          await admin
            .from("signal_deliveries")
            .update({ status: "auto_executed", acted_at: nowIso, ea_command_id: firstCommandId })
            .eq("id", delivery.id);
          recordEvaluation(strategy, symbol, "command_queued", sourceBarTime, candleAgeSeconds, { signal_id: signal.id, candidate_side: candidate.side, command_count: insertedLegs });
        } else {
          await admin.from("signal_deliveries").update({ status: "failed", acted_at: nowIso }).eq("id", delivery.id);
          recordEvaluation(strategy, symbol, "command_failed", sourceBarTime, candleAgeSeconds, { stage: "command_insert", error: insertFailure ?? "no_position_capacity" });
        }
        if (insertFailure) {
          console.error(`strategy-signal-engine: command insert failed for signal ${signal.id} after ${insertedLegs} legs: ${insertFailure}`);
        }
      }
    }

    commandsQueued += await manageOpenStrategyPositions(
      admin,
      activeStrategies as StrategyRow[],
      eaVersionByTerminal,
      nowIso,
    );
    let evaluationStatesWritten = 0;
    if (evaluationStates.size > 0) {
      const { data, error } = await admin.rpc("record_strategy_evaluation_states", {
        p_rows: [...evaluationStates.values()],
      });
      if (error) console.error("strategy-signal-engine: evaluation health write failed", error.message);
      else evaluationStatesWritten = Number(data) || 0;
    }
    return jsonResponse({
      processed,
      signals_generated: signalsGenerated,
      commands_queued: commandsQueued,
      evaluation_states_written: evaluationStatesWritten,
    });
  } catch (error) {
    console.error("strategy-signal-engine: unhandled error", error);
    return jsonResponse({ error: "internal_error", detail: error instanceof Error ? error.message : String(error) }, 500);
  }
});
