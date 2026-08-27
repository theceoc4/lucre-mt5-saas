// Layered trend-strength model. All calculations use CLOSED candles only.
// Direction and regime confidence are intentionally separate so a weak,
// choppy EMA crossover cannot produce a strong meter reading.

export const TREND_MODEL_VERSION = "trend-strength-v1";
export const TREND_BAR_LIMIT = 160;
export const TREND_TIMEFRAME_WEIGHTS: Record<string, number> = {
  M1: 0.05,
  M5: 0.10,
  M15: 0.20,
  H1: 0.30,
  H4: 0.25,
  D1: 0.10,
};

export type TrendBar = {
  bar_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type TimeframeRegime = "trending" | "ranging" | "transition" | "volatility_shock";

export type TimeframeTrend = {
  timeframe: string;
  score: number;
  direction: number;
  confidence: number;
  regime: TimeframeRegime;
  source_bar_time: string;
  components: {
    ema: number;
    rsi: number;
    dmi: number;
    adx: number;
    linearity: number;
    persistence: number;
    volatility_quality: number;
    atr_ratio: number;
  };
};

export type CompositeTrend = {
  score: number;
  direction: "bearish" | "neutral" | "bullish";
  strength: "neutral" | "weak" | "moderate" | "strong";
  confidence: number;
  regime: "trending" | "ranging" | "transition" | "volatility_shock" | "insufficient_data";
  source_bar_time: string | null;
  source_bar_times: Record<string, string>;
  components: Record<string, number>;
};

// Persisted outside Realtime. This is deliberately compact: steady-state
// updates read/write roughly one kilobyte instead of rereading 160 candles.
export type TrendIndicatorState = {
  version: string;
  bars_seen: number;
  source_bar_time: string;
  last_high: number;
  last_low: number;
  last_close: number;
  ema20: number;
  ema50: number;
  ema20_window: number[];
  spread_sign_window: number[];
  average_gain: number;
  average_loss: number;
  atr: number;
  atr_window: number[];
  smooth_range: number;
  smooth_plus: number;
  smooth_minus: number;
  adx: number;
  close_window: number[];
};

const EPSILON = 1e-12;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value: number, places = 4): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const x = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return x * x * (3 - 2 * x);
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function computeEMA(values: number[], period: number): number[] {
  const result = Array<number>(values.length).fill(Number.NaN);
  if (period <= 0 || values.length < period) return result;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  result[period - 1] = seed / period;
  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * multiplier + result[i - 1] * (1 - multiplier);
  }
  return result;
}

function computeRSI(closes: number[], period = 14): number[] {
  const result = Array<number>(closes.length).fill(Number.NaN);
  if (period <= 0 || closes.length <= period) return result;
  let averageGain = 0;
  let averageLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    averageGain += Math.max(change, 0);
    averageLoss += Math.max(-change, 0);
  }
  averageGain /= period;
  averageLoss /= period;
  const value = () => averageLoss === 0
    ? (averageGain === 0 ? 50 : 100)
    : 100 - 100 / (1 + averageGain / averageLoss);
  result[period] = value();
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[i] = value();
  }
  return result;
}

function computeATR(bars: TrendBar[], period = 14): number[] {
  const result = Array<number>(bars.length).fill(Number.NaN);
  if (period <= 0 || bars.length < period) return result;
  const trueRanges = bars.map((bar, index) => {
    if (index === 0) return bar.high - bar.low;
    const previousClose = bars[index - 1].close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
  });
  let average = trueRanges.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  result[period - 1] = average;
  for (let i = period; i < bars.length; i++) {
    average = (average * (period - 1) + trueRanges[i]) / period;
    result[i] = average;
  }
  return result;
}

function computeDMI(bars: TrendBar[], period = 14): {
  adx: number[];
  plusDi: number[];
  minusDi: number[];
} {
  const adx = Array<number>(bars.length).fill(Number.NaN);
  const plusDi = Array<number>(bars.length).fill(Number.NaN);
  const minusDi = Array<number>(bars.length).fill(Number.NaN);
  if (period <= 0 || bars.length < period * 2) return { adx, plusDi, minusDi };

  const trueRange = Array<number>(bars.length).fill(0);
  const plusMovement = Array<number>(bars.length).fill(0);
  const minusMovement = Array<number>(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    plusMovement[i] = up > down && up > 0 ? up : 0;
    minusMovement[i] = down > up && down > 0 ? down : 0;
    trueRange[i] = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
  }

  let smoothRange = 0;
  let smoothPlus = 0;
  let smoothMinus = 0;
  for (let i = 1; i <= period; i++) {
    smoothRange += trueRange[i];
    smoothPlus += plusMovement[i];
    smoothMinus += minusMovement[i];
  }
  const dx = Array<number>(bars.length).fill(Number.NaN);
  const calculate = (index: number) => {
    plusDi[index] = smoothRange > 0 ? 100 * smoothPlus / smoothRange : 0;
    minusDi[index] = smoothRange > 0 ? 100 * smoothMinus / smoothRange : 0;
    const denominator = plusDi[index] + minusDi[index];
    dx[index] = denominator > 0
      ? 100 * Math.abs(plusDi[index] - minusDi[index]) / denominator
      : 0;
  };
  calculate(period);
  for (let i = period + 1; i < bars.length; i++) {
    smoothRange = smoothRange - smoothRange / period + trueRange[i];
    smoothPlus = smoothPlus - smoothPlus / period + plusMovement[i];
    smoothMinus = smoothMinus - smoothMinus / period + minusMovement[i];
    calculate(i);
  }

  const firstAdxIndex = period * 2 - 1;
  let initialAdx = 0;
  for (let i = period; i <= firstAdxIndex; i++) initialAdx += dx[i];
  adx[firstAdxIndex] = initialAdx / period;
  for (let i = firstAdxIndex + 1; i < bars.length; i++) {
    adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  }
  return { adx, plusDi, minusDi };
}

function correlationWithTime(values: number[]): number {
  if (values.length < 2) return 0;
  const xMean = (values.length - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let covariance = 0;
  let xVariance = 0;
  let yVariance = 0;
  values.forEach((value, index) => {
    const xDelta = index - xMean;
    const yDelta = value - yMean;
    covariance += xDelta * yDelta;
    xVariance += xDelta * xDelta;
    yVariance += yDelta * yDelta;
  });
  const denominator = Math.sqrt(xVariance * yVariance);
  return denominator > EPSILON ? covariance / denominator : 0;
}

function regimeWithHysteresis(
  adx: number,
  linearity: number,
  atrRatio: number,
  previous?: string,
): TimeframeRegime {
  if (atrRatio >= 2.5) return "volatility_shock";
  if (previous === "trending" && adx >= 20 && linearity >= 0.35) return "trending";
  if (previous === "ranging" && (adx <= 22 || linearity <= 0.45)) return "ranging";
  if (adx >= 25 && linearity >= 0.60) return "trending";
  if (adx <= 18 || linearity <= 0.25) return "ranging";
  return "transition";
}

export function computeTimeframeTrend(
  timeframe: string,
  bars: TrendBar[],
  previousRegime?: string,
): TimeframeTrend | null {
  if (!(timeframe in TREND_TIMEFRAME_WEIGHTS) || bars.length < 60) return null;
  const closes = bars.map((bar) => bar.close);
  const ema20 = computeEMA(closes, 20);
  const ema50 = computeEMA(closes, 50);
  const rsi = computeRSI(closes, 14);
  const atr = computeATR(bars, 14);
  const dmi = computeDMI(bars, 14);
  const index = bars.length - 1;
  const latestAtr = atr[index];
  const required = [ema20[index], ema50[index], ema20[index - 5], rsi[index], latestAtr,
    dmi.adx[index], dmi.plusDi[index], dmi.minusDi[index]];
  if (!required.every(Number.isFinite) || latestAtr <= EPSILON) return null;

  const spread = (ema20[index] - ema50[index]) / latestAtr;
  const slope = (ema20[index] - ema20[index - 5]) / (5 * latestAtr);
  const emaScore = 0.65 * Math.tanh(spread / 0.75) + 0.35 * Math.tanh(slope / 0.35);
  const rsiScore = clamp((rsi[index] - 50) / 20, -1, 1);
  const dmiDenominator = dmi.plusDi[index] + dmi.minusDi[index];
  const dmiScore = dmiDenominator > EPSILON
    ? (dmi.plusDi[index] - dmi.minusDi[index]) / dmiDenominator
    : 0;
  const direction = clamp(0.50 * emaScore + 0.30 * dmiScore + 0.20 * rsiScore, -1, 1);

  const linearity = Math.abs(correlationWithTime(closes.slice(-30)));
  const currentSpreadDirection = Math.sign(ema20[index] - ema50[index]);
  let matching = 0;
  for (let i = index - 7; i <= index; i++) {
    if (Math.sign(ema20[i] - ema50[i]) === currentSpreadDirection) matching++;
  }
  const persistence = matching / 8;
  const recentAtr = atr.filter(Number.isFinite).slice(-50);
  const medianAtr = median(recentAtr);
  const atrRatio = medianAtr > EPSILON ? latestAtr / medianAtr : 1;
  const volatilityQuality = atrRatio <= 1.5
    ? 1
    : clamp(1 - ((atrRatio - 1.5) / 1.5) * 0.6, 0.4, 1);
  const adxQuality = smoothstep(18, 35, dmi.adx[index]);
  const confidence = clamp(
    (0.50 * adxQuality + 0.30 * linearity + 0.20 * persistence) * volatilityQuality,
    0,
    1,
  );
  const regime = regimeWithHysteresis(dmi.adx[index], linearity, atrRatio, previousRegime);

  return {
    timeframe,
    score: round(100 * direction * confidence, 2),
    direction: round(direction),
    confidence: round(confidence),
    regime,
    source_bar_time: bars[index].bar_time,
    components: {
      ema: round(emaScore),
      rsi: round(rsiScore),
      dmi: round(dmiScore),
      adx: round(dmi.adx[index], 2),
      linearity: round(linearity),
      persistence: round(persistence),
      volatility_quality: round(volatilityQuality),
      atr_ratio: round(atrRatio),
    },
  };
}

function stateResult(
  timeframe: string,
  state: TrendIndicatorState,
  previousRegime?: string,
): TimeframeTrend | null {
  if (state.ema20_window.length < 6 || state.close_window.length < 30 ||
    state.spread_sign_window.length < 8 || state.atr_window.length === 0 ||
    state.atr <= EPSILON) return null;

  const slope = (state.ema20 - state.ema20_window[state.ema20_window.length - 6]) / (5 * state.atr);
  const spread = (state.ema20 - state.ema50) / state.atr;
  const emaScore = 0.65 * Math.tanh(spread / 0.75) + 0.35 * Math.tanh(slope / 0.35);
  const rsi = state.average_loss === 0
    ? (state.average_gain === 0 ? 50 : 100)
    : 100 - 100 / (1 + state.average_gain / state.average_loss);
  const rsiScore = clamp((rsi - 50) / 20, -1, 1);
  const plusDi = state.smooth_range > EPSILON ? 100 * state.smooth_plus / state.smooth_range : 0;
  const minusDi = state.smooth_range > EPSILON ? 100 * state.smooth_minus / state.smooth_range : 0;
  const dmiDenominator = plusDi + minusDi;
  const dmiScore = dmiDenominator > EPSILON ? (plusDi - minusDi) / dmiDenominator : 0;
  const direction = clamp(0.50 * emaScore + 0.30 * dmiScore + 0.20 * rsiScore, -1, 1);
  const linearity = Math.abs(correlationWithTime(state.close_window));
  const currentSign = Math.sign(state.ema20 - state.ema50);
  const persistence = state.spread_sign_window.filter((value) => value === currentSign).length /
    state.spread_sign_window.length;
  const medianAtr = median(state.atr_window);
  const atrRatio = medianAtr > EPSILON ? state.atr / medianAtr : 1;
  const volatilityQuality = atrRatio <= 1.5
    ? 1
    : clamp(1 - ((atrRatio - 1.5) / 1.5) * 0.6, 0.4, 1);
  const adxQuality = smoothstep(18, 35, state.adx);
  const confidence = clamp(
    (0.50 * adxQuality + 0.30 * linearity + 0.20 * persistence) * volatilityQuality,
    0,
    1,
  );
  const regime = regimeWithHysteresis(state.adx, linearity, atrRatio, previousRegime);
  return {
    timeframe,
    score: round(100 * direction * confidence, 2),
    direction: round(direction),
    confidence: round(confidence),
    regime,
    source_bar_time: state.source_bar_time,
    components: {
      ema: round(emaScore), rsi: round(rsiScore), dmi: round(dmiScore), adx: round(state.adx, 2),
      linearity: round(linearity), persistence: round(persistence),
      volatility_quality: round(volatilityQuality), atr_ratio: round(atrRatio),
    },
  };
}

export function initializeTrendIndicatorState(
  timeframe: string,
  bars: TrendBar[],
  previousRegime?: string,
): { indicatorState: TrendIndicatorState; result: TimeframeTrend } | null {
  if (!(timeframe in TREND_TIMEFRAME_WEIGHTS) || bars.length < 60) return null;
  const ordered = [...bars].sort((a, b) => a.bar_time.localeCompare(b.bar_time));
  const closes = ordered.map((bar) => bar.close);
  const ema20Values = computeEMA(closes, 20);
  const ema50Values = computeEMA(closes, 50);
  const atrValues = computeATR(ordered, 14);
  const dmiValues = computeDMI(ordered, 14);
  const last = ordered.length - 1;
  if (![ema20Values[last], ema50Values[last], atrValues[last], dmiValues.adx[last]].every(Number.isFinite)) return null;

  let averageGain = 0;
  let averageLoss = 0;
  for (let i = 1; i <= 14; i++) {
    const change = closes[i] - closes[i - 1];
    averageGain += Math.max(change, 0);
    averageLoss += Math.max(-change, 0);
  }
  averageGain /= 14;
  averageLoss /= 14;
  for (let i = 15; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    averageGain = (averageGain * 13 + Math.max(change, 0)) / 14;
    averageLoss = (averageLoss * 13 + Math.max(-change, 0)) / 14;
  }

  let smoothRange = 0;
  let smoothPlus = 0;
  let smoothMinus = 0;
  const movements = ordered.map((bar, index) => {
    if (index === 0) return { range: 0, plus: 0, minus: 0 };
    const previous = ordered[index - 1];
    const up = bar.high - previous.high;
    const down = previous.low - bar.low;
    return {
      range: Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close)),
      plus: up > down && up > 0 ? up : 0,
      minus: down > up && down > 0 ? down : 0,
    };
  });
  for (let i = 1; i <= 14; i++) {
    smoothRange += movements[i].range;
    smoothPlus += movements[i].plus;
    smoothMinus += movements[i].minus;
  }
  for (let i = 15; i < ordered.length; i++) {
    smoothRange = smoothRange - smoothRange / 14 + movements[i].range;
    smoothPlus = smoothPlus - smoothPlus / 14 + movements[i].plus;
    smoothMinus = smoothMinus - smoothMinus / 14 + movements[i].minus;
  }

  const indicatorState: TrendIndicatorState = {
    version: TREND_MODEL_VERSION,
    bars_seen: ordered.length,
    source_bar_time: ordered[last].bar_time,
    last_high: ordered[last].high,
    last_low: ordered[last].low,
    last_close: ordered[last].close,
    ema20: ema20Values[last],
    ema50: ema50Values[last],
    ema20_window: ema20Values.filter(Number.isFinite).slice(-6),
    spread_sign_window: ordered.slice(-8).map((_, index) => {
      const i = ordered.length - Math.min(8, ordered.length) + index;
      return Math.sign(ema20Values[i] - ema50Values[i]);
    }),
    average_gain: averageGain,
    average_loss: averageLoss,
    atr: atrValues[last],
    atr_window: atrValues.filter(Number.isFinite).slice(-50),
    smooth_range: smoothRange,
    smooth_plus: smoothPlus,
    smooth_minus: smoothMinus,
    adx: dmiValues.adx[last],
    close_window: closes.slice(-30),
  };
  const result = stateResult(timeframe, indicatorState, previousRegime);
  return result ? { indicatorState, result } : null;
}

export function advanceTrendIndicatorState(
  timeframe: string,
  prior: TrendIndicatorState,
  bars: TrendBar[],
  previousRegime?: string,
): { indicatorState: TrendIndicatorState; result: TimeframeTrend } | null {
  if (prior.version !== TREND_MODEL_VERSION || !(timeframe in TREND_TIMEFRAME_WEIGHTS)) return null;
  const state: TrendIndicatorState = structuredClone(prior);
  const fresh = bars.filter((bar) => bar.bar_time > state.source_bar_time)
    .sort((a, b) => a.bar_time.localeCompare(b.bar_time));
  for (const bar of fresh) {
    const change = bar.close - state.last_close;
    state.average_gain = (state.average_gain * 13 + Math.max(change, 0)) / 14;
    state.average_loss = (state.average_loss * 13 + Math.max(-change, 0)) / 14;
    state.ema20 = bar.close * (2 / 21) + state.ema20 * (19 / 21);
    state.ema50 = bar.close * (2 / 51) + state.ema50 * (49 / 51);
    const trueRange = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - state.last_close),
      Math.abs(bar.low - state.last_close),
    );
    const up = bar.high - state.last_high;
    const down = state.last_low - bar.low;
    const plus = up > down && up > 0 ? up : 0;
    const minus = down > up && down > 0 ? down : 0;
    state.atr = (state.atr * 13 + trueRange) / 14;
    state.smooth_range = state.smooth_range - state.smooth_range / 14 + trueRange;
    state.smooth_plus = state.smooth_plus - state.smooth_plus / 14 + plus;
    state.smooth_minus = state.smooth_minus - state.smooth_minus / 14 + minus;
    const plusDi = state.smooth_range > EPSILON ? 100 * state.smooth_plus / state.smooth_range : 0;
    const minusDi = state.smooth_range > EPSILON ? 100 * state.smooth_minus / state.smooth_range : 0;
    const dx = plusDi + minusDi > EPSILON ? 100 * Math.abs(plusDi - minusDi) / (plusDi + minusDi) : 0;
    state.adx = (state.adx * 13 + dx) / 14;
    state.ema20_window = [...state.ema20_window, state.ema20].slice(-6);
    state.spread_sign_window = [...state.spread_sign_window, Math.sign(state.ema20 - state.ema50)].slice(-8);
    state.atr_window = [...state.atr_window, state.atr].slice(-50);
    state.close_window = [...state.close_window, bar.close].slice(-30);
    state.bars_seen++;
    state.source_bar_time = bar.bar_time;
    state.last_high = bar.high;
    state.last_low = bar.low;
    state.last_close = bar.close;
  }
  const result = stateResult(timeframe, state, previousRegime);
  return result ? { indicatorState: state, result } : null;
}

export function computeCompositeTrend(timeframes: Record<string, TimeframeTrend>): CompositeTrend {
  const entries = Object.entries(timeframes)
    .filter(([timeframe, state]) => timeframe in TREND_TIMEFRAME_WEIGHTS && state && Number.isFinite(state.score));
  const activeWeight = entries.reduce((sum, [timeframe]) => sum + TREND_TIMEFRAME_WEIGHTS[timeframe], 0);
  if (activeWeight < 0.25) {
    return {
      score: 0,
      direction: "neutral",
      strength: "neutral",
      confidence: 0,
      regime: "insufficient_data",
      source_bar_time: null,
      source_bar_times: {},
      components: { active_weight: round(activeWeight), agreement: 0, timeframes_ready: entries.length },
    };
  }

  let weightedScore = 0;
  let weightedConfidence = 0;
  let signedAgreement = 0;
  const regimeWeights: Record<string, number> = {};
  const sourceBarTimes: Record<string, string> = {};
  for (const [timeframe, state] of entries) {
    const weight = TREND_TIMEFRAME_WEIGHTS[timeframe];
    weightedScore += weight * state.score;
    weightedConfidence += weight * state.confidence;
    signedAgreement += weight * (Math.abs(state.direction) < 0.1 ? 0 : Math.sign(state.direction));
    regimeWeights[state.regime] = (regimeWeights[state.regime] || 0) + weight;
    sourceBarTimes[timeframe] = state.source_bar_time;
  }
  const agreement = Math.abs(signedAgreement) / activeWeight;
  const agreementFactor = 0.5 + 0.5 * agreement;
  const score = clamp((weightedScore / activeWeight) * agreementFactor, -100, 100);
  const confidence = clamp((weightedConfidence / activeWeight) * agreementFactor, 0, 1);
  const absoluteScore = Math.abs(score);
  const direction = score > 14 ? "bullish" : score < -14 ? "bearish" : "neutral";
  const strength = absoluteScore < 15
    ? "neutral"
    : absoluteScore < 30
    ? "weak"
    : absoluteScore < 60
    ? "moderate"
    : "strong";
  const normalizedRegimeWeight = (name: string) => (regimeWeights[name] || 0) / activeWeight;
  const regime = normalizedRegimeWeight("volatility_shock") >= 0.25
    ? "volatility_shock"
    : normalizedRegimeWeight("trending") >= 0.50 && confidence >= 0.40
    ? "trending"
    : normalizedRegimeWeight("ranging") >= 0.50
    ? "ranging"
    : "transition";
  const sourceBarTime = Object.values(sourceBarTimes).sort().at(-1) ?? null;

  return {
    score: round(score, 2),
    direction,
    strength,
    confidence: round(confidence),
    regime,
    source_bar_time: sourceBarTime,
    source_bar_times: sourceBarTimes,
    components: {
      active_weight: round(activeWeight),
      agreement: round(agreement),
      agreement_factor: round(agreementFactor),
      timeframes_ready: entries.length,
    },
  };
}
