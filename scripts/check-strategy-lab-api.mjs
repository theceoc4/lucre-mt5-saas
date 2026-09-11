import assert from 'node:assert/strict';

delete process.env.OPENAI_API_KEY;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.VERCEL_OIDC_TOKEN;

const strategy = {
  id: 'strategy-1', terminal_id: 'terminal-1', name: 'Test Strategy', signal_source: 'internal',
  kind: 'custom_rules', timeframe: 'M30', symbols: ['EURUSD'], risk_percent: 1,
  config: { stop_atr: 1.8 }, exit_config: { stop_atr: 1.8, target_r: 2 },
  rule_definition: { version: 2, indicators: [{ indicator: 'ema_crossover', params: { fast_period: 20, slow_period: 50 } }] },
  direction_mode: 'both', allowed_sessions: [], cooldown_minutes: 0, max_spread_points: 20,
};

const responseJson = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});
let backtestRequestCount = 0;

globalThis.fetch = async (url, options = {}) => {
  const address = String(url);
  if (address.endsWith('/auth/v1/user')) return responseJson({ id: 'user-1' });
  if (address.includes('/rest/v1/strategies?')) return responseJson([strategy]);
  if (address.includes('/rest/v1/mt5_terminals?')) return responseJson([{ id: 'terminal-1', balance: 10_000 }]);
  if (address.includes('/rest/v1/trade_history?')) return responseJson([
    { strategy_id: 'strategy-1', profit_verified: true, close_reason: 'sl', net_profit: -100 },
    { strategy_id: 'strategy-1', profit_verified: true, close_reason: 'sl', net_profit: -100 },
    { strategy_id: 'strategy-1', profit_verified: true, close_reason: 'sl', net_profit: -100 },
    { strategy_id: 'strategy-1', profit_verified: true, close_reason: 'tp', net_profit: 200 },
    { strategy_id: 'strategy-1', profit_verified: true, close_reason: 'tp', net_profit: 200 },
  ]);
  if (address.includes('/rest/v1/signals?')) return responseJson([
    { strategy_id: 'strategy-1', policy_decision: 'block', block_reason: 'Cooldown guardrail' },
  ]);
  if (address.endsWith('/functions/v1/strategy-backtest')) {
    const request = JSON.parse(options.body);
    backtestRequestCount += 1;
    assert.equal(request.persist_run, false);
    const proposed = request.definition_snapshot.exit_config.stop_atr > 1.8;
    return responseJson({
      trade_count: 12,
      win_rate: proposed ? 0.58 : 0.5,
      expectancy_r: proposed ? 0.3 : 0.15,
      validation_expectancy_r: proposed ? 0.22 : 0.1,
      max_drawdown_r: proposed ? 2.1 : 2,
      result: { series: [{ trade: 1, cumulative_r: proposed ? 2 : -1, win_rate: proposed ? 1 : 0 }] },
    });
  }
  throw new Error(`Unexpected request: ${address}`);
};

const { default: handler } = await import('../api/strategy-lab.js');
const req = {
  method: 'POST',
  headers: { authorization: 'Bearer test-token' },
  body: { terminal_id: 'terminal-1', strategy_id: 'strategy-1', goal: 'profitability' },
};
const output = { statusCode: 0, headers: {}, body: '' };
const res = {
  status(code) { output.statusCode = code; return this; },
  setHeader(name, value) { output.headers[name] = value; return this; },
  end(body) { output.body = body; },
};

await handler(req, res);
const payload = JSON.parse(output.body);
assert.equal(output.statusCode, 200);
assert.equal(payload.status, 'recommendation');
assert.equal(payload.recommendation.path, 'exit_config.stop_atr');
assert.equal(payload.recommendation.current, 1.8);
assert.equal(payload.recommendation.proposed, 2.1);
assert.equal(payload.recommendation.accepted, true);
assert.equal(payload.candidatesTested, 10);
assert.equal(payload.goal, 'profitability');
assert.equal(payload.goalLabel, 'Increase profitability');
assert.equal(payload.result.currentWinRate, '50%');
assert.equal(payload.result.testedWinRate, '58%');
assert.equal(payload.comparison, undefined, 'Strategy Lab suggestions should be text-only');
assert.equal(backtestRequestCount, 11, 'One baseline and ten isolated candidates should be tested');
assert.match(payload.summary, /tested|stop|validation/i);

console.log('Aurelia Strategy Lab API flow verified.');
