import crypto from 'node:crypto';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qxlfnscmrhwfcpattqxa.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF4bGZuc2Ntcmh3ZmNwYXR0cXhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5MTI5NjYsImV4cCI6MjEwMjQ4ODk2Nn0.7nmSfQlFKyuYtej2i9TcQQVIjkeauqPA4iTGessQHWA';
const DIRECT_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4';
const GATEWAY_MODEL = process.env.AI_GATEWAY_MODEL || `openai/${DIRECT_MODEL}`;
const HAS_DIRECT_OPENAI = Boolean(process.env.OPENAI_API_KEY);
const HAS_GATEWAY_AUTH = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
const GOALS = {
  risk_management: 'Improve risk management',
  profitability: 'Increase profitability',
  more_positions: 'Take more positions',
  win_rate: 'Improve win rate',
};

export const config = { maxDuration: 300 };

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function bearerToken(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

async function supabaseRequest(path, token, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.error || `Lucre data request failed (${response.status})`);
  return payload;
}

function query(table, params, token) {
  return supabaseRequest(`/rest/v1/${table}?${new URLSearchParams(params)}`, token);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rounded(value, step = 0.1) {
  return Math.round(value / step) * step;
}

function plain(value) {
  return String(value || '')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[\*_~]/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function netTrade(trade) {
  return trade.net_profit != null && Number.isFinite(Number(trade.net_profit))
    ? Number(trade.net_profit)
    : Number(trade.profit || 0);
}

export function blockSummary(signals) {
  const blocked = signals.filter((signal) => signal.policy_decision === 'block');
  const reasons = new Map();
  blocked.forEach((signal) => {
    const reason = String(signal.block_reason || 'Other policy or risk guardrail').trim();
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
  });
  return {
    totalSignals: signals.length,
    blockedSignals: blocked.length,
    blockedRate: signals.length ? blocked.length / signals.length : 0,
    reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 5),
  };
}

export function strategySnapshot(strategy) {
  return {
    kind: strategy.kind,
    timeframe: strategy.timeframe,
    symbols: strategy.symbols || [],
    config: clone(strategy.config || {}),
    exit_config: clone(strategy.exit_config || {}),
    rule_definition: clone(strategy.rule_definition || {}),
    direction_mode: strategy.direction_mode || 'both',
    allowed_sessions: strategy.allowed_sessions || [],
    cooldown_minutes: number(strategy.cooldown_minutes, 0),
    max_spread_points: strategy.max_spread_points == null ? null : number(strategy.max_spread_points, null),
  };
}

function indicatorCandidates(snapshot, evidence) {
  const candidates = [];
  const add = (path, label, current, proposed, effect, tradeoff) => {
    if (!Number.isFinite(Number(current)) || !Number.isFinite(Number(proposed)) || Number(current) === Number(proposed)) return;
    candidates.push({ path, label, current, proposed, effect, tradeoff, evidence });
  };
  const indicators = snapshot.rule_definition?.version === 2 ? snapshot.rule_definition.indicators || [] : [];
  for (let index = 0; index < indicators.length; index += 1) {
    const indicator = indicators[index];
    const params = indicator.params || {};
    if (indicator.indicator === 'ema_crossover') {
      const current = number(params.fast_period, 20);
      const slow = number(params.slow_period, 50);
      add(`rule_definition.indicators.${index}.params.fast_period`, 'Fast EMA', current, Math.max(2, Math.min(slow - 1, Math.round(current * 0.85))), 'react sooner and create more opportunities', 'it can also react to more market noise');
      add(`rule_definition.indicators.${index}.params.fast_period`, 'Fast EMA', current, Math.max(2, Math.min(slow - 1, Math.round(current * 1.15))), 'filter more short-lived moves', 'entries can arrive later');
    }
    if (indicator.indicator === 'adx') {
      const current = number(params.minimum, 25);
      add(`rule_definition.indicators.${index}.params.minimum`, 'Minimum ADX', current, Math.max(10, Math.round(current * 0.88)), 'admit more developing trends', 'weaker trends can add false starts');
      add(`rule_definition.indicators.${index}.params.minimum`, 'Minimum ADX', current, Math.min(60, Math.round(current * 1.12)), 'demand stronger trend confirmation', 'fewer setups may qualify');
    }
    if (indicator.indicator === 'breakout') {
      const current = number(params.lookback, 20);
      add(`rule_definition.indicators.${index}.params.lookback`, 'Breakout lookback', current, Math.max(3, Math.round(current * 0.8)), 'recognize breakouts earlier', 'shorter ranges can be easier to fake out');
      add(`rule_definition.indicators.${index}.params.lookback`, 'Breakout lookback', current, Math.min(200, Math.round(current * 1.2)), 'require a more meaningful range break', 'signals may arrive later');
    }
    if (indicator.indicator === 'volume_confirmation') {
      const current = number(params.minimum_ratio, 1);
      add(`rule_definition.indicators.${index}.params.minimum_ratio`, 'Minimum volume ratio', current, Math.max(0.5, rounded(current - 0.1, 0.05)), 'allow setups with slightly less volume confirmation', 'lower participation can make moves less dependable');
      add(`rule_definition.indicators.${index}.params.minimum_ratio`, 'Minimum volume ratio', current, Math.min(3, rounded(current + 0.1, 0.05)), 'require stronger market participation', 'fewer setups may qualify');
    }
    if (indicator.indicator === 'linearity') {
      const current = number(params.minimum, 0.6);
      add(`rule_definition.indicators.${index}.params.minimum`, 'Minimum linearity', current, Math.max(0.3, rounded(current - 0.05, 0.05)), 'accept somewhat less-perfect trends', 'choppier price paths may enter the strategy');
      add(`rule_definition.indicators.${index}.params.minimum`, 'Minimum linearity', current, Math.min(0.95, rounded(current + 0.05, 0.05)), 'favor cleaner directional movement', 'fewer trends may qualify');
    }
  }
  return candidates;
}

function goalPriority(candidate, goal) {
  const text = `${candidate.path} ${candidate.effect}`.toLowerCase();
  if (goal === 'more_positions') return /allow|admit|recover|sooner|cooldown|max_spread|lookback/.test(text) ? 0 : /target_r|stop_atr/.test(text) ? 2 : 1;
  if (goal === 'risk_management') return /stop_atr|breakeven|trailing|protect|filter|demand|favor|cut/.test(text) ? 0 : 1;
  if (goal === 'win_rate') return /filter|demand|favor|protect|bank winners|target_r/.test(text) ? 0 : /allow|admit|recover/.test(text) ? 2 : 1;
  return 0;
}

export function chooseCandidates(strategy, snapshot, trades, blocks, goal = 'profitability', limit = 10) {
  const verified = trades.filter((trade) => trade.profit_verified !== false);
  const stopLosses = verified.filter((trade) => String(trade.close_reason || '').toLowerCase() === 'sl').length;
  const stopLossRate = verified.length ? stopLosses / verified.length : 0;
  const evidence = verified.length ? `${verified.length} verified trades and ${blocks.totalSignals} recent signals were reviewed` : `${blocks.totalSignals} recent signals were reviewed`;
  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    if (!candidate || !Number.isFinite(Number(candidate.current)) || !Number.isFinite(Number(candidate.proposed))) return;
    const key = `${candidate.path}:${candidate.proposed}`;
    if (Number(candidate.current) === Number(candidate.proposed) || seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };
  const stopAtr = number(snapshot.exit_config?.stop_atr ?? snapshot.config?.stop_atr, 1.8);
  const targetR = number(snapshot.exit_config?.target_r ?? snapshot.config?.target_r, 2.2);
  const breakevenR = number(snapshot.exit_config?.breakeven_r, 1);
  const trailingStartR = number(snapshot.exit_config?.trailing_start_r, 1.5);
  const trailAtr = number(snapshot.exit_config?.trail_atr, 1.5);
  const stopEvidence = `${stopLosses} of ${verified.length} verified trades closed at the stop`;
  if (verified.length >= 5 && stopLossRate >= 0.35) {
    add({ path: 'exit_config.stop_atr', label: 'ATR stop', current: stopAtr, proposed: Math.min(4, rounded(stopAtr * 1.15)), effect: 'give trades more room for normal price noise', tradeoff: 'position size must shrink to keep account risk unchanged', evidence: stopEvidence });
    add({ path: 'exit_config.stop_atr', label: 'ATR stop', current: stopAtr, proposed: Math.min(4, rounded(stopAtr * 1.3)), effect: 'give volatile entries substantially more room', tradeoff: 'position size must shrink further', evidence: stopEvidence });
    add({ path: 'exit_config.breakeven_r', label: 'Breakeven trigger', current: breakevenR, proposed: Math.min(5, rounded(breakevenR * 1.2)), effect: 'delay moving the stop to entry', tradeoff: 'some early unrealized gains can reverse', evidence: stopEvidence });
    add({ path: 'exit_config.trailing_start_r', label: 'Trailing start', current: trailingStartR, proposed: Math.min(8, rounded(trailingStartR * 1.2)), effect: 'let the trade develop before trailing begins', tradeoff: 'less profit is protected early', evidence: stopEvidence });
    add({ path: 'exit_config.trail_atr', label: 'Trailing distance', current: trailAtr, proposed: Math.min(8, rounded(trailAtr * 1.2)), effect: 'make the trailing stop less sensitive to noise', tradeoff: 'more open profit can be given back', evidence: stopEvidence });
    add({ path: 'exit_config.target_r', label: 'Profit target', current: targetR, proposed: Math.max(0.5, rounded(targetR * 0.85)), effect: 'bank winners sooner', tradeoff: 'each winning trade earns fewer R', evidence: stopEvidence });
  }

  const topBlock = blocks.reasons[0];
  if (topBlock && blocks.blockedRate >= 0.35) {
    if (/cooldown/i.test(topBlock.reason) && snapshot.cooldown_minutes > 0) {
      add({ path: 'cooldown_minutes', label: 'Cooldown', current: snapshot.cooldown_minutes, proposed: Math.max(0, Math.round(snapshot.cooldown_minutes * 0.75)), effect: 'allow the strategy to reconsider the market sooner', tradeoff: 'entries may cluster more tightly', evidence: `${topBlock.count} recent signals were blocked by cooldown` });
      add({ path: 'cooldown_minutes', label: 'Cooldown', current: snapshot.cooldown_minutes, proposed: Math.max(0, Math.round(snapshot.cooldown_minutes * 0.5)), effect: 'recover more opportunities blocked by timing', tradeoff: 'entries can cluster much more tightly', evidence: `${topBlock.count} recent signals were blocked by cooldown` });
    }
    if (/spread/i.test(topBlock.reason) && snapshot.max_spread_points) {
      add({ path: 'max_spread_points', label: 'Maximum spread', current: snapshot.max_spread_points, proposed: Math.ceil(snapshot.max_spread_points * 1.15), effect: 'allow more setups during wider spreads', tradeoff: 'execution costs can rise', evidence: `${topBlock.count} recent signals were blocked by the spread limit` });
      add({ path: 'max_spread_points', label: 'Maximum spread', current: snapshot.max_spread_points, proposed: Math.ceil(snapshot.max_spread_points * 1.3), effect: 'recover more spread-blocked setups', tradeoff: 'execution costs can rise further', evidence: `${topBlock.count} recent signals were blocked by the spread limit` });
    }
  }

  indicatorCandidates(snapshot, evidence).forEach(add);
  add({ path: 'exit_config.target_r', label: 'Profit target', current: targetR, proposed: Math.min(10, rounded(targetR * 1.15)), effect: 'let strong winners run farther', tradeoff: 'fewer trades may reach the full target', evidence });
  add({ path: 'exit_config.stop_atr', label: 'ATR stop', current: stopAtr, proposed: Math.max(0.5, rounded(stopAtr * 0.85)), effect: 'cut invalid setups sooner', tradeoff: 'normal market noise can stop more trades', evidence });
  add({ path: 'exit_config.breakeven_r', label: 'Breakeven trigger', current: breakevenR, proposed: Math.max(0.25, rounded(breakevenR * 0.8)), effect: 'protect the entry sooner', tradeoff: 'small pullbacks may close otherwise healthy trades', evidence });
  add({ path: 'exit_config.trailing_start_r', label: 'Trailing start', current: trailingStartR, proposed: Math.max(0.5, rounded(trailingStartR * 0.8)), effect: 'begin protecting open profit sooner', tradeoff: 'the trade gets less room to develop', evidence });
  add({ path: 'exit_config.trail_atr', label: 'Trailing distance', current: trailAtr, proposed: Math.max(0.5, rounded(trailAtr * 0.8)), effect: 'lock in favorable movement more tightly', tradeoff: 'normal volatility can trigger earlier exits', evidence });
  return {
    issue: verified.length >= 5 && stopLossRate >= 0.35
      ? `frequent stop-outs (${Math.round(stopLossRate * 100)}%)`
      : topBlock && blocks.blockedRate >= 0.35
        ? `a high blocked-signal rate (${Math.round(blocks.blockedRate * 100)}%)`
        : 'weak strategy efficiency',
    candidates: candidates
      .map((candidate, index) => ({ candidate, index }))
      .sort((left, right) => goalPriority(left.candidate, goal) - goalPriority(right.candidate, goal) || left.index - right.index)
      .slice(0, Math.max(1, Math.min(10, limit)))
      .map(({ candidate }) => candidate),
  };
}

export function chooseCandidate(strategy, snapshot, trades, blocks) {
  return chooseCandidates(strategy, snapshot, trades, blocks, 'profitability', 1).candidates[0] || null;
}

export function setPath(source, path, value) {
  const copy = clone(source); const segments = path.split('.'); let target = copy;
  for (let index = 0; index < segments.length - 1; index += 1) target = target[segments[index]];
  target[segments.at(-1)] = value;
  if (path === 'exit_config.stop_atr') copy.config.stop_atr = value;
  return copy;
}

async function runBacktest(token, strategyId, symbols, definitionSnapshot) {
  return supabaseRequest('/functions/v1/strategy-backtest', token, {
    method: 'POST',
    body: JSON.stringify({ strategy_id: strategyId, symbols, definition_snapshot: definitionSnapshot, persist_run: false }),
  });
}

export function comparisonDecision(current, candidate, goal = 'profitability') {
  const baseValidation = number(current.validation_expectancy_r, -Infinity);
  const nextValidation = number(candidate.validation_expectancy_r, -Infinity);
  const validationGain = nextValidation - baseValidation;
  const winRateGain = number(candidate.win_rate, 0) - number(current.win_rate, 0);
  const expectancyGain = number(candidate.expectancy_r, -Infinity) - number(current.expectancy_r, -Infinity);
  const enoughTrades = number(candidate.trade_count, 0) >= Math.max(5, Math.floor(number(current.trade_count, 0) * 0.5));
  const drawdownRatio = number(candidate.max_drawdown_r, Infinity) / Math.max(0.01, number(current.max_drawdown_r, 0));
  if (!enoughTrades || nextValidation <= 0) return false;
  if (goal === 'risk_management') return drawdownRatio <= 0.85 && nextValidation >= baseValidation - 0.02;
  if (goal === 'more_positions') return number(candidate.trade_count, 0) >= Math.max(number(current.trade_count, 0) + 3, number(current.trade_count, 0) * 1.15) && drawdownRatio <= 1.3 && nextValidation >= baseValidation - 0.02;
  if (goal === 'win_rate') return winRateGain >= 0.05 && drawdownRatio <= 1.2 && nextValidation >= baseValidation - 0.02;
  const meaningfulGain = validationGain >= 0.05 || (validationGain >= 0.03 && winRateGain >= 0.03 && expectancyGain >= 0.03);
  return drawdownRatio <= 1.15 && meaningfulGain;
}

function candidateScore(current, candidate, goal = 'profitability') {
  const validationGain = number(candidate.validation_expectancy_r, -10) - number(current.validation_expectancy_r, -10);
  const expectancyGain = number(candidate.expectancy_r, -10) - number(current.expectancy_r, -10);
  const winRateGain = number(candidate.win_rate, 0) - number(current.win_rate, 0);
  const drawdownChange = number(candidate.max_drawdown_r, 0) - number(current.max_drawdown_r, 0);
  const tradeGain = number(candidate.trade_count, 0) - number(current.trade_count, 0);
  const drawdownImprovement = number(current.max_drawdown_r, 0) - number(candidate.max_drawdown_r, 0);
  if (goal === 'risk_management') return drawdownImprovement * 30 + validationGain * 45 + expectancyGain * 8;
  if (goal === 'more_positions') return tradeGain * 5 + validationGain * 45 + expectancyGain * 8 - Math.max(0, drawdownChange) * 3;
  if (goal === 'win_rate') return winRateGain * 120 + validationGain * 35 + expectancyGain * 8 - Math.max(0, drawdownChange) * 2;
  return validationGain * 100 + expectancyGain * 18 + winRateGain * 12 - Math.max(0, drawdownChange) * 2;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = Array(items.length); let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor; cursor += 1;
      try { results[index] = await worker(items[index], index); }
      catch (error) { results[index] = { error: error?.message || String(error) }; }
    }
  });
  await Promise.all(runners);
  return results;
}

export function formatPercent(value, digits = 0) {
  return `${(number(value, 0) * 100).toFixed(digits).replace(/\.0+$/, '')}%`;
}

function fallbackSummary(strategy, recommendation, current, candidate, accepted, blocks, candidatesTested, issue, goal) {
  const currentWin = formatPercent(current.win_rate);
  const candidateWin = formatPercent(candidate.win_rate);
  const blockNote = blocks.blockedSignals ? ` I also checked ${blocks.blockedSignals} blocked signals. ${blocks.reasons[0]?.reason || 'A policy check'} was the most common reason.` : '';
  if (!accepted) return `I tested ${candidatesTested} changes to ${GOALS[goal].toLowerCase()}. None made a meaningful improvement without creating a new problem, so I would keep ${strategy.name} where it is for now.${blockNote}`;
  return `I tested ${candidatesTested} changes to ${GOALS[goal].toLowerCase()}. The best result changed ${recommendation.label} from ${recommendation.current} to ${recommendation.proposed}. Modeled win rate moved from ${currentWin} to ${candidateWin}, and the result passed the safety check. This should ${recommendation.effect}, although ${recommendation.tradeoff}.${blockNote} Review the change, then forward test it before relying on it.`;
}

async function coachSummary({ userId, strategy, recommendation, current, candidate, accepted, blocks, candidatesTested, issue, goal }) {
  const fallback = fallbackSummary(strategy, recommendation, current, candidate, accepted, blocks, candidatesTested, issue, goal);
  if (!HAS_DIRECT_OPENAI && !HAS_GATEWAY_AUTH) return fallback;
  try {
    const result = await generateText({
      model: HAS_DIRECT_OPENAI ? openai(DIRECT_MODEL) : GATEWAY_MODEL,
      maxRetries: 0,
      providerOptions: {
        openai: { store: false, reasoningEffort: 'low', textVerbosity: 'low', safetyIdentifier: crypto.createHash('sha256').update(userId).digest('hex') },
      },
      system: 'You are Aurelia, a warm and concise trading coach for beginners. Write like a helpful person speaking naturally. Use plain text only, no markdown, headings, bullets, symbols, raw ratios, or jargon. Keep it to one or two short paragraphs. Every win rate or rate must be written as a true percentage such as 58%, never 0.58%. State the tested setting change, the useful result, the tradeoff, and one practical next step. Never claim a backtest guarantees future results.',
      prompt: `Rewrite this verified Strategy Lab result naturally without changing any numbers or conclusions:\n${fallback}\nGoal: ${GOALS[goal]}. Current win rate: ${formatPercent(current.win_rate)}. Tested win rate: ${formatPercent(candidate.win_rate)}. Current trades: ${current.trade_count}. Tested trades: ${candidate.trade_count}.`,
    });
    return plain(result.text) || fallback;
  } catch (error) {
    console.error('strategy-lab summary failure', { message: error?.message || String(error) });
    return fallback;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  try {
    const token = bearerToken(req);
    if (!token) return json(res, 401, { error: 'authentication_required' });
    const user = await supabaseRequest('/auth/v1/user', token);
    const strategyId = String(req.body?.strategy_id || '');
    const terminalId = String(req.body?.terminal_id || '');
    const goal = String(req.body?.goal || 'profitability');
    if (!user?.id || !strategyId || !terminalId || !GOALS[goal]) return json(res, 400, { error: 'invalid_request' });

    const [strategies, terminals] = await Promise.all([
      query('strategies', { select: '*', id: `eq.${strategyId}`, terminal_id: `eq.${terminalId}`, limit: '1' }, token),
      query('mt5_terminals', { select: 'id,balance', id: `eq.${terminalId}`, user_id: `eq.${user.id}`, limit: '1' }, token),
    ]);
    const strategy = strategies[0];
    if (!strategy || !terminals.length) return json(res, 403, { error: 'strategy_not_available' });

    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [trades, signals] = await Promise.all([
      query('trade_history', { select: 'strategy_id,strategy_name_at_entry,profit,net_profit,close_reason,mfe_r,mae_r,profit_verified,close_time', terminal_id: `eq.${terminalId}`, close_time: `gte.${since}`, order: 'close_time.desc', limit: '1000' }, token),
      query('signals', { select: 'strategy_id,policy_decision,block_reason,generated_at', terminal_id: `eq.${terminalId}`, strategy_id: `eq.${strategyId}`, generated_at: `gte.${since}`, order: 'generated_at.desc', limit: '1000' }, token),
    ]);
    const strategyTrades = trades.filter((trade) => trade.strategy_id === strategyId || String(trade.strategy_name_at_entry || '').trim().toLowerCase() === String(strategy.name || '').trim().toLowerCase());
    const blocks = blockSummary(signals);
    const snapshot = strategySnapshot(strategy);
    const diagnostic = chooseCandidates(strategy, snapshot, strategyTrades, blocks, goal, 10);
    if (!diagnostic.candidates.length) return json(res, 200, { status: 'insufficient_evidence', strategy: { name: strategy.name }, summary: `I reviewed ${strategy.name}, but there is not enough usable evidence to build a responsible test set yet. Keep collecting verified trades and signals, then run this check again.`, blocks });
    if (strategy.signal_source && strategy.signal_source !== 'internal') return json(res, 200, { status: 'external_diagnostic_only', strategy: { name: strategy.name }, goal, goalLabel: GOALS[goal], candidatesTested: 0, summary: `I found settings worth investigating, but ${strategy.name} receives external entries and Lucre cannot honestly replay those historical triggers yet. I reviewed the blocked signals, but I will not make up a recommendation.`, blocks });

    const current = await runBacktest(token, strategyId, snapshot.symbols, snapshot);
    const attempts = await mapWithConcurrency(diagnostic.candidates, 3, async (recommendation) => {
      const proposedSnapshot = setPath(snapshot, recommendation.path, recommendation.proposed);
      const result = await runBacktest(token, strategyId, proposedSnapshot.symbols, proposedSnapshot);
      return { recommendation, result };
    });
    const completed = attempts.filter((attempt) => attempt?.result);
    if (!completed.length) throw new Error('No candidate backtest completed successfully.');
    completed.forEach((attempt) => { attempt.score = candidateScore(current, attempt.result, goal); attempt.accepted = comparisonDecision(current, attempt.result, goal); });
    completed.sort((left, right) => right.score - left.score);
    const winner = completed.find((attempt) => attempt.accepted) || completed[0];
    const recommendation = winner.recommendation;
    const candidate = winner.result;
    const accepted = winner.accepted;
    const candidatesTested = completed.length;
    const summary = await coachSummary({ userId: user.id, strategy, recommendation, current, candidate, accepted, blocks, candidatesTested, issue: diagnostic.issue, goal });
    console.info('strategy-lab completed', { strategyId, accepted, candidatesTested, failedCandidates: attempts.length - completed.length, currentTrades: current.trade_count, candidateTrades: candidate.trade_count, blockedSignals: blocks.blockedSignals });
    return json(res, 200, {
      status: accepted ? 'recommendation' : 'keep_current',
      strategy: { name: strategy.name, timeframe: strategy.timeframe },
      goal,
      goalLabel: GOALS[goal],
      summary,
      recommendation: { ...recommendation, accepted },
      issue: diagnostic.issue,
      candidatesTested,
      failedCandidates: attempts.length - completed.length,
      blocks,
      result: { currentWinRate: formatPercent(current.win_rate), testedWinRate: formatPercent(candidate.win_rate), currentTrades: current.trade_count, testedTrades: candidate.trade_count },
    });
  } catch (error) {
    console.error('strategy-lab failure', { message: error?.message || String(error) });
    return json(res, 500, { error: 'strategy_lab_failed', message: 'Aurelia could not complete the Strategy Lab comparison. Please try again.' });
  }
}
