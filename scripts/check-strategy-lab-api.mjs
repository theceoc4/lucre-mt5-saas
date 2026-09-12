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
let pairedRequestCount = 0;
let scenario = 'wide_gain';

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
    if (request.definition_snapshot.exit_config.stop_atr !== 1.8
      && request.definition_snapshot.exit_config.target_r !== 2) pairedRequestCount += 1;
    const proposed = request.definition_snapshot.exit_config.stop_atr > 1.8;
    const pairedImprovement = proposed && request.definition_snapshot.exit_config.target_r < 2;
    const improved = scenario === 'no_gain' ? false : scenario === 'small_pair' ? pairedImprovement : proposed;
    return responseJson({
      status: 'completed',
      trade_count: 12,
      win_rate: scenario === 'small_pair' ? 0.5 : improved ? 0.58 : 0.5,
      expectancy_r: scenario === 'small_pair' ? improved ? 0.152 : 0.15 : improved ? 0.3 : 0.15,
      validation_expectancy_r: scenario === 'no_gain' ? 0.1 : scenario === 'small_pair' ? improved ? 0.102 : 0.1 : improved ? 0.22 : 0.1,
      max_drawdown_r: scenario === 'small_pair' ? 2 : improved ? 2.1 : 2,
      result: { validation: { trade_count: 4 }, series: [{ trade: 1, cumulative_r: improved ? 2 : -1, win_rate: improved ? 1 : 0 }] },
    });
  }
  throw new Error(`Unexpected request: ${address}`);
};

const { default: handler, buildConfigurations, applyConfiguration, comparisonDecision } = await import('../api/strategy-lab.js');
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
assert.equal(payload.recommendation.changes[0].path, 'exit_config.stop_atr');
assert.equal(payload.recommendation.changes[0].current, 1.8);
assert.equal(payload.recommendation.changes[0].proposed, 2.1);
assert.equal(payload.recommendation.accepted, true);
assert.equal(payload.candidatesTested, 20);
assert.equal(payload.goal, 'profitability');
assert.equal(payload.goalLabel, 'Increase profitability');
assert.equal(payload.result.currentWinRate, '50%');
assert.equal(payload.result.testedWinRate, '58%');
assert.equal(payload.comparison, undefined, 'Strategy Lab suggestions should be text-only');
assert.equal(backtestRequestCount, 21, 'One baseline and twenty configurations should be tested');
assert.ok(pairedRequestCount > 0, 'The expanded lineup must include multi-setting configurations');
assert.match(payload.summary, /tested|stop|validation/i);

scenario = 'small_pair';
backtestRequestCount = 0;
await handler(req, res);
const smallPair = JSON.parse(output.body);
assert.equal(smallPair.status, 'recommendation', 'A small improvement should not be blocked by an arbitrary significance floor');
assert.equal(smallPair.recommendation.changes.length, 2, 'The best paired result should return both settings');
assert.match(smallPair.summary, /small modeled improvement/i);
assert.equal(backtestRequestCount, 21);

scenario = 'no_gain';
await handler(req, res);
const noGain = JSON.parse(output.body);
assert.equal(noGain.status, 'no_improvement');
assert.equal(noGain.recommendation.accepted, false);
assert.match(noGain.summary, /None improved/i);

const configurations = buildConfigurations([
  { path: 'exit_config.stop_atr', label: 'ATR stop', current: 1.8, proposed: 2.1 },
  { path: 'exit_config.target_r', label: 'Profit target', current: 2, proposed: 2.2 },
  { path: 'cooldown_minutes', label: 'Cooldown', current: 5, proposed: 3 },
]);
assert.ok(configurations.some((configuration) => configuration.changes.length === 2));
assert.ok(configurations.every((configuration) => new Set(configuration.changes.map((change) => change.path)).size === configuration.changes.length));
const compactConfigurations = buildConfigurations(Array.from({ length: 5 }, (_, index) => ({
  path: `setting_${index}`, label: `Setting ${index}`, current: 1, proposed: 2,
})));
assert.equal(compactConfigurations.length, 20, 'A five-setting pool should still test twenty distinct combinations');
assert.ok(compactConfigurations.some((configuration) => configuration.changes.length === 3));
const paired = configurations.find((configuration) => configuration.changes.some((change) => change.path === 'exit_config.stop_atr')
  && configuration.changes.some((change) => change.path === 'exit_config.target_r'));
const preview = applyConfiguration({ config: { stop_atr: 1.8 }, exit_config: { stop_atr: 1.8, target_r: 2 } }, paired);
assert.equal(preview.exit_config.stop_atr, 2.1);
assert.equal(preview.config.stop_atr, 2.1);
assert.equal(preview.exit_config.target_r, 2.2);
assert.equal(comparisonDecision({ trade_count: 12, win_rate: 0.5, validation_expectancy_r: 0.1, max_drawdown_r: 2 },
  { trade_count: 12, win_rate: 0.5, validation_expectancy_r: 0.102, max_drawdown_r: 2 }, 'profitability'), true,
  'A small real validation improvement should still be recommended');
assert.equal(comparisonDecision({ trade_count: 12, win_rate: 0.5, validation_expectancy_r: 0.1, max_drawdown_r: 2 },
  { trade_count: 12, win_rate: 0.5, validation_expectancy_r: 0.1001, max_drawdown_r: 2 }, 'profitability'), true,
  'A tiny positive validation gain should not be rejected solely for being small');
assert.equal(comparisonDecision({ trade_count: 12, win_rate: 0.5, validation_expectancy_r: 0.1, max_drawdown_r: 2 },
  { trade_count: 12, win_rate: 0.5, validation_expectancy_r: 0.09, max_drawdown_r: 2 }, 'profitability'), false,
  'A worse candidate must not be described as an improvement');
assert.equal(comparisonDecision({ trade_count: 12, validation_expectancy_r: 0.1, max_drawdown_r: 2, result: { validation: { trade_count: 1 } } },
  { trade_count: 12, validation_expectancy_r: 0.12, max_drawdown_r: 2, result: { validation: { trade_count: 1 } } }, 'profitability'), false,
  'A gain from a one-trade validation sample must not be recommended');

console.log('Aurelia Strategy Lab API flow verified.');
