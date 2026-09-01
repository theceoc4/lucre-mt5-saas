// v1.0.31 -- Progressive indicator stacks shared with the live engine.
// v1.0.30 -- Bounded diagnostic backtest over the 1,000-bar operational cache.
// This intentionally uses closed candles, conservative same-bar SL/TP ordering,
// one open simulation at a time, and a chronological 70/30 validation split.

import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
type Bar = { bar_time: string; open: number; high: number; low: number; close: number; volume: number; spread: number | null };
type Side = "buy" | "sell";
const n = (value: unknown, fallback: number) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; };
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const m = Math.floor(sorted.length / 2); return sorted.length ? (sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2) : NaN; };

function ema(values: number[], period: number): number[] {
  const out = Array(values.length).fill(NaN); if (values.length < period) return out;
  out[period - 1] = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const k = 2 / (period + 1); for (let i = period; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k); return out;
}
function atr(bars: Bar[], period = 14): number[] {
  const tr = bars.map((bar, i) => i ? Math.max(bar.high - bar.low, Math.abs(bar.high - bars[i - 1].close), Math.abs(bar.low - bars[i - 1].close)) : bar.high - bar.low);
  const out = Array(bars.length).fill(NaN); if (bars.length < period) return out;
  out[period - 1] = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < bars.length; i++) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period; return out;
}
function rsi(values: number[], period = 14): number[] {
  const out = Array(values.length).fill(NaN); if (values.length <= period) return out;
  let gain = 0, loss = 0; for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; gain += Math.max(d, 0); loss += Math.max(-d, 0); }
  gain /= period; loss /= period; const value = () => loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss); out[period] = value();
  for (let i = period + 1; i < values.length; i++) { const d = values[i] - values[i - 1]; gain = (gain * (period - 1) + Math.max(d, 0)) / period; loss = (loss * (period - 1) + Math.max(-d, 0)) / period; out[i] = value(); } return out;
}
function adx(bars: Bar[], period = 14): number[] {
  const out = Array(bars.length).fill(NaN), tr = Array(bars.length).fill(0), plus = Array(bars.length).fill(0), minus = Array(bars.length).fill(0);
  if (bars.length < period * 2) return out;
  for (let i = 1; i < bars.length; i++) { const up = bars[i].high - bars[i - 1].high, down = bars[i - 1].low - bars[i].low; plus[i] = up > down && up > 0 ? up : 0; minus[i] = down > up && down > 0 ? down : 0; tr[i] = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)); }
  let st = 0, sp = 0, sm = 0; for (let i = 1; i <= period; i++) { st += tr[i]; sp += plus[i]; sm += minus[i]; }
  const dx = Array(bars.length).fill(NaN); const calc = (i: number) => { const p = st ? 100 * sp / st : 0, m = st ? 100 * sm / st : 0; dx[i] = p + m ? 100 * Math.abs(p - m) / (p + m) : 0; };
  calc(period); for (let i = period + 1; i < bars.length; i++) { st = st - st / period + tr[i]; sp = sp - sp / period + plus[i]; sm = sm - sm / period + minus[i]; calc(i); }
  const first = period * 2 - 1; out[first] = dx.slice(period, first + 1).reduce((a, b) => a + b, 0) / period; for (let i = first + 1; i < bars.length; i++) out[i] = (out[i - 1] * (period - 1) + dx[i]) / period; return out;
}
function corr(values: number[]) { const xm = (values.length - 1) / 2, ym = values.reduce((a, b) => a + b, 0) / values.length; let c = 0, xv = 0, yv = 0; values.forEach((v, i) => { c += (i - xm) * (v - ym); xv += (i - xm) ** 2; yv += (v - ym) ** 2; }); return xv * yv ? c / Math.sqrt(xv * yv) : 0; }

function metrics(bars: Bar[], index: number) {
  const slice = bars.slice(0, index + 1), closes = slice.map((bar) => bar.close), av = atr(slice), a = av[index];
  const e20 = ema(closes, 20)[index], e50 = ema(closes, 50)[index], rv = rsi(closes)[index], ax = adx(slice)[index];
  const prior = slice.slice(-21, -1), high = prior.length ? Math.max(...prior.map((bar) => bar.high)) : closes[index], low = prior.length ? Math.min(...prior.map((bar) => bar.low)) : closes[index];
  const atrBase = median(av.filter(Number.isFinite).slice(-50)); const volumeBase = median(slice.slice(-31, -1).map((bar) => bar.volume));
  const spreadBase = median(slice.slice(-31, -1).map((bar) => Number(bar.spread)).filter((v) => v > 0)); const linearity = Math.abs(corr(closes.slice(-30)));
  const direction = Math.max(-1, Math.min(1, (e20 - e50) / a)); const confidence = Math.max(0, Math.min(1, (ax - 15) / 25)) * (0.5 + 0.5 * linearity);
  return { rsi14: rv, adx14: ax, ema_spread_atr: (e20 - e50) / a, close_ema20_atr: (closes[index] - e20) / a,
    breakout20_atr: closes[index] > high ? (closes[index] - high) / a : closes[index] < low ? (closes[index] - low) / a : 0,
    atr_ratio: a / atrBase, volume_ratio: slice[index].volume / volumeBase,
    spread_ratio: spreadBase > 0 && Number(slice[index].spread) > 0 ? Number(slice[index].spread) / spreadBase : 1,
    trend_score: 100 * (0.75 * direction + 0.25 * Math.max(-1, Math.min(1, (rv - 50) / 20))) * confidence,
    linearity, atr: a, ema20: e20, ema50: e50 };
}
function compare(actual: number, op: string, expected: number) { return op === 'gt' ? actual > expected : op === 'gte' ? actual >= expected : op === 'lt' ? actual < expected : op === 'lte' ? actual <= expected : Math.abs(actual - expected) < 1e-6; }

function indicatorParam(params:any,key:string,fallback:number,min:number,max:number){return Math.min(max,Math.max(min,n(params?.[key],fallback)));}
function indicatorClause(clause:any,bars:Bar[],index:number){
  const empty={buy:false,sell:false}; if(index<10)return empty; const params=clause?.params||{},slice=bars.slice(0,index+1),closes=slice.map(b=>b.close),current=bars[index];
  if(clause.indicator==='ema_crossover'){
    const fastPeriod=Math.floor(indicatorParam(params,'fast_period',20,2,200)),slowPeriod=Math.floor(indicatorParam(params,'slow_period',50,3,400));if(fastPeriod>=slowPeriod||index<slowPeriod)return empty;
    const fast=ema(closes,fastPeriod),slow=ema(closes,slowPeriod),fresh=params.trigger==='fresh_cross';
    return{buy:fresh?fast[index]>slow[index]&&fast[index-1]<=slow[index-1]:fast[index]>slow[index],sell:fresh?fast[index]<slow[index]&&fast[index-1]>=slow[index-1]:fast[index]<slow[index]};
  }
  if(clause.indicator==='rsi'){const value=rsi(closes,Math.floor(indicatorParam(params,'period',14,2,100)))[index];return{buy:Number.isFinite(value)&&value>=indicatorParam(params,'buy_above',55,1,99),sell:Number.isFinite(value)&&value<=indicatorParam(params,'sell_below',45,1,99)};}
  if(clause.indicator==='adx'){const value=adx(slice,Math.floor(indicatorParam(params,'period',14,2,100)))[index],matched=Number.isFinite(value)&&value>=indicatorParam(params,'minimum',25,1,100);return{buy:matched,sell:matched};}
  const av=atr(slice),a=av[index];if(!(a>0))return empty;
  if(clause.indicator==='price_vs_ema'){const value=ema(closes,Math.floor(indicatorParam(params,'ema_period',20,2,400)))[index],distance=(current.close-value)/a,minimum=indicatorParam(params,'minimum_atr',0,0,10);return{buy:distance>=minimum,sell:distance<=-minimum};}
  if(clause.indicator==='breakout'){const lookback=Math.floor(indicatorParam(params,'lookback',20,3,200)),prior=bars.slice(index-lookback,index);if(prior.length<lookback)return empty;const high=Math.max(...prior.map(b=>b.high)),low=Math.min(...prior.map(b=>b.low)),minimum=indicatorParam(params,'minimum_atr',0,0,10);return{buy:(current.close-high)/a>=minimum,sell:(current.close-low)/a<=-minimum};}
  if(clause.indicator==='atr_volatility'){const period=Math.floor(indicatorParam(params,'period',14,2,100)),baselineBars=Math.floor(indicatorParam(params,'baseline',50,10,200)),values=atr(slice,period),value=values[index],base=median(values.filter(Number.isFinite).slice(-(baselineBars+1),-1)),ratio=base>0?value/base:NaN,matched=Number.isFinite(ratio)&&ratio>=indicatorParam(params,'minimum_ratio',1,.1,10);return{buy:matched,sell:matched};}
  if(clause.indicator==='volume_confirmation'){const lookback=Math.floor(indicatorParam(params,'lookback',30,5,200)),base=median(bars.slice(index-lookback,index).map(b=>b.volume)),ratio=base>0?current.volume/base:NaN,matched=Number.isFinite(ratio)&&ratio>=indicatorParam(params,'minimum_ratio',1,.1,10);return{buy:matched,sell:matched};}
  if(clause.indicator==='trend_strength'){const score=metrics(bars,index).trend_score;return{buy:Number.isFinite(score)&&score>=indicatorParam(params,'buy_above',35,-100,100),sell:Number.isFinite(score)&&score<=indicatorParam(params,'sell_below',-35,-100,100)};}
  if(clause.indicator==='linearity'){const lookback=Math.floor(indicatorParam(params,'lookback',30,5,200)),value=corr(closes.slice(-lookback)),minimum=indicatorParam(params,'minimum',.6,0,1);return{buy:value>=minimum,sell:value<=-minimum};}
  return empty;
}
function indicatorSides(definition:any,bars:Bar[],index:number){const clauses=(definition?.indicators||[]).slice(0,4);if(!clauses.length)return{buy:false,sell:false};let buy=false,sell=false;clauses.forEach((clause:any,i:number)=>{const result=indicatorClause(clause,bars,index);if(i===0){buy=result.buy;sell=result.sell;}else if(clause.join==='or'){buy=buy||result.buy;sell=sell||result.sell;}else{buy=buy&&result.buy;sell=sell&&result.sell;}});return{buy,sell};}

function entry(strategy: any, bars: Bar[], index: number): Side | null {
  if (index < 80) return null; const config = strategy.config || {}, m = metrics(bars, index), current = bars[index], previous = bars[index - 1];
  let side: Side | null = null;
  if (strategy.kind === 'custom_rules') {
    if(strategy.rule_definition?.version===2){const result=indicatorSides(strategy.rule_definition,bars,index);if(result.buy!==result.sell)side=result.buy?'buy':'sell';}
    else for (const [name, candidate] of [['long','buy'],['short','sell']] as const) { const rules = strategy.rule_definition?.[name] || []; if (rules.length && rules.every((rule: any) => rule.timeframe === strategy.timeframe && compare((m as any)[rule.metric], rule.operator, Number(rule.value)))) { if (side) return null; side = candidate; } }
  } else if (strategy.kind === 'momentum_breakout' || strategy.kind === 'volatility_compression_breakout') {
    const lookback = Math.max(3, Math.min(100, Math.floor(n(config.breakout_lookback, strategy.kind === 'momentum_breakout' ? 12 : 20)))); const prior = bars.slice(index - lookback, index); const high = Math.max(...prior.map((b) => b.high)), low = Math.min(...prior.map((b) => b.low));
    if (current.close > high && m.adx14 >= n(config.adx_min, 18) && m.volume_ratio >= n(config.volume_ratio_min, 1)) side = 'buy';
    if (current.close < low && m.adx14 >= n(config.adx_min, 18) && m.volume_ratio >= n(config.volume_ratio_min, 1)) side = side ? null : 'sell';
  } else if (strategy.kind === 'range_mean_reversion') {
    const period = Math.floor(n(config.band_period, 20)), closes = bars.slice(index - period + 1, index + 1).map((b) => b.close), mean = closes.reduce((a,b) => a+b,0)/closes.length, sd = Math.sqrt(closes.reduce((a,b) => a+(b-mean)**2,0)/closes.length), band = n(config.band_deviation,2)*sd;
    if (m.adx14 <= n(config.adx_max,20) && previous.close < mean-band && current.close > mean-band && m.rsi14 <= n(config.rsi_oversold,38)) side='buy';
    if (m.adx14 <= n(config.adx_max,20) && previous.close > mean+band && current.close < mean+band && m.rsi14 >= n(config.rsi_overbought,62)) side=side?null:'sell';
  } else {
    if (m.ema20 > m.ema50 && previous.low <= m.ema20 && current.close > m.ema20 && current.close > current.open && m.adx14 >= n(config.adx_min,25)) side='buy';
    if (m.ema20 < m.ema50 && previous.high >= m.ema20 && current.close < m.ema20 && current.close < current.open && m.adx14 >= n(config.adx_min,25)) side=side?null:'sell';
  }
  if (strategy.direction_mode === 'long_only' && side === 'sell') return null; if (strategy.direction_mode === 'short_only' && side === 'buy') return null; return side;
}

function stats(results: number[]) {
  const wins = results.filter((r) => r > 0), losses = results.filter((r) => r < 0), grossWin = wins.reduce((a,b)=>a+b,0), grossLoss = Math.abs(losses.reduce((a,b)=>a+b,0));
  let equity=0, peak=0, drawdown=0; results.forEach((r)=>{ equity+=r; peak=Math.max(peak,equity); drawdown=Math.max(drawdown,peak-equity); });
  return { trade_count: results.length, win_rate: results.length ? wins.length/results.length : null, profit_factor: grossLoss ? grossWin/grossLoss : null, expectancy_r: results.length ? equity/results.length : null, max_drawdown_r: drawdown };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null,{headers:cors}); if (req.method !== 'POST') return json({error:'method_not_allowed'},405);
  const url=Deno.env.get('SUPABASE_URL')!, anon=Deno.env.get('SUPABASE_ANON_KEY')!, service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, authorization=req.headers.get('Authorization')||'';
  const client=createClient(url,anon,{global:{headers:{Authorization:authorization}}}), admin=createClient(url,service); const {data:{user}}=await client.auth.getUser(); if(!user) return json({error:'unauthorized'},401);
  const body=await req.json().catch(()=>null); if(!body?.strategy_id || !body?.symbol) return json({error:'strategy_id_and_symbol_required'},400);
  const {data:strategy,error:strategyError}=await admin.from('strategies').select('*').eq('id',body.strategy_id).single(); if(strategyError||!strategy) return json({error:'strategy_not_found'},404);
  const {data:terminal}=await admin.from('mt5_terminals').select('user_id').eq('id',strategy.terminal_id).single(); if(!terminal||terminal.user_id!==user.id) return json({error:'forbidden'},403);
  const snapshot={kind:strategy.kind,timeframe:strategy.timeframe,config:strategy.config,exit_config:strategy.exit_config,rule_definition:strategy.rule_definition,direction_mode:strategy.direction_mode};
  const {data:run}=await admin.from('strategy_backtest_runs').insert({terminal_id:strategy.terminal_id,strategy_id:strategy.id,symbol:body.symbol,timeframe:strategy.timeframe,definition_snapshot:snapshot,status:'running'}).select('id').single();
  const fail=async(message:string,status=400)=>{if(run)await admin.from('strategy_backtest_runs').update({status:'failed',completed_at:new Date().toISOString(),error_message:message}).eq('id',run.id);return json({error:message},status);};
  const {data:raw,error:barsError}=await admin.from('price_bars').select('bar_time,open,high,low,close,volume,spread').eq('terminal_id',strategy.terminal_id).eq('symbol',body.symbol).eq('timeframe',strategy.timeframe).order('bar_time',{ascending:true}).limit(1000);
  if(barsError||!raw||raw.length<250)return fail('At least 250 closed candles are required for this timeframe. Let the EA finish backfilling first.');
  if(strategy.kind==='news_continuation')return fail('News-continuation backtests require a historical event-replay dataset; use shadow mode for this strategy.');
  if(strategy.kind==='custom_rules'&&strategy.rule_definition?.version===1&&[...(strategy.rule_definition?.long||[]),...(strategy.rule_definition?.short||[])].some((r:any)=>r.timeframe!==strategy.timeframe))return fail('Multi-timeframe custom backtests are not yet supported; shadow mode evaluates them correctly.');
  const bars:Bar[]=raw.map((b:any)=>({...b,open:Number(b.open),high:Number(b.high),low:Number(b.low),close:Number(b.close),volume:Number(b.volume),spread:b.spread==null?null:Number(b.spread)})); const results:{index:number,r:number}[]=[];
  const exits=strategy.exit_config||{}, stopAtr=n(exits.stop_atr??strategy.config?.stop_atr,1.8), targetR=n(exits.target_r??strategy.config?.target_r,2), horizon=Math.max(5,Math.min(200,Math.floor(n(strategy.config?.shadow_horizon_bars,50))));
  for(let i=80;i<bars.length-horizon;i++){const side=entry(strategy,bars,i);if(!side)continue;const a=metrics(bars,i).atr;if(!(a>0))continue;const risk=stopAtr*a,ep=bars[i].close,sl=side==='buy'?ep-risk:ep+risk,tp=side==='buy'?ep+targetR*risk:ep-targetR*risk;let result=0,exit=i+horizon;
    for(let j=i+1;j<=Math.min(i+horizon,bars.length-1);j++){const hitSl=side==='buy'?bars[j].low<=sl:bars[j].high>=sl,hitTp=side==='buy'?bars[j].high>=tp:bars[j].low<=tp;if(hitSl){result=-1;exit=j;break;}if(hitTp){result=targetR;exit=j;break;}if(j===Math.min(i+horizon,bars.length-1))result=(side==='buy'?bars[j].close-ep:ep-bars[j].close)/risk;}
    results.push({index:i,r:result});i=exit;
  }
  const split=Math.floor(bars.length*.7),train=results.filter(x=>x.index<split).map(x=>x.r),validation=results.filter(x=>x.index>=split).map(x=>x.r),all=stats(results.map(x=>x.r)),validationStats=stats(validation);
  const payload={...all,bars_tested:bars.length,train_bars:split,validation_bars:bars.length-split,validation_expectancy_r:validationStats.expectancy_r,result:{engine_version:'bounded-v2',conservative_same_bar_ordering:true,non_overlapping:true,train:stats(train),validation:validationStats,warning:'Operational-cache backtests are diagnostic and do not model slippage.'},status:'completed',completed_at:new Date().toISOString()};
  if(run)await admin.from('strategy_backtest_runs').update(payload).eq('id',run.id);return json({run_id:run?.id,...payload});
});
