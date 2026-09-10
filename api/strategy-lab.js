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

function indicatorCandidate(snapshot) {
  const indicators = snapshot.rule_definition?.version === 2 ? snapshot.rule_definition.indicators || [] : [];
  for (let index = 0; index < indicators.length; index += 1) {
    const indicator = indicators[index];
    const params = indicator.params || {};
    if (indicator.indicator === 'ema_crossover') {
      const current = number(params.fast_period, 20);
      const slow = number(params.slow_period, 50);
      const next = Math.max(2, Math.min(slow - 1, Math.round(current * 0.85)));
      if (next !== current) return { path: `rule_definition.indicators.${index}.params.fast_period`, label: 'Fast EMA', current, proposed: next, effect: 'react sooner and create more opportunities', tradeoff: 'it can also react to more market noise' };
    }
    if (indicator.indicator === 'adx') {
      const current = number(params.minimum, 25); const next = Math.max(10, Math.round(current * 0.88));
      if (next !== current) return { path: `rule_definition.indicators.${index}.params.minimum`, label: 'Minimum ADX', current, proposed: next, effect: 'admit more developing trends', tradeoff: 'weaker trends can add false starts' };
    }
    if (indicator.indicator === 'breakout') {
      const current = number(params.lookback, 20); const next = Math.max(3, Math.round(current * 0.8));
      if (next !== current) return { path: `rule_definition.indicators.${index}.params.lookback`, label: 'Breakout lookback', current, proposed: next, effect: 'recognize breakouts earlier', tradeoff: 'shorter ranges can be easier to fake out' };
    }
    if (indicator.indicator === 'volume_confirmation') {
      const current = number(params.minimum_ratio, 1); const next = Math.max(0.5, rounded(current - 0.1, 0.05));
      if (next !== current) return { path: `rule_definition.indicators.${index}.params.minimum_ratio`, label: 'Minimum volume ratio', current, proposed: next, effect: 'allow setups with slightly less volume confirmation', tradeoff: 'lower participation can make moves less dependable' };
    }
    if (indicator.indicator === 'linearity') {
      const current = number(params.minimum, 0.6); const next = Math.max(0.3, rounded(current - 0.05, 0.05));
      if (next !== current) return { path: `rule_definition.indicators.${index}.params.minimum`, label: 'Minimum linearity', current, proposed: next, effect: 'accept somewhat less-perfect trends', tradeoff: 'choppier price paths may enter the strategy' };
    }
  }
  return null;
}

export function chooseCandidate(strategy, snapshot, trades, blocks) {
  const verified = trades.filter((trade) => trade.profit_verified !== false);
  const stopLosses = verified.filter((trade) => String(trade.close_reason || '').toLowerCase() === 'sl').length;
  const stopLossRate = verified.length ? stopLosses / verified.length : 0;
  const stopAtr = number(snapshot.exit_config?.stop_atr ?? snapshot.config?.stop_atr, 1.8);
  if (verified.length >= 5 && stopLossRate >= 0.35 && stopAtr < 4) {
    return { path: 'exit_config.stop_atr', label: 'ATR stop', current: stopAtr, proposed: Math.min(4, rounded(stopAtr * 1.2)), effect: 'give trades more room to absorb normal price noise', tradeoff: 'Lucre will need a smaller position size to keep account risk unchanged', evidence: `${stopLosses} of ${verified.length} verified trades closed at the stop` };
  }

  const topBlock = blocks.reasons[0];
  if (topBlock && blocks.blockedRate >= 0.35) {
    if (/cooldown/i.test(topBlock.reason) && snapshot.cooldown_minutes > 0) {
      return { path: 'cooldown_minutes', label: 'Cooldown', current: snapshot.cooldown_minutes, proposed: Math.max(0, Math.round(snapshot.cooldown_minutes * 0.75)), effect: 'allow the strategy to reconsider the market sooner', tradeoff: 'entries may cluster more tightly', evidence: `${topBlock.count} recent signals were blocked by cooldown` };
    }
    if (/spread/i.test(topBlock.reason) && snapshot.max_spread_points) {
      return { path: 'max_spread_points', label: 'Maximum spread', current: snapshot.max_spread_points, proposed: Math.ceil(snapshot.max_spread_points * 1.15), effect: 'allow more setups during wider spreads', tradeoff: 'execution costs can rise', evidence: `${topBlock.count} recent signals were blocked by the spread limit` };
    }
  }

  const indicator = indicatorCandidate(snapshot);
  if (indicator) return { ...indicator, evidence: verified.length ? `${verified.length} verified trades and ${blocks.totalSignals} recent signals were reviewed` : `${blocks.totalSignals} recent signals were reviewed` };
  return null;
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
    body: JSON.stringify({ strategy_id: strategyId, symbols, definition_snapshot: definitionSnapshot }),
  });
}

export function comparisonDecision(current, candidate) {
  const baseValidation = number(current.validation_expectancy_r, -Infinity);
  const nextValidation = number(candidate.validation_expectancy_r, -Infinity);
  const enoughTrades = number(candidate.trade_count, 0) >= 5;
  const controlledDrawdown = number(candidate.max_drawdown_r, Infinity) <= Math.max(1, number(current.max_drawdown_r, 0) * 1.2);
  return enoughTrades && controlledDrawdown && nextValidation > baseValidation + 0.02;
}

function fallbackSummary(strategy, recommendation, current, candidate, accepted, blocks) {
  const delta = Math.round((number(candidate.win_rate, 0) - number(current.win_rate, 0)) * 100);
  const blockNote = blocks.blockedSignals ? ` I also reviewed ${blocks.blockedSignals} blocked signals; ${blocks.reasons[0]?.reason || 'policy checks'} was the most common reason.` : '';
  if (!accepted) return `I tested changing ${recommendation.label} from ${recommendation.current} to ${recommendation.proposed}, but it did not improve validation results enough to justify a change. Keep ${strategy.name} at its current setting for now.${blockNote}`;
  return `${recommendation.evidence}. Testing ${recommendation.label} at ${recommendation.proposed} instead of ${recommendation.current} changed modeled win rate by ${delta >= 0 ? '+' : ''}${delta} points and improved validation expectancy. This may ${recommendation.effect}, but ${recommendation.tradeoff}.${blockNote}`;
}

async function coachSummary({ userId, strategy, recommendation, current, candidate, accepted, blocks }) {
  const fallback = fallbackSummary(strategy, recommendation, current, candidate, accepted, blocks);
  if (!HAS_DIRECT_OPENAI && !HAS_GATEWAY_AUTH) return fallback;
  try {
    const result = await generateText({
      model: HAS_DIRECT_OPENAI ? openai(DIRECT_MODEL) : GATEWAY_MODEL,
      maxRetries: 0,
      providerOptions: {
        openai: { store: false, reasoningEffort: 'low', textVerbosity: 'low', safetyIdentifier: crypto.createHash('sha256').update(userId).digest('hex') },
      },
      system: 'You are Aurelia, a concise trading coach for beginners. Use plain text only. No markdown, headings, bullets, symbols, promises, or jargon. Explain one finding and one next step in no more than three short paragraphs. Never claim a backtest guarantees future results.',
      prompt: `Rewrite this verified Strategy Lab result naturally without changing any numbers or conclusions:\n${fallback}\nCurrent backtest: ${JSON.stringify({ trades: current.trade_count, winRate: current.win_rate, expectancyR: current.expectancy_r, validationExpectancyR: current.validation_expectancy_r, maxDrawdownR: current.max_drawdown_r })}\nTested backtest: ${JSON.stringify({ trades: candidate.trade_count, winRate: candidate.win_rate, expectancyR: candidate.expectancy_r, validationExpectancyR: candidate.validation_expectancy_r, maxDrawdownR: candidate.max_drawdown_r })}`,
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
    if (!user?.id || !strategyId || !terminalId) return json(res, 400, { error: 'invalid_request' });

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
    const recommendation = chooseCandidate(strategy, snapshot, strategyTrades, blocks);
    if (!recommendation) return json(res, 200, { status: 'insufficient_evidence', strategy: { name: strategy.name }, summary: `I reviewed ${strategy.name}, but there is not enough usable evidence to recommend changing a setting yet. Keep collecting verified trades and signals, then run this check again.`, blocks });
    if (strategy.signal_source && strategy.signal_source !== 'internal') return json(res, 200, { status: 'external_diagnostic_only', strategy: { name: strategy.name }, recommendation, summary: `I found a setting worth investigating, but ${strategy.name} receives external entries and Lucre cannot honestly recreate those historical triggers yet. I reviewed the blocked-signal pattern, but I will not draw a fake comparison line.`, blocks });

    const proposedSnapshot = setPath(snapshot, recommendation.path, recommendation.proposed);
    const [current, candidate] = await Promise.all([
      runBacktest(token, strategyId, snapshot.symbols, snapshot),
      runBacktest(token, strategyId, proposedSnapshot.symbols, proposedSnapshot),
    ]);
    const accepted = comparisonDecision(current, candidate);
    const summary = await coachSummary({ userId: user.id, strategy, recommendation, current, candidate, accepted, blocks });
    const riskAmount = number(terminals[0].balance, 0) * number(strategy.risk_percent, 0.25) / 100;
    console.info('strategy-lab completed', { strategyId, accepted, currentTrades: current.trade_count, candidateTrades: candidate.trade_count, blockedSignals: blocks.blockedSignals });
    return json(res, 200, {
      status: accepted ? 'recommendation' : 'keep_current',
      strategy: { name: strategy.name, timeframe: strategy.timeframe },
      summary,
      recommendation: { ...recommendation, accepted },
      blocks,
      comparison: {
        current: { tradeCount: current.trade_count, winRate: current.win_rate, expectancyR: current.expectancy_r, validationExpectancyR: current.validation_expectancy_r, maxDrawdownR: current.max_drawdown_r, series: current.result?.series || [] },
        candidate: { tradeCount: candidate.trade_count, winRate: candidate.win_rate, expectancyR: candidate.expectancy_r, validationExpectancyR: candidate.validation_expectancy_r, maxDrawdownR: candidate.max_drawdown_r, series: candidate.result?.series || [] },
        riskAmount,
        modeledCosts: false,
      },
    });
  } catch (error) {
    console.error('strategy-lab failure', { message: error?.message || String(error) });
    return json(res, 500, { error: 'strategy_lab_failed', message: 'Aurelia could not complete the Strategy Lab comparison. Please try again.' });
  }
}
