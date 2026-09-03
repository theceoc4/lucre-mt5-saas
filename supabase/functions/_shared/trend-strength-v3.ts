// M30 day-trading trend model shared by the live meter, strategy engine, and backtester.
// Inputs must contain CLOSED broker candles ordered oldest -> newest.

export const TREND_MODEL_VERSION = "trend-strength-v3";
export const TREND_ANCHOR_TIMEFRAME = "M30";
export const TREND_CONTEXT_TIMEFRAME = "H1";
export const TREND_MIN_BARS = 120;

export type TrendV3Bar = {
  bar_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  real_volume?: number | null;
};

export type TrendV3Regime = "trending" | "ranging" | "transition" | "volatility_shock" | "insufficient_data";

export type TrendV3Result = {
  score: number;
  direction: "bearish" | "neutral" | "bullish";
  strength: "neutral" | "weak" | "moderate" | "strong";
  confidence: number;
  regime: TrendV3Regime;
  source_bar_time: string | null;
  source_bar_times: Record<string, string>;
  timeframe_scores: Record<string, Record<string, number | string | boolean | null>>;
  components: Record<string, number | string | boolean | null>;
};

const EPSILON = 1e-12;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const round = (value: number, places = 4) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
const smoothstep = (low: number, high: number, value: number) => {
  const x = clamp((value - low) / (high - low), 0, 1);
  return x * x * (3 - 2 * x);
};
const median = (values: number[]) => {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function ema(values: number[], period: number): number[] {
  const output = Array<number>(values.length).fill(Number.NaN);
  if (values.length < period) return output;
  output[period - 1] = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i++) output[i] = values[i] * alpha + output[i - 1] * (1 - alpha);
  return output;
}

function rsi(values: number[], period = 14): number[] {
  const output = Array<number>(values.length).fill(Number.NaN);
  if (values.length <= period) return output;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = values[i] - values[i - 1];
    gain += Math.max(delta, 0); loss += Math.max(-delta, 0);
  }
  gain /= period; loss /= period;
  const value = () => loss <= EPSILON ? (gain <= EPSILON ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  output[period] = value();
  for (let i = period + 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(delta, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-delta, 0)) / period;
    output[i] = value();
  }
  return output;
}

function volatility(bars: TrendV3Bar[], period = 14) {
  const trueRange = bars.map((bar, index) => index === 0
    ? bar.high - bar.low
    : Math.max(bar.high - bar.low, Math.abs(bar.high - bars[index - 1].close), Math.abs(bar.low - bars[index - 1].close)));
  const atr = Array<number>(bars.length).fill(Number.NaN);
  if (bars.length >= period) {
    atr[period - 1] = trueRange.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    for (let i = period; i < bars.length; i++) atr[i] = (atr[i - 1] * (period - 1) + trueRange[i]) / period;
  }
  return { trueRange, atr };
}

function dmi(bars: TrendV3Bar[], period = 14) {
  const adx = Array<number>(bars.length).fill(Number.NaN);
  const plusDi = Array<number>(bars.length).fill(Number.NaN);
  const minusDi = Array<number>(bars.length).fill(Number.NaN);
  if (bars.length < period * 2) return { adx, plusDi, minusDi };
  const tr = Array<number>(bars.length).fill(0), plus = Array<number>(bars.length).fill(0), minus = Array<number>(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    plus[i] = up > down && up > 0 ? up : 0;
    minus[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
  }
  let smoothTr = 0, smoothPlus = 0, smoothMinus = 0;
  for (let i = 1; i <= period; i++) { smoothTr += tr[i]; smoothPlus += plus[i]; smoothMinus += minus[i]; }
  const dx = Array<number>(bars.length).fill(Number.NaN);
  const calculate = (index: number) => {
    plusDi[index] = smoothTr > EPSILON ? 100 * smoothPlus / smoothTr : 0;
    minusDi[index] = smoothTr > EPSILON ? 100 * smoothMinus / smoothTr : 0;
    const total = plusDi[index] + minusDi[index];
    dx[index] = total > EPSILON ? 100 * Math.abs(plusDi[index] - minusDi[index]) / total : 0;
  };
  calculate(period);
  for (let i = period + 1; i < bars.length; i++) {
    smoothTr = smoothTr - smoothTr / period + tr[i];
    smoothPlus = smoothPlus - smoothPlus / period + plus[i];
    smoothMinus = smoothMinus - smoothMinus / period + minus[i];
    calculate(i);
  }
  const first = period * 2 - 1;
  adx[first] = dx.slice(period, first + 1).reduce((sum, value) => sum + value, 0) / period;
  for (let i = first + 1; i < bars.length; i++) adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  return { adx, plusDi, minusDi };
}

function efficiencyRatio(closes: number[], index: number, period = 20): number {
  if (index < period) return Number.NaN;
  let path = 0;
  for (let i = index - period + 1; i <= index; i++) path += Math.abs(closes[i] - closes[i - 1]);
  return path > EPSILON ? Math.abs(closes[index] - closes[index - period]) / path : 0;
}

function effectiveVolume(bar: TrendV3Bar): number {
  const real = Number(bar.real_volume);
  return Number.isFinite(real) && real > 0 ? real : Math.max(0, Number(bar.volume) || 0);
}

function volumeParticipation(bars: TrendV3Bar[], index: number) {
  const current = effectiveVolume(bars[index]);
  const currentDate = new Date(bars[index].bar_time);
  const slot = currentDate.getUTCHours() * 2 + (currentDate.getUTCMinutes() >= 30 ? 1 : 0);
  const sameSlot: number[] = [];
  for (let i = index - 1; i >= 0 && sameSlot.length < 20; i--) {
    const date = new Date(bars[i].bar_time);
    if (date.getUTCHours() * 2 + (date.getUTCMinutes() >= 30 ? 1 : 0) === slot) sameSlot.push(effectiveVolume(bars[i]));
  }
  const rolling = bars.slice(Math.max(0, index - 40), index).map(effectiveVolume).filter((value) => value > 0);
  const sample = sameSlot.length >= 5 ? sameSlot : rolling;
  const baseline = median(sample.filter((value) => value > 0));
  const ratio = baseline > EPSILON ? current / baseline : 1;
  const quality = smoothstep(0.65, 1.50, ratio);
  return { ratio, quality, sampleSize: sample.length, source: sameSlot.length >= 5 ? "same_session_slot" : "rolling" };
}

type Core = {
  direction: number; quality: number; adx: number; adxRise: number; efficiency: number;
  persistence: number; atrRatio: number; trueRangeRatio: number; rsi: number; extended: boolean;
};

function core(bars: TrendV3Bar[]): Core | null {
  if (bars.length < TREND_MIN_BARS) return null;
  const closes = bars.map((bar) => bar.close), index = bars.length - 1;
  const ema12 = ema(closes, 12), ema20 = ema(closes, 20), ema36 = ema(closes, 36);
  const { trueRange, atr } = volatility(bars, 14);
  const directional = dmi(bars, 14), rsiValues = rsi(closes, 14);
  const required = [ema12[index], ema12[index - 4], ema20[index], ema36[index], atr[index], atr[index - 1], directional.adx[index], directional.adx[index - 3], directional.plusDi[index], directional.minusDi[index], rsiValues[index]];
  if (!required.every(Number.isFinite) || atr[index] <= EPSILON) return null;
  const spread = clamp((ema12[index] - ema36[index]) / atr[index], -2, 2);
  const slope = clamp((ema12[index] - ema12[index - 4]) / (4 * atr[index]), -0.5, 0.5);
  const diTotal = directional.plusDi[index] + directional.minusDi[index];
  const balance = diTotal > EPSILON ? (directional.plusDi[index] - directional.minusDi[index]) / diTotal : 0;
  const direction = Math.tanh(0.90 * spread + 1.20 * slope + 0.70 * balance);
  const efficiency = efficiencyRatio(closes, index, 20);
  let matching = 0;
  const sign = Math.sign(direction);
  for (let i = index - 7; i <= index; i++) {
    const localSlope = ema12[i] - ema12[i - 1];
    if (Math.sign(localSlope) === sign) matching++;
  }
  const persistence = matching / 8;
  const adxRise = directional.adx[index] - directional.adx[index - 3];
  const quality = clamp(
    0.35 * smoothstep(18, 32, directional.adx[index]) +
    0.10 * smoothstep(-2, 4, adxRise) +
    0.35 * smoothstep(0.20, 0.60, efficiency) +
    0.20 * smoothstep(0.50, 0.875, persistence), 0, 1,
  );
  const atrBaseline = median(atr.filter(Number.isFinite).slice(-101, -1));
  const atrRatio = atrBaseline > EPSILON ? atr[index] / atrBaseline : 1;
  const trueRangeRatio = atr[index - 1] > EPSILON ? trueRange[index] / atr[index - 1] : 1;
  const extended = (rsiValues[index] > 72 || rsiValues[index] < 28) && Math.abs(closes[index] - ema20[index]) > 1.5 * atr[index];
  return { direction, quality, adx: directional.adx[index], adxRise, efficiency, persistence, atrRatio, trueRangeRatio, rsi: rsiValues[index], extended };
}

function regimeFor(value: Core, previous?: string): TrendV3Regime {
  if ((value.atrRatio > 1.8 && value.trueRangeRatio > 1.8) || value.trueRangeRatio > 2.5) return "volatility_shock";
  const trendEntry = value.quality >= 0.58 && value.adx >= 22 && value.efficiency >= 0.30;
  const trendHold = value.quality >= 0.45 && value.adx >= 18;
  const rangeEntry = value.quality <= 0.32 && value.adx <= 18 && value.efficiency <= 0.25;
  const rangeHold = value.quality <= 0.42 && value.adx <= 21;
  if (previous === "trending" && trendHold) return "trending";
  if (previous === "ranging" && rangeHold) return "ranging";
  if (trendEntry) return "trending";
  if (rangeEntry) return "ranging";
  return "transition";
}

export function computeTrendStrengthV3(
  anchorBars: TrendV3Bar[],
  contextBars: TrendV3Bar[] = [],
  previousRegime?: string,
): TrendV3Result {
  const anchor = core(anchorBars);
  if (!anchor) return {
    score: 0, direction: "neutral", strength: "neutral", confidence: 0, regime: "insufficient_data",
    source_bar_time: null, source_bar_times: {}, timeframe_scores: {}, components: { bars_ready: anchorBars.length },
  };
  const index = anchorBars.length - 1;
  const participation = volumeParticipation(anchorBars, index);
  const context = core(contextBars);
  const alignment = context ? (1 + Math.sign(anchor.direction || 1) * context.direction) / 2 : 0.5;
  const volumeMultiplier = 0.90 + 0.20 * participation.quality;
  const contextMultiplier = context ? 0.90 + 0.20 * alignment : 1;
  const regime = regimeFor(anchor, previousRegime);
  const cap = regime === "ranging" ? 25 : regime === "transition" ? 55 : regime === "volatility_shock" ? 45 : 100;
  const raw = 100 * Math.pow(Math.abs(anchor.direction), 0.80) * (0.35 + 0.65 * anchor.quality);
  const score = clamp(Math.sign(anchor.direction) * Math.min(cap, raw * volumeMultiplier * contextMultiplier), -100, 100);
  const absolute = Math.abs(score);
  const direction = absolute < 5 ? "neutral" : score > 0 ? "bullish" : "bearish";
  const strength = absolute < 15 ? "neutral" : absolute < 30 ? "weak" : absolute < 60 ? "moderate" : "strong";
  const sourceTime = anchorBars[index].bar_time;
  return {
    score: round(score, 2), direction, strength, confidence: round(anchor.quality), regime,
    source_bar_time: sourceTime,
    source_bar_times: { M30: sourceTime, ...(context ? { H1: contextBars[contextBars.length - 1].bar_time } : {}) },
    timeframe_scores: {
      M30: { score: round(score, 2), direction: round(anchor.direction), quality: round(anchor.quality), regime, source_bar_time: sourceTime },
      ...(context ? { H1: { direction: round(context.direction), quality: round(context.quality), alignment: round(alignment), source_bar_time: contextBars[contextBars.length - 1].bar_time } } : {}),
    },
    components: {
      anchor_direction: round(anchor.direction), regime_quality: round(anchor.quality), adx: round(anchor.adx, 2),
      adx_rise: round(anchor.adxRise, 2), efficiency_ratio: round(anchor.efficiency), persistence: round(anchor.persistence),
      atr_ratio: round(anchor.atrRatio), true_range_ratio: round(anchor.trueRangeRatio), rsi: round(anchor.rsi, 2),
      extended: anchor.extended, volume_ratio: round(participation.ratio), volume_quality: round(participation.quality),
      volume_baseline: participation.source, volume_sample_size: participation.sampleSize,
      h1_alignment: round(alignment), volume_multiplier: round(volumeMultiplier), context_multiplier: round(contextMultiplier), score_cap: cap,
    },
  };
}
