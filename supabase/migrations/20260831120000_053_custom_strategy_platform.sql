-- v1.0.30 -- Versioned custom strategies, shadow testing, backtest records,
-- bounded portfolio risk, and a deeper operational candle cache.

-- 1,000 bars is a deliberate operational ceiling: enough to warm EMA-200
-- indicators and split a small in-platform backtest into train/validation
-- windows, while keeping the minute-level Supabase table bounded. A future
-- research warehouse can retain substantially more without burdening the
-- live signal path.
create or replace function public.prune_old_price_bars() returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  delete from public.price_bars bars
  using (
    select id
    from (
      select id, row_number() over (
        partition by terminal_id, symbol, timeframe order by bar_time desc
      ) retained_rank
      from public.price_bars
    ) ranked
    where retained_rank > 1000
  ) expired
  where bars.id = expired.id;
end;
$$;

comment on function public.prune_old_price_bars is
  'Retains the newest 1,000 closed candles per terminal/symbol/timeframe. This is an operational indicator/backtest cache, not an unbounded research warehouse.';

alter table public.symbol_trend_calculation_state
  drop constraint if exists symbol_trend_calculation_state_timeframe_check;
alter table public.symbol_trend_calculation_state
  add constraint symbol_trend_calculation_state_timeframe_check
  check (timeframe in ('M1','M5','M15','M30','H1','H4','D1','W1'));

create table public.symbol_trend_history (
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  symbol text not null,
  source_bar_time timestamptz not null,
  score numeric(6,2) not null check (score between -100 and 100),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  regime text not null check (regime in ('trending','ranging','transition','volatility_shock','insufficient_data')),
  timeframe_scores jsonb not null default '{}'::jsonb,
  model_version text not null,
  computed_at timestamptz not null default now(),
  primary key(terminal_id,symbol,source_bar_time)
);
alter table public.symbol_trend_history enable row level security;
create policy "symbol_trend_history_select_own" on public.symbol_trend_history for select to authenticated using (exists (
  select 1 from public.mt5_terminals t where t.id=terminal_id and t.user_id=(select auth.uid())
));
revoke insert,update,delete on public.symbol_trend_history from authenticated;
grant select on public.symbol_trend_history to authenticated;

create or replace function public.prune_symbol_trend_history() returns void language plpgsql
set search_path to 'public','pg_temp' as $$
begin
  delete from public.symbol_trend_history h using (
    select terminal_id,symbol,source_bar_time from (
      select terminal_id,symbol,source_bar_time,row_number() over(partition by terminal_id,symbol order by source_bar_time desc) rank
      from public.symbol_trend_history
    ) ranked where rank>2000
  ) expired where h.terminal_id=expired.terminal_id and h.symbol=expired.symbol and h.source_bar_time=expired.source_bar_time;
end;
$$;
select cron.schedule('prune-symbol-trend-history-hourly','17 * * * *',$cron$select public.prune_symbol_trend_history();$cron$);

create or replace function public.valid_strategy_definition(p_definition jsonb)
returns boolean
language plpgsql
immutable
set search_path to 'public', 'pg_temp'
as $$
declare
  side_name text;
  condition jsonb;
  allowed_metrics constant text[] := array[
    'rsi14','adx14','ema_spread_atr','close_ema20_atr','breakout20_atr',
    'atr_ratio','volume_ratio','spread_ratio','trend_score','linearity'
  ];
  allowed_operators constant text[] := array['gt','gte','lt','lte','eq'];
  allowed_timeframes constant text[] := array['M1','M5','M15','M30','H1','H4','D1','W1'];
begin
  if p_definition is null or jsonb_typeof(p_definition) <> 'object' then return false; end if;
  if coalesce((p_definition->>'version')::int, 0) <> 1 then return false; end if;
  if jsonb_array_length(coalesce(p_definition->'long', '[]'::jsonb)) > 12
     or jsonb_array_length(coalesce(p_definition->'short', '[]'::jsonb)) > 12 then return false; end if;
  foreach side_name in array array['long','short'] loop
    if jsonb_typeof(coalesce(p_definition->side_name, '[]'::jsonb)) <> 'array' then return false; end if;
    for condition in select value from jsonb_array_elements(coalesce(p_definition->side_name, '[]'::jsonb)) loop
      if not (condition->>'metric' = any(allowed_metrics)) then return false; end if;
      if not (condition->>'operator' = any(allowed_operators)) then return false; end if;
      if not (condition->>'timeframe' = any(allowed_timeframes)) then return false; end if;
      if jsonb_typeof(condition->'value') is distinct from 'number' then return false; end if;
    end loop;
  end loop;
  return jsonb_array_length(coalesce(p_definition->'long', '[]'::jsonb)) > 0
      or jsonb_array_length(coalesce(p_definition->'short', '[]'::jsonb)) > 0;
exception when others then
  return false;
end;
$$;

alter table public.strategies
  add column definition_version integer not null default 1,
  add column run_mode text not null default 'live'
    check (run_mode in ('shadow','live')),
  add column bias_timeframe text
    check (bias_timeframe is null or bias_timeframe in ('M1','M5','M15','M30','H1','H4','D1','W1')),
  add column rule_definition jsonb,
  add column exit_config jsonb not null default '{}'::jsonb,
  add column allowed_sessions text[] not null default array['asia','london','overlap','ny'],
  add column direction_mode text not null default 'both'
    check (direction_mode in ('both','long_only','short_only')),
  add column cooldown_minutes integer not null default 0
    check (cooldown_minutes between 0 and 10080),
  add column max_concurrent_positions integer not null default 1
    check (max_concurrent_positions between 1 and 20),
  add column max_spread_points numeric
    check (max_spread_points is null or max_spread_points > 0),
  add column min_shadow_signals integer not null default 20
    check (min_shadow_signals between 5 and 1000),
  add column promoted_at timestamptz,
  add constraint strategies_definition_valid check (
    kind <> 'custom_rules' or public.valid_strategy_definition(rule_definition)
  );

update public.strategies
set config = jsonb_strip_nulls(config || case kind
  when 'momentum_breakout' then '{"ema_fast":9,"ema_slow":21,"rsi_period":14,"adx_period":14,"adx_min":18,"breakout_lookback":12,"stop_atr":1.5,"max_stop_atr":2.8,"target_r":1.8,"strong_target_r":2.2,"strong_adx":30}'::jsonb
  when 'confirmed_trend_pullback' then '{"ema_fast":20,"ema_slow":50,"rsi_period":14,"adx_period":14,"adx_min":25,"stop_atr":1.8,"max_stop_atr":3.2,"target_r":2.2,"strong_target_r":2.6,"strong_adx":35}'::jsonb
  else '{}'::jsonb end);

-- Existing production configurations were backfilled as live by the ADD
-- COLUMN default. New configurations start safely in shadow mode.
alter table public.strategies alter column run_mode set default 'shadow';

comment on column public.strategies.rule_definition is
  'Versioned declarative rules. Only allowlisted metrics/operators are accepted; executable user code is never stored or run.';
comment on column public.strategies.run_mode is
  'shadow records hypothetical outcomes without creating a user-actionable delivery or EA command; live retains normal manual/auto behavior.';

create table public.strategy_shadow_signals (
  id uuid primary key default gen_random_uuid(),
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  strategy_id uuid not null references public.strategies(id) on delete cascade,
  symbol text not null,
  timeframe text not null check (timeframe in ('M1','M5','M15','M30','H1','H4','D1','W1')),
  source_bar_time timestamptz not null,
  side text not null check (side in ('buy','sell')),
  entry_price numeric not null,
  sl numeric not null,
  tp numeric not null,
  initial_risk_distance numeric not null check (initial_risk_distance > 0),
  status text not null default 'pending' check (status in ('pending','won','lost','expired')),
  generated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  resolved_at timestamptz,
  result_r numeric,
  mfe_r numeric not null default 0,
  mae_r numeric not null default 0,
  evaluation_context jsonb not null default '{}'::jsonb,
  unique(strategy_id, symbol, timeframe, source_bar_time, side)
);

create index idx_shadow_pending on public.strategy_shadow_signals(terminal_id, status, timeframe, symbol);
alter table public.strategy_shadow_signals enable row level security;
create policy "strategy_shadow_signals_select_own" on public.strategy_shadow_signals
  for select to authenticated using (exists (
    select 1 from public.mt5_terminals t where t.id = terminal_id and t.user_id = (select auth.uid())
  ));
revoke insert, update, delete on public.strategy_shadow_signals from authenticated;
grant select on public.strategy_shadow_signals to authenticated;

create or replace function public.enforce_strategy_live_promotion()
returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $$
begin
  if new.run_mode = 'live' and new.promoted_at is null
     and (tg_op = 'INSERT' or old.run_mode <> 'live') then
    raise exception 'Strategy must pass shadow or validation testing before live promotion';
  end if;
  return new;
end;
$$;
create trigger trg_strategy_live_promotion before insert or update of run_mode on public.strategies
  for each row execute function public.enforce_strategy_live_promotion();

create table public.strategy_backtest_runs (
  id uuid primary key default gen_random_uuid(),
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  strategy_id uuid not null references public.strategies(id) on delete cascade,
  symbol text not null,
  timeframe text not null,
  definition_snapshot jsonb not null,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  bars_tested integer not null default 0,
  train_bars integer not null default 0,
  validation_bars integer not null default 0,
  trade_count integer not null default 0,
  win_rate numeric,
  profit_factor numeric,
  expectancy_r numeric,
  max_drawdown_r numeric,
  validation_expectancy_r numeric,
  error_message text,
  result jsonb not null default '{}'::jsonb
);

create index idx_backtest_runs_strategy on public.strategy_backtest_runs(strategy_id, requested_at desc);
alter table public.strategy_backtest_runs enable row level security;
create policy "strategy_backtest_runs_select_own" on public.strategy_backtest_runs
  for select to authenticated using (exists (
    select 1 from public.mt5_terminals t where t.id = terminal_id and t.user_id = (select auth.uid())
  ));
revoke insert, update, delete on public.strategy_backtest_runs from authenticated;
grant select on public.strategy_backtest_runs to authenticated;

create or replace function public.promote_strategy_to_live(p_strategy_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  strategy_row public.strategies%rowtype;
  shadow_count integer;
  shadow_expectancy numeric;
  backtest_ok boolean;
begin
  select s.* into strategy_row from public.strategies s join public.mt5_terminals t on t.id=s.terminal_id
    where s.id=p_strategy_id and t.user_id=auth.uid();
  if not found then raise exception 'strategy not found'; end if;
  select count(*), avg(result_r) into shadow_count, shadow_expectancy from public.strategy_shadow_signals
    where strategy_id=p_strategy_id and status in ('won','lost','expired');
  select exists(select 1 from public.strategy_backtest_runs where strategy_id=p_strategy_id and status='completed'
    and trade_count >= strategy_row.min_shadow_signals and coalesce(validation_expectancy_r,0) > 0)
    into backtest_ok;
  if not (shadow_count >= strategy_row.min_shadow_signals and coalesce(shadow_expectancy,0) > 0) and not backtest_ok then
    raise exception 'promotion requires % profitable resolved shadow signals or a positive validation backtest', strategy_row.min_shadow_signals;
  end if;
  update public.strategies set run_mode='live', promoted_at=now() where id=p_strategy_id;
end;
$$;
revoke all on function public.promote_strategy_to_live(uuid) from public;
grant execute on function public.promote_strategy_to_live(uuid) to authenticated;

create table public.portfolio_risk_settings (
  terminal_id uuid primary key references public.mt5_terminals(id) on delete cascade,
  enabled boolean not null default true,
  max_total_open_risk_percent numeric not null default 3 check (max_total_open_risk_percent between 0.1 and 25),
  max_symbol_open_risk_percent numeric not null default 1.5 check (max_symbol_open_risk_percent between 0.1 and 10),
  max_positions_per_symbol integer not null default 2 check (max_positions_per_symbol between 1 and 20),
  max_daily_realized_loss_percent numeric not null default 3 check (max_daily_realized_loss_percent between 0.1 and 25),
  updated_at timestamptz not null default now()
);

create trigger trg_portfolio_risk_settings_updated_at before update on public.portfolio_risk_settings
  for each row execute function public.set_updated_at();
alter table public.portfolio_risk_settings enable row level security;
create policy "portfolio_risk_settings_all_own" on public.portfolio_risk_settings
  for all to authenticated using (exists (
    select 1 from public.mt5_terminals t where t.id = terminal_id and t.user_id = (select auth.uid())
  )) with check (exists (
    select 1 from public.mt5_terminals t where t.id = terminal_id and t.user_id = (select auth.uid())
  ));
grant select,insert,update on public.portfolio_risk_settings to authenticated;

insert into public.portfolio_risk_settings(terminal_id)
select id from public.mt5_terminals on conflict do nothing;

create or replace function public.create_default_portfolio_risk_settings()
returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $$
begin
  insert into public.portfolio_risk_settings(terminal_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;
create trigger trg_terminal_default_portfolio_risk after insert on public.mt5_terminals
  for each row execute function public.create_default_portfolio_risk_settings();

create or replace function public.portfolio_risk_gate(
  p_terminal_id uuid,
  p_strategy_id uuid,
  p_symbol text,
  p_proposed_risk_percent numeric
) returns table(allowed boolean, reason text)
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $$
declare
  settings public.portfolio_risk_settings%rowtype;
  strategy_row public.strategies%rowtype;
  open_risk numeric;
  symbol_risk numeric;
  strategy_count integer;
  symbol_count integer;
  daily_pl numeric;
  account_balance numeric;
begin
  select * into settings from public.portfolio_risk_settings where terminal_id = p_terminal_id;
  if not found or not settings.enabled then return query select true, 'portfolio gate disabled'; return; end if;
  select * into strategy_row from public.strategies where id = p_strategy_id and terminal_id = p_terminal_id;
  if not found then return query select false, 'strategy not found'; return; end if;

  select coalesce(sum(risk_percent),0), count(*) filter (where strategy_id = p_strategy_id)
    into open_risk, strategy_count from public.positions where terminal_id = p_terminal_id and status = 'open';
  select coalesce(sum(risk_percent),0), count(*) into symbol_risk, symbol_count
    from public.positions where terminal_id = p_terminal_id and status = 'open'
      and coalesce(entry_context->>'canonical_symbol', symbol) = p_symbol;
  select coalesce(sum(net_profit),0) into daily_pl from public.trade_history
    where terminal_id = p_terminal_id and close_time >= date_trunc('day', now()) and profit_verified = true;
  select balance into account_balance from public.mt5_terminals where id = p_terminal_id;

  if open_risk + p_proposed_risk_percent > settings.max_total_open_risk_percent then
    return query select false, 'maximum total open risk reached'; return;
  elsif symbol_risk + p_proposed_risk_percent > settings.max_symbol_open_risk_percent then
    return query select false, 'maximum symbol risk reached'; return;
  elsif symbol_count >= settings.max_positions_per_symbol then
    return query select false, 'maximum positions for symbol reached'; return;
  elsif strategy_count >= strategy_row.max_concurrent_positions then
    return query select false, 'maximum concurrent positions for strategy reached'; return;
  elsif account_balance > 0 and daily_pl < 0 and abs(daily_pl) / account_balance * 100 >= settings.max_daily_realized_loss_percent then
    return query select false, 'daily realized loss limit reached'; return;
  end if;
  return query select true, 'ok';
end;
$$;

grant execute on function public.portfolio_risk_gate(uuid,uuid,text,numeric) to service_role;

-- User-facing strategy rows may use the new implementations after the Edge
-- Function is deployed. Existing rows remain live and keep their behavior.
comment on table public.strategy_backtest_runs is
  'Bounded in-platform backtests over the operational candle cache. Results are diagnostic, not proof of future performance.';

create table public.market_feed_health (
  feed_name text primary key,
  last_received_at timestamptz,
  last_event_time timestamptz,
  last_actual_release_at timestamptz,
  last_source_terminal_id uuid references public.mt5_terminals(id) on delete set null,
  rows_received integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.market_feed_health enable row level security;
create policy "market_feed_health_read" on public.market_feed_health for select to authenticated using (true);
revoke insert,update,delete on public.market_feed_health from authenticated;
grant select on public.market_feed_health to authenticated;
insert into public.market_feed_health(feed_name) values ('economic_calendar') on conflict do nothing;
