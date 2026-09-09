import crypto from 'node:crypto';
import { openai } from '@ai-sdk/openai';
import { ToolLoopAgent, isStepCount, tool } from 'ai';
import { z } from 'zod';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qxlfnscmrhwfcpattqxa.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF4bGZuc2Ntcmh3ZmNwYXR0cXhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5MTI5NjYsImV4cCI6MjEwMjQ4ODk2Nn0.7nmSfQlFKyuYtej2i9TcQQVIjkeauqPA4iTGessQHWA';
const DIRECT_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4';
const GATEWAY_MODEL = process.env.AI_GATEWAY_MODEL || `openai/${DIRECT_MODEL}`;
const HAS_DIRECT_OPENAI = Boolean(process.env.OPENAI_API_KEY);
const HAS_GATEWAY_AUTH = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
const MODEL = HAS_DIRECT_OPENAI ? DIRECT_MODEL : GATEWAY_MODEL;
const requestWindows = new Map();

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function bearerToken(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

async function supabaseFetch(path, token) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Data request failed (${response.status}): ${detail.slice(0, 240)}`);
  }
  return response.json();
}

function query(table, params, token) {
  return supabaseFetch(`/rest/v1/${table}?${new URLSearchParams(params)}`, token);
}

function netPosition(position) {
  return Number(position.unrealized_pl || 0) + Number(position.swap || 0)
    + Number(position.commission || 0) + Number(position.fee || 0);
}

function netTrade(trade) {
  if (trade.net_profit != null && Number.isFinite(Number(trade.net_profit))) return Number(trade.net_profit);
  return Number(trade.profit || 0) + Number(trade.commission || 0)
    + Number(trade.swap || 0) + Number(trade.fee || 0);
}

function rateLimited(userId) {
  const now = Date.now();
  const current = requestWindows.get(userId) || [];
  const active = current.filter((timestamp) => now - timestamp < 60_000);
  if (active.length >= 12) return true;
  active.push(now);
  requestWindows.set(userId, active);
  return false;
}

function buildAgent({ token, terminalId, userId }) {
  const scoped = (table, params) => query(table, { ...params, terminal_id: `eq.${terminalId}` }, token);

  return new ToolLoopAgent({
    model: HAS_DIRECT_OPENAI ? openai(DIRECT_MODEL) : GATEWAY_MODEL,
    instructions: `You are Lucre AI, a read-only trading performance analyst inside Lucre Hub.
Use tools before making claims about this user's account. Every tool is already restricted to the authenticated user's selected MT5 terminal.
Never claim guaranteed returns or certainty. Separate observed facts from interpretations and recommendations. Use net P/L after commission, swap, and fees. Mention the sample size and date range when relevant. Call out missing, stale, or unverified data instead of inventing an answer.
Keep responses practical and concise. Explain trading and statistics in plain language. Never reveal IDs, tokens, private implementation details, or raw tool payloads.
This v1 cannot place, modify, or close trades and cannot change strategies or risk settings. If asked to make a change, explain what you recommend and clearly say the user must apply it manually for now.`,
    stopWhen: isStepCount(6),
    maxOutputTokens: 900,
    providerOptions: {
      openai: {
        store: false,
        safetyIdentifier: crypto.createHash('sha256').update(userId).digest('hex'),
      },
      ...(!HAS_DIRECT_OPENAI ? {
        gateway: {
          user: crypto.createHash('sha256').update(userId).digest('hex'),
          tags: ['feature:lucre-ai', 'version:v1'],
        },
      } : {}),
    },
    tools: {
      accountSnapshot: tool({
        description: 'Read the selected MT5 terminal account totals and current open positions.',
        inputSchema: z.object({}),
        strict: true,
        execute: async () => {
          const [terminals, positions] = await Promise.all([
            query('mt5_terminals', {
              select: 'id,label,status,last_heartbeat_at,balance,equity,margin_level,floating_pl,positions_profit,positions_swap,positions_commission,positions_fee,floating_pl_reported_at',
              id: `eq.${terminalId}`,
              limit: '1',
            }, token),
            scoped('positions', {
              select: 'symbol,side,volume,open_price,current_price,unrealized_pl,swap,commission,fee,status,open_time,strategy_name_at_entry,origin_detail',
              status: 'neq.closed',
              order: 'open_time.desc',
              limit: '200',
            }),
          ]);
          const open = positions.filter((position) => position.status !== 'closed');
          return {
            terminal: terminals[0] || null,
            openPositionCount: open.length,
            calculatedNetFloatingPl: open.reduce((sum, position) => sum + netPosition(position), 0),
            positions: open.map((position) => ({ ...position, net_pl: netPosition(position) })),
          };
        },
      }),
      strategyPerformance: tool({
        description: 'Analyze signal and closed-trade performance for one strategy or all strategies over a requested number of days.',
        inputSchema: z.object({
          strategyName: z.string().max(120).nullable().describe('Exact or partial strategy name, or null to analyze all strategies'),
          days: z.number().int().min(1).max(3650).describe('Number of trailing calendar days to analyze'),
        }),
        strict: true,
        execute: async ({ strategyName, days }) => {
          const strategies = await scoped('strategies', {
            select: 'id,name,kind,timeframe,enabled,delivery_mode,symbols,run_mode,signal_source',
            order: 'created_at.asc',
            limit: '200',
          });
          const matched = strategyName
            ? strategies.filter((item) => item.name.toLowerCase().includes(strategyName.toLowerCase()))
            : strategies;
          const ids = matched.map((item) => item.id);
          if (strategyName && ids.length === 0) return { strategies: [], note: 'No matching strategy was found.' };
          const since = new Date(Date.now() - days * 86_400_000).toISOString();
          const idFilter = ids.length ? `in.(${ids.join(',')})` : undefined;
          const [trades, signals] = await Promise.all([
            scoped('trade_history', {
              select: 'strategy_id,strategy_name_at_entry,symbol,side,profit,net_profit,r_multiple,open_time,close_time,session,entry_session,close_session,outcome,profit_verified',
              close_time: `gte.${since}`,
              ...(idFilter ? { strategy_id: idFilter } : {}),
              order: 'close_time.desc',
              limit: '1000',
            }),
            scoped('signals', {
              select: 'strategy_id,symbol,side,timeframe,policy_decision,block_reason,generated_at,source_kind',
              generated_at: `gte.${since}`,
              ...(idFilter ? { strategy_id: idFilter } : {}),
              order: 'generated_at.desc',
              limit: '1000',
            }),
          ]);
          const verifiedTrades = trades.filter((trade) => trade.profit_verified !== false);
          const wins = verifiedTrades.filter((trade) => netTrade(trade) > 0).length;
          const losses = verifiedTrades.filter((trade) => netTrade(trade) < 0).length;
          return {
            dateRangeDays: days,
            strategies: matched,
            tradeCount: verifiedTrades.length,
            excludedUnverifiedTrades: trades.length - verifiedTrades.length,
            wins,
            losses,
            winRate: verifiedTrades.length ? wins / verifiedTrades.length : null,
            netPl: verifiedTrades.reduce((sum, trade) => sum + netTrade(trade), 0),
            averageR: verifiedTrades.length ? verifiedTrades.reduce((sum, trade) => sum + Number(trade.r_multiple || 0), 0) / verifiedTrades.length : null,
            signalCount: signals.length,
            blockedSignals: signals.filter((signal) => signal.policy_decision === 'block').length,
            recentTrades: verifiedTrades.slice(0, 100).map((trade) => ({ ...trade, net_pl: netTrade(trade) })),
            recentSignals: signals.slice(0, 100),
            resultCapNotice: trades.length >= 1000 || signals.length >= 1000 ? 'Results reached the 1,000-row analysis cap.' : null,
          };
        },
      }),
      pairHealthAndTrend: tool({
        description: 'Read current trend-strength and price-history health for a pair on this terminal.',
        inputSchema: z.object({ symbol: z.string().min(3).max(24) }),
        strict: true,
        execute: async ({ symbol }) => {
          const normalized = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
          const [trend, feed] = await Promise.all([
            scoped('symbol_trend_state', {
              select: 'symbol,score,direction,strength,confidence,regime,timeframe_scores,components,source_bar_times,source_bar_time,model_version,computed_at',
              symbol: `eq.${normalized}`,
              limit: '1',
            }),
            scoped('price_feed_series_state', {
              select: 'symbol,timeframe,latest_bar_time,history_bar_count,last_received_at,status,last_error,last_success_at,expected_bar_time,ingest_lag_seconds',
              symbol: `eq.${normalized}`,
              desired_enabled: 'eq.true',
              order: 'timeframe.asc',
              limit: '20',
            }),
          ]);
          return { symbol: normalized, trend: trend[0] || null, timeframeHealth: feed };
        },
      }),
      recentTrades: tool({
        description: 'Read recent closed trades from this terminal for pattern analysis.',
        inputSchema: z.object({ limit: z.number().int().min(1).max(200).describe('Number of recent closed trades to return') }),
        strict: true,
        execute: async ({ limit }) => {
          const rows = await scoped('trade_history', {
            select: 'strategy_id,strategy_name_at_entry,symbol,side,volume,profit,net_profit,r_multiple,open_time,close_time,session,entry_session,close_session,htf_regime,near_news_event,outcome,source,profit_verified',
            order: 'close_time.desc',
            limit: String(limit),
          });
          return rows.map((trade) => ({ ...trade, net_pl: netTrade(trade) }));
        },
      }),
    },
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      configured: HAS_DIRECT_OPENAI || HAS_GATEWAY_AUTH,
      provider: HAS_DIRECT_OPENAI ? 'openai_direct' : HAS_GATEWAY_AUTH ? 'vercel_ai_gateway' : 'not_configured',
      model: MODEL,
      mode: 'read_only',
    });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  if (!HAS_DIRECT_OPENAI && !HAS_GATEWAY_AUTH) return json(res, 503, { error: 'ai_not_configured', message: 'OpenAI or Vercel AI Gateway is not configured for this deployment.' });
  if (!SUPABASE_ANON_KEY) return json(res, 503, { error: 'auth_not_configured' });

  try {
    const token = bearerToken(req);
    if (!token) return json(res, 401, { error: 'authentication_required' });
    const user = await supabaseFetch('/auth/v1/user', token);
    if (!user?.id) return json(res, 401, { error: 'invalid_session' });
    if (rateLimited(user.id)) return json(res, 429, { error: 'rate_limited', message: 'Lucre AI is catching its breath. Try again in a moment.' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const terminalId = String(body.terminal_id || '');
    const parsed = z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().trim().min(1).max(4000),
    })).min(1).max(12).safeParse(body.messages);
    if (!terminalId || !parsed.success) return json(res, 400, { error: 'invalid_request' });

    const owned = await query('mt5_terminals', { select: 'id,label', id: `eq.${terminalId}`, user_id: `eq.${user.id}`, limit: '1' }, token);
    if (!owned.length) return json(res, 403, { error: 'terminal_not_available' });

    const transcript = parsed.data.map((message) => `${message.role === 'user' ? 'User' : 'Lucre AI'}: ${message.content}`).join('\n\n');
    const result = await buildAgent({ token, terminalId, userId: user.id }).generate({
      prompt: `Selected terminal: ${owned[0].label || 'MT5 account'}\n\nConversation:\n${transcript}\n\nRespond to the latest user message.`,
    });
    return json(res, 200, { reply: result.text || 'I could not produce an answer from the available data.', mode: 'read_only' });
  } catch (error) {
    console.error('ai-assistant failure', {
      name: error?.name || 'Error',
      message: error?.message || String(error),
      statusCode: error?.statusCode || null,
      code: error?.data?.error?.code || null,
    });
    const message = error instanceof SyntaxError ? 'Invalid JSON request.' : 'Lucre AI could not complete that analysis. Please try again.';
    return json(res, error instanceof SyntaxError ? 400 : 500, { error: 'assistant_failed', message });
  }
}
