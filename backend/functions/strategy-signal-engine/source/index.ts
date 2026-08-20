// v1.0.14 — strategy-signal-engine
//
// Internal once-per-minute sweep invoked by pg_cron -> pg_net. It evaluates all
// enabled terminal strategies against EA-reported CLOSED M5 price bars, creates
// deduplicated signals, and queues auto-execution commands only after the live
// adaptive policy and terminal position caps have been checked.
//
// This function intentionally has no per-request auth and is deployed with
// verify_jwt:false. It is an internal all-strategy sweep, not a dashboard action.
// See migration 035 for the explicit security limitation and future Vault-secret
// hardening recommendation.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveBrokerSymbol } from "../_shared/symbol-resolver.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

type Side = "buy" | "sell";
type Session = "asia" | "london" | "ny" | "overlap";
type Regime = "trending" | "ranging";
type PolicyDecision = "ok" | "downweight" | "block";

type PriceBar = {
  bar_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type StrategyRow = {
  id: string;
  terminal_id: string;
  name: string;
  kind: "vwap_reversion" | "orb_breakout" | "bb_fade" | "ema_trend" | string;
  symbols: string[];
  delivery_mode: "auto" | "manual_confirm";
  max_lot_size: number | string;
  signal_ttl_seconds: number | string;
  config: Record<string, unknown> | null;
};

type SignalCandidate = {
  side: Side;
  entryPrice: number;
  suggestedSl: number;
  suggestedTp: number;
  score: number;
  // News policy starts here. An agent_policies cell can tighten this further.
  policyDecision: PolicyDecision;
};

type SessionVWAP = {
  vwap: number;
  upperBand1: number;
  lowerBand1: number;
  upperBand2: number;
  lowerBand2: number;
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

function positiveConfig(config: Record<string, unknown> | null, key: string, fallback: number): number {
  const value = numberValue(config?.[key], fallback);
  return value > 0 ? value : fallback;
}

function utcDayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function utcHour(iso: string): number {
  return new Date(iso).getUTCHours();
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

// Default +/-30 minute medium/high-impact calendar-event guard, copied from
// signal-action/index.ts so all generated signals carry the same news context.
async function nearNewsCheck(
  // deno-lint-ignore no-explicit-any
  admin: any,
  at: Date,
  windowMinutes = 30,
): Promise<{ near: boolean; news_event_id: string | null }> {
  const from = new Date(at.getTime() - windowMinutes * 60_000).toISOString();
  const to = new Date(at.getTime() + windowMinutes * 60_000).toISOString();
  const { data } = await admin
    .from("calendar_events")
    .select("id")
    .in("impact", ["medium", "high"])
    .gte("event_time", from)
    .lte("event_time", to)
    .order("event_time", { ascending: true })
    .limit(1);
  if (data && data.length > 0) return { near: true, news_event_id: data[0].id };
  return { near: false, news_event_id: null };
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

function computeBollinger(closes: number[], period = 20, mult = 2): {
  upper: number[];
  lower: number[];
  middle: number[];
  bandwidth: number[];
} {
  const upper = Array<number>(closes.length).fill(Number.NaN);
  const lower = Array<number>(closes.length).fill(Number.NaN);
  const middle = Array<number>(closes.length).fill(Number.NaN);
  const bandwidth = Array<number>(closes.length).fill(Number.NaN);
  if (period <= 0) return { upper, lower, middle, bandwidth };

  for (let i = period - 1; i < closes.length; i++) {
    const sample = closes.slice(i - period + 1, i + 1);
    const mean = sample.reduce((sum, value) => sum + value, 0) / period;
    const variance = sample.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period;
    const deviation = Math.sqrt(variance);
    middle[i] = mean;
    upper[i] = mean + mult * deviation;
    lower[i] = mean - mult * deviation;
    bandwidth[i] = Math.abs(mean) > EPSILON ? (upper[i] - lower[i]) / Math.abs(mean) : Number.NaN;
  }
  return { upper, lower, middle, bandwidth };
}

// Session-anchored VWAP, resetting at the first bar present for every UTC day.
// If every reported volume in a day is zero (common with some MT5 feeds), that
// day's weights become 1 so the calculation degrades safely to a session TWAP.
function computeSessionVWAP(bars: PriceBar[]): SessionVWAP | null {
  if (bars.length === 0) return null;

  const hasPositiveVolume = new Map<string, boolean>();
  for (const bar of bars) {
    const day = utcDayKey(bar.bar_time);
    hasPositiveVolume.set(day, (hasPositiveVolume.get(day) ?? false) || bar.volume > 0);
  }

  let currentDay = "";
  let weightedPriceSum = 0;
  let weightSum = 0;
  let deviations: number[] = [];
  let latest: SessionVWAP | null = null;

  for (const bar of bars) {
    const day = utcDayKey(bar.bar_time);
    if (day !== currentDay) {
      currentDay = day;
      weightedPriceSum = 0;
      weightSum = 0;
      deviations = [];
    }

    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    const weight = hasPositiveVolume.get(day) ? Math.max(0, bar.volume) : 1;
    weightedPriceSum += typicalPrice * weight;
    weightSum += weight;
    const vwap = weightSum > 0 ? weightedPriceSum / weightSum : typicalPrice;

    deviations.push(bar.close - vwap);
    const variance = deviations.reduce((sum, value) => sum + value * value, 0) / deviations.length;
    const sigma = Math.sqrt(variance);
    latest = {
      vwap,
      upperBand1: vwap + sigma,
      lowerBand1: vwap - sigma,
      upperBand2: vwap + 2 * sigma,
      lowerBand2: vwap - 2 * sigma,
    };
  }
  return latest;
}

function allFinite(...values: number[]): boolean {
  return values.every((value) => Number.isFinite(value));
}

function evaluateStrategy(
  strategy: StrategyRow,
  bars: PriceBar[],
  nearNews: boolean,
): SignalCandidate | null {
  const currentIndex = bars.length - 1;
  const previousIndex = currentIndex - 1;
  const current = bars[currentIndex];
  const previous = bars[previousIndex];
  if (!current || !previous) return null;

  const closes = bars.map((bar) => bar.close);
  const atr = computeATR(bars, 14);
  const rsi = computeRSI(closes, 14);
  const adx = computeADX(bars, 14);
  const ema9 = computeEMA(closes, 9);
  const ema21 = computeEMA(closes, 21);
  const bollinger = computeBollinger(closes, 20, 2);

  const currentAtr = atr[currentIndex];
  const currentRsi = rsi[currentIndex];
  const currentAdx = adx[currentIndex];
  const config = strategy.config;
  const newsScoreFactor = positiveConfig(config, "news_score_factor", 0.5);
  const applyNewsDownweight = (candidate: Omit<SignalCandidate, "policyDecision">): SignalCandidate => ({
    ...candidate,
    score: nearNews ? clamp01(candidate.score * newsScoreFactor) : candidate.score,
    policyDecision: nearNews ? "downweight" : "ok",
  });

  if (strategy.kind === "vwap_reversion") {
    const currentVwap = computeSessionVWAP(bars);
    const previousVwap = computeSessionVWAP(bars.slice(0, -1));
    const longRsiMax = positiveConfig(config, "rsi_long_max", 35);
    const shortRsiMin = positiveConfig(config, "rsi_short_min", 65);
    const atrBuffer = positiveConfig(config, "atr_stop_buffer", 0.5);
    if (!currentVwap || !previousVwap || !allFinite(currentAtr, currentRsi)) return null;

    if (previous.close < previousVwap.lowerBand2 && current.close >= currentVwap.lowerBand2 && currentRsi < longRsiMax) {
      // Default score formula: clamp01((35 - RSI) / 35); a configured threshold
      // substitutes for 35 while preserving the same 0..1 normalization shape.
      return applyNewsDownweight({
        side: "buy",
        entryPrice: current.close,
        suggestedSl: currentVwap.lowerBand2 - atrBuffer * currentAtr,
        suggestedTp: currentVwap.vwap,
        score: clamp01((longRsiMax - currentRsi) / longRsiMax),
      });
    }
    if (previous.close > previousVwap.upperBand2 && current.close <= currentVwap.upperBand2 && currentRsi > shortRsiMin) {
      // Default score formula: clamp01((RSI - 65) / 35), where 35 is the
      // distance from the default 65 trigger to RSI's 100 upper bound.
      return applyNewsDownweight({
        side: "sell",
        entryPrice: current.close,
        suggestedSl: currentVwap.upperBand2 + atrBuffer * currentAtr,
        suggestedTp: currentVwap.vwap,
        score: clamp01((currentRsi - shortRsiMin) / (100 - shortRsiMin)),
      });
    }
    return null;
  }

  if (strategy.kind === "orb_breakout") {
    const rangeStartHour = Math.floor(positiveConfig(config, "range_start_hour_utc", 0));
    const rangeEndHour = Math.floor(positiveConfig(config, "range_end_hour_utc", 7));
    const triggerEndHour = Math.floor(positiveConfig(config, "trigger_end_hour_utc", 9));
    const bufferFactor = positiveConfig(config, "breakout_buffer_factor", 0.0003);
    const bodyRatioMin = positiveConfig(config, "body_ratio_min", 0.6);
    const adxMin = positiveConfig(config, "adx_min", 20);
    const slRangeBuffer = positiveConfig(config, "sl_range_buffer", 0.05);
    const tpRangeMultiple = positiveConfig(config, "tp_range_multiple", 1.5);
    const currentHour = utcHour(current.bar_time);
    const currentDay = utcDayKey(current.bar_time);
    const rangeBars = bars.filter((bar) => {
      const hour = utcHour(bar.bar_time);
      return utcDayKey(bar.bar_time) === currentDay && hour >= rangeStartHour && hour < rangeEndHour;
    });
    if (rangeBars.length === 0 || currentHour < rangeEndHour || currentHour >= triggerEndHour || !finite(currentAdx)) return null;

    const rangeHigh = Math.max(...rangeBars.map((bar) => bar.high));
    const rangeLow = Math.min(...rangeBars.map((bar) => bar.low));
    const rangeSize = rangeHigh - rangeLow;
    if (rangeSize <= EPSILON) return null;
    const buffer = bufferFactor * current.close;
    const range = current.high - current.low;

    if (
      current.close >= rangeHigh + buffer &&
      (current.close - current.open) / (range + EPSILON) >= bodyRatioMin &&
      currentAdx >= adxMin
    ) {
      return applyNewsDownweight({
        side: "buy",
        entryPrice: current.close,
        suggestedSl: rangeLow - slRangeBuffer * rangeSize,
        suggestedTp: current.close + tpRangeMultiple * rangeSize,
        score: clamp01(currentAdx / 50),
      });
    }
    if (
      current.close <= rangeLow - buffer &&
      (current.open - current.close) / (range + EPSILON) >= bodyRatioMin &&
      currentAdx >= adxMin
    ) {
      return applyNewsDownweight({
        side: "sell",
        entryPrice: current.close,
        suggestedSl: rangeHigh + slRangeBuffer * rangeSize,
        suggestedTp: current.close - tpRangeMultiple * rangeSize,
        score: clamp01(currentAdx / 50),
      });
    }
    return null;
  }

  if (strategy.kind === "bb_fade") {
    const adxMax = positiveConfig(config, "adx_max", 25);
    const bandwidthMin = positiveConfig(config, "bandwidth_min", 0.04);
    const longRsiMax = positiveConfig(config, "rsi_long_max", 30);
    const shortRsiMin = positiveConfig(config, "rsi_short_min", 70);
    const atrStopMultiple = positiveConfig(config, "atr_stop_multiple", 1);
    const upper = bollinger.upper[currentIndex];
    const lower = bollinger.lower[currentIndex];
    const middle = bollinger.middle[currentIndex];
    const bandwidth = bollinger.bandwidth[currentIndex];
    if (!allFinite(currentAtr, currentRsi, currentAdx, upper, lower, middle, bandwidth)) return null;

    // A scheduled-news spike is repricing, not a BB mean-reversion setup. The
    // desired policy is block, but "skip entirely" means no signal row/delivery
    // is produced for this pair on this sweep.
    if (nearNews) return null;

    if (currentAdx < adxMax && bandwidth >= bandwidthMin && current.low <= lower && current.close > current.low && currentRsi < longRsiMax) {
      return {
        side: "buy",
        entryPrice: current.close,
        suggestedSl: current.low - atrStopMultiple * currentAtr,
        suggestedTp: middle,
        score: clamp01((longRsiMax - currentRsi) / longRsiMax),
        policyDecision: "ok",
      };
    }
    if (currentAdx < adxMax && bandwidth >= bandwidthMin && current.high >= upper && current.close < current.high && currentRsi > shortRsiMin) {
      return {
        side: "sell",
        entryPrice: current.close,
        suggestedSl: current.high + atrStopMultiple * currentAtr,
        suggestedTp: middle,
        score: clamp01((currentRsi - shortRsiMin) / (100 - shortRsiMin)),
        policyDecision: "ok",
      };
    }
    return null;
  }

  if (strategy.kind === "ema_trend") {
    const adxMin = positiveConfig(config, "adx_min", 25);
    const longRsiMin = positiveConfig(config, "rsi_long_min", 50);
    const longRsiMax = positiveConfig(config, "rsi_long_max", 70);
    const shortRsiMin = positiveConfig(config, "rsi_short_min", 30);
    const shortRsiMax = positiveConfig(config, "rsi_short_max", 50);
    const atrSpreadMultiple = positiveConfig(config, "atr_spread_multiple", 0.5);
    const atrStopMultiple = positiveConfig(config, "atr_stop_multiple", 1.5);
    const currentFast = ema9[currentIndex];
    const currentSlow = ema21[currentIndex];
    const previousFast = ema9[previousIndex];
    const previousSlow = ema21[previousIndex];
    if (!allFinite(currentAtr, currentRsi, currentAdx, currentFast, currentSlow, previousFast, previousSlow)) return null;

    if (
      currentFast > currentSlow && previousFast <= previousSlow && currentAdx >= adxMin &&
      currentRsi > longRsiMin && currentRsi < longRsiMax && current.close > currentFast && current.close > currentSlow &&
      Math.abs(currentFast - currentSlow) >= atrSpreadMultiple * currentAtr
    ) {
      const stopDistance = atrStopMultiple * currentAtr;
      return applyNewsDownweight({
        side: "buy",
        entryPrice: current.close,
        suggestedSl: current.close - stopDistance,
        suggestedTp: current.close + 2 * stopDistance,
        score: clamp01(currentAdx / 50),
      });
    }
    if (
      currentFast < currentSlow && previousFast >= previousSlow && currentAdx >= adxMin &&
      currentRsi > shortRsiMin && currentRsi < shortRsiMax && current.close < currentFast && current.close < currentSlow &&
      Math.abs(currentFast - currentSlow) >= atrSpreadMultiple * currentAtr
    ) {
      const stopDistance = atrStopMultiple * currentAtr;
      return applyNewsDownweight({
        side: "sell",
        entryPrice: current.close,
        suggestedSl: current.close + stopDistance,
        suggestedTp: current.close - 2 * stopDistance,
        score: clamp01(currentAdx / 50),
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: strategies, error: strategiesError } = await admin
      .from("strategies")
      .select("id, terminal_id, name, kind, symbols, delivery_mode, max_lot_size, signal_ttl_seconds, config")
      .eq("enabled", true);
    if (strategiesError) return jsonResponse({ error: "strategies_fetch_failed", detail: strategiesError.message }, 500);
    if (!strategies || strategies.length === 0) return jsonResponse({ processed: 0, signals_generated: 0, commands_queued: 0 });

    const now = new Date();
    const nowIso = now.toISOString();
    const session = sessionForNow(now);
    const news = await nearNewsCheck(admin, now);
    const budgets = new Map<string, TerminalPositionBudget>();
    let processed = 0;
    let signalsGenerated = 0;
    let commandsQueued = 0;

    for (const rawStrategy of strategies) {
      const strategy = rawStrategy as StrategyRow;
      if (!Array.isArray(strategy.symbols)) continue;

      for (const symbol of strategy.symbols) {
        if (typeof symbol !== "string" || symbol.length === 0) continue;

        const { data: descendingBars, error: barsError } = await admin
          .from("price_bars")
          .select("bar_time, open, high, low, close, volume")
          .eq("terminal_id", strategy.terminal_id)
          .eq("symbol", symbol)
          .eq("timeframe", "M5")
          .order("bar_time", { ascending: false })
          .limit(300);
        if (barsError) {
          console.error(`strategy-signal-engine: price_bars fetch failed for ${strategy.id}/${symbol}: ${barsError.message}`);
          continue;
        }
        if (!descendingBars || descendingBars.length < 30) continue; // expected while the EA's new bar feed warms up

        const bars: PriceBar[] = [...descendingBars].reverse().map((bar) => ({
          bar_time: bar.bar_time,
          open: Number(bar.open),
          high: Number(bar.high),
          low: Number(bar.low),
          close: Number(bar.close),
          volume: Number(bar.volume),
        })).filter((bar) => allFinite(bar.open, bar.high, bar.low, bar.close, bar.volume));
        if (bars.length < 30) continue;

        const adx = computeADX(bars, 14);
        const latestAdx = adx[adx.length - 1];
        if (!finite(latestAdx)) continue;
        const regime: Regime = latestAdx >= 25 ? "trending" : "ranging";
        processed++;

        const candidate = evaluateStrategy(strategy, bars, news.near);
        if (!candidate) continue;

        // signals has no status column in the existing schema (delivery status
        // lives in signal_deliveries), so the requested active-status predicate
        // is represented by this TTL-window check on signals.generated_at.
        const ttlSeconds = Math.max(1, Math.floor(numberValue(strategy.signal_ttl_seconds, 60)));
        const cutoffIso = new Date(now.getTime() - ttlSeconds * 1000).toISOString();
        const { data: recentSignal, error: recentSignalError } = await admin
          .from("signals")
          .select("id")
          .eq("terminal_id", strategy.terminal_id)
          .eq("strategy_id", strategy.id)
          .eq("symbol", symbol)
          .gte("generated_at", cutoffIso)
          .limit(1)
          .maybeSingle();
        if (recentSignalError) {
          console.error(`strategy-signal-engine: idempotency lookup failed for ${strategy.id}/${symbol}: ${recentSignalError.message}`);
          continue;
        }
        if (recentSignal) continue;

        const baseVolume = Math.max(0, numberValue(strategy.max_lot_size, 0));
        if (baseVolume <= 0) {
          console.error(`strategy-signal-engine: strategy ${strategy.id} has non-positive max_lot_size; signal skipped`);
          continue;
        }

        const { data: signal, error: signalError } = await admin
          .from("signals")
          .insert({
            terminal_id: strategy.terminal_id,
            strategy_id: strategy.id,
            symbol,
            side: candidate.side,
            suggested_volume: baseVolume,
            suggested_sl: candidate.suggestedSl,
            suggested_tp: candidate.suggestedTp,
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
          continue;
        }

        if (strategy.delivery_mode === "manual_confirm") continue;

        const policy = await policyForCell(admin, strategy.terminal_id, strategy.id, symbol, session, regime, news.near);
        if (policy.error) {
          await admin.from("signals").update({ policy_decision: "block" }).eq("id", signal.id);
          await admin.from("signal_deliveries").update({ status: "failed", acted_at: nowIso }).eq("id", delivery.id);
          console.error(`strategy-signal-engine: policy lookup failed for ${strategy.id}/${symbol}: ${policy.error}`);
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
          continue;
        }

        const nearNewsFactor = news.near ? positiveConfig(strategy.config, "news_volume_factor", 0.5) : 1;
        const effectiveVolume = baseVolume * (policy.decision === "downweight" ? policy.factor : 1) * nearNewsFactor;
        if (!Number.isFinite(effectiveVolume) || effectiveVolume <= 0) {
          await admin.from("signals").update({ policy_decision: "block" }).eq("id", signal.id);
          await admin.from("signal_deliveries").update({ status: "cancelled", acted_at: nowIso }).eq("id", delivery.id);
          continue;
        }

        // Any downweight (adaptive-policy or near-news) caps the multiplier at
        // one. Otherwise score 0.85+ gets three entries, 0.70+ gets two.
        const positionCount = finalDecision === "downweight" ? 1 : candidate.score >= 0.85 ? 3 : candidate.score >= 0.7 ? 2 : 1;
        const resolution = await resolveBrokerSymbol(admin, strategy.terminal_id, symbol);
        if (resolution.error || !resolution.brokerSymbol) {
          await admin.from("signal_deliveries").update({ status: "failed", acted_at: nowIso }).eq("id", delivery.id);
          console.error(`strategy-signal-engine: broker symbol resolution failed for ${strategy.id}/${symbol}: ${resolution.error ?? "empty broker symbol"}`);
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
            volume: effectiveVolume,
            sl: candidate.suggestedSl,
            tp: candidate.suggestedTp,
            idempotency_key: `sig:${signal.id}:${leg}`,
            signal_delivery_id: leg === 1 ? delivery.id : null,
            strategy_id: strategy.id,
            session,
            htf_regime: regime,
            near_news_event: news.near,
            news_event_id: news.news_event_id,
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
        } else {
          await admin.from("signal_deliveries").update({ status: "failed", acted_at: nowIso }).eq("id", delivery.id);
        }
        if (insertFailure) {
          console.error(`strategy-signal-engine: command insert failed for signal ${signal.id} after ${insertedLegs} legs: ${insertFailure}`);
        }
      }
    }

    return jsonResponse({ processed, signals_generated: signalsGenerated, commands_queued: commandsQueued });
  } catch (error) {
    console.error("strategy-signal-engine: unhandled error", error);
    return jsonResponse({ error: "internal_error", detail: error instanceof Error ? error.message : String(error) }, 500);
  }
});
