// v1.0.28 — strategy-signal-engine
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

  const config = strategy.config;
  const closes = bars.map((bar) => bar.close);
  const atr = computeATR(bars, 14);
  const rsi = computeRSI(closes, 14);
  const adx = computeADX(bars, 14);
  const currentAtr = atr[currentIndex];
  const currentRsi = rsi[currentIndex];
  const currentAdx = adx[currentIndex];
  const newsScoreFactor = positiveConfig(config, "news_score_factor", 0.5);
  const applyNewsDownweight = (candidate: Omit<SignalCandidate, "policyDecision">): SignalCandidate => ({
    ...candidate,
    score: nearNews ? clamp01(candidate.score * newsScoreFactor) : candidate.score,
    policyDecision: nearNews ? "downweight" : "ok",
  });

  if (!allFinite(currentAtr, currentRsi, currentAdx) || currentAtr <= EPSILON) return null;

  if (strategy.kind === "momentum_breakout") {
    const emaFast = computeEMA(closes, 9);
    const emaSlow = computeEMA(closes, 21);
    const currentFast = emaFast[currentIndex];
    const currentSlow = emaSlow[currentIndex];
    if (!allFinite(currentFast, currentSlow)) return null;
    const lookback = bars.slice(Math.max(0, currentIndex - 12), currentIndex);
    if (lookback.length < 12) return null;
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
      currentFast > currentSlow && current.close > priorHigh && currentAdx >= 18 &&
      currentRsi >= 52 && currentRsi <= 74 && bullishBody >= 0.5 &&
      currentFast - currentSlow >= 0.12 * currentAtr
    ) {
      const breakoutQuality = clamp01((current.close - priorHigh) / currentAtr);
      const stopDistance = Math.max(1.5 * currentAtr, current.close - (swingLow - 0.2 * currentAtr));
      if (stopDistance > 2.8 * currentAtr) return null;
      const rewardMultiple = currentAdx >= 30 ? 2.2 : 1.8;
      return applyNewsDownweight({
        side: "buy", entryPrice: current.close,
        suggestedSl: current.close - stopDistance,
        suggestedTp: current.close + rewardMultiple * stopDistance,
        score: clamp01(0.55 + 0.15 * adxQuality + 0.15 * spreadQuality + 0.15 * breakoutQuality),
        entryAtr: currentAtr, initialRiskDistance: stopDistance,
      });
    }
    if (
      currentFast < currentSlow && current.close < priorLow && currentAdx >= 18 &&
      currentRsi >= 26 && currentRsi <= 48 && bearishBody >= 0.5 &&
      currentSlow - currentFast >= 0.12 * currentAtr
    ) {
      const breakoutQuality = clamp01((priorLow - current.close) / currentAtr);
      const stopDistance = Math.max(1.5 * currentAtr, (swingHigh + 0.2 * currentAtr) - current.close);
      if (stopDistance > 2.8 * currentAtr) return null;
      const rewardMultiple = currentAdx >= 30 ? 2.2 : 1.8;
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
    const emaFast = computeEMA(closes, 20);
    const emaSlow = computeEMA(closes, 50);
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
      currentFast > currentSlow && currentSlow > slopeSlow && currentAdx >= 25 &&
      currentFast - currentSlow >= 0.25 * currentAtr && currentRsi >= 50 && currentRsi <= 65 &&
      previous.low <= previousFast && previous.close <= previousFast && previous.close > previousSlow &&
      current.close > currentFast && current.close > current.open
    ) {
      const risk = Math.max(1.8 * currentAtr, current.close - (swingLow - 0.25 * currentAtr));
      if (risk > 3.2 * currentAtr) return null;
      const suggestedSl = current.close - risk;
      const rewardMultiple = currentAdx >= 35 ? 2.6 : 2.2;
      return applyNewsDownweight({
        side: "buy", entryPrice: current.close, suggestedSl,
        suggestedTp: current.close + rewardMultiple * risk, score,
        entryAtr: currentAtr, initialRiskDistance: risk,
      });
    }
    if (
      currentFast < currentSlow && currentSlow < slopeSlow && currentAdx >= 25 &&
      currentSlow - currentFast >= 0.25 * currentAtr && currentRsi >= 35 && currentRsi <= 50 &&
      previous.high >= previousFast && previous.close >= previousFast && previous.close < previousSlow &&
      current.close < currentFast && current.close < current.open
    ) {
      const risk = Math.max(1.8 * currentAtr, (swingHigh + 0.25 * currentAtr) - current.close);
      if (risk > 3.2 * currentAtr) return null;
      const suggestedSl = current.close + risk;
      const rewardMultiple = currentAdx >= 35 ? 2.6 : 2.2;
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
    if (currentR < 1) {
      await admin.from("positions").update({ last_management_bar_time: sourceBarTime }).eq("id", position.id);
      continue;
    }

    const isBuy = position.side === "buy";
    const currentSl = Number(position.sl) || 0;
    const currentTp = Number(position.tp) || 0;
    const breakEven = isBuy ? open + 0.05 * atr : open - 0.05 * atr;
    let desiredSl = breakEven;
    let stage = 1;
    if (currentR >= 1.5) {
      stage = 2;
      const recent = bars.slice(-5);
      const trailMultiple = strategy.kind === "confirmed_trend_pullback" ? 1.8 : 1.5;
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

    const strongContinuation = adx >= 30 && (isBuy ? latestClose > latestEma : latestClose < latestEma);
    const extendedR = strategy.kind === "confirmed_trend_pullback" ? 3.0 : 2.6;
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
      .select("id, terminal_id, name, kind, timeframe, symbols, delivery_mode, max_lot_size, risk_percent, signal_ttl_seconds, config")
      .eq("enabled", true)
      .in("kind", ["momentum_breakout", "confirmed_trend_pullback"]);
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

    const now = new Date();
    const nowIso = now.toISOString();
    const session = sessionForNow(now);
    const news = await nearNewsCheck(admin, now);
    const budgets = new Map<string, TerminalPositionBudget>();
    let processed = 0;
    let signalsGenerated = 0;
    let commandsQueued = 0;

    for (const rawStrategy of activeStrategies) {
      const strategy = rawStrategy as StrategyRow;
      if (!Array.isArray(strategy.symbols)) continue;
      if (!supportedTimeframes.has(strategy.timeframe)) continue;
      const timeframe = strategy.timeframe;

      for (const symbol of strategy.symbols) {
        if (typeof symbol !== "string" || symbol.length === 0) continue;

        const symbolSetting = settingsByTerminalSymbol.get(`${strategy.terminal_id}:${symbol}`);
        if (symbolSetting && !symbolSetting.enabled) continue;

        const { data: descendingBars, error: barsError } = await admin
          .from("price_bars")
          .select("bar_time, open, high, low, close, volume, spread")
          .eq("terminal_id", strategy.terminal_id)
          .eq("symbol", symbol)
          .eq("timeframe", timeframe)
          .order("bar_time", { ascending: false })
          .limit(100);
        if (barsError) {
          console.error(`strategy-signal-engine: price_bars fetch failed for ${strategy.id}/${symbol}: ${barsError.message}`);
          continue;
        }
        if (!descendingBars || descendingBars.length < 60) continue; // expected while the EA's bar feed warms up

        const bars: PriceBar[] = [...descendingBars].reverse().map((bar) => ({
          bar_time: bar.bar_time,
          open: Number(bar.open),
          high: Number(bar.high),
          low: Number(bar.low),
          close: Number(bar.close),
          volume: Number(bar.volume),
          spread: bar.spread == null ? null : Number(bar.spread),
        })).filter((bar) => allFinite(bar.open, bar.high, bar.low, bar.close, bar.volume));
        if (bars.length < 60) continue;

        const adx = computeADX(bars, 14);
        const latestAdx = adx[adx.length - 1];
        if (!finite(latestAdx)) continue;
        const regime: Regime = latestAdx >= 25 ? "trending" : "ranging";
        processed++;

        const candidate = evaluateStrategy(strategy, bars, news.near);
        if (!candidate) continue;

        const ttlSeconds = Math.max(1, Math.floor(numberValue(strategy.signal_ttl_seconds, 60)));
        const sourceBarTime = bars[bars.length - 1].bar_time;
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
        if (recentSignal) continue;

        const baseVolume = Math.max(0, numberValue(strategy.max_lot_size, 0));
        const baseRiskPercent = Math.min(5, Math.max(0.01, numberValue(strategy.risk_percent, 0.5)));
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

        if (!versionAtLeast(eaVersionByTerminal.get(strategy.terminal_id), "1.0.29")) {
          await admin.from("signal_deliveries").update({ status: "failed", acted_at: nowIso }).eq("id", delivery.id);
          console.warn(`strategy-signal-engine: terminal ${strategy.terminal_id} requires EA v1.0.29 for risk-sized auto execution`);
          continue;
        }

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
        const effectiveRiskPercent = baseRiskPercent *
          (policy.decision === "downweight" ? policy.factor : 1) * nearNewsFactor;
        if (!Number.isFinite(effectiveRiskPercent) || effectiveRiskPercent <= 0) {
          await admin.from("signals").update({ policy_decision: "block" }).eq("id", signal.id);
          await admin.from("signal_deliveries").update({ status: "cancelled", acted_at: nowIso }).eq("id", delivery.id);
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
        } else {
          await admin.from("signal_deliveries").update({ status: "failed", acted_at: nowIso }).eq("id", delivery.id);
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
    return jsonResponse({ processed, signals_generated: signalsGenerated, commands_queued: commandsQueued });
  } catch (error) {
    console.error("strategy-signal-engine: unhandled error", error);
    return jsonResponse({ error: "internal_error", detail: error instanceof Error ? error.message : String(error) }, 500);
  }
});
