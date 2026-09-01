-- v1.0.33 -- Compact strategy evaluation health and skip-reason telemetry.
-- One row per strategy/symbol is updated only when the source candle or state
-- changes (or after a five-minute heartbeat), keeping this operational rather
-- than an unbounded decision log.

create table public.strategy_evaluation_state (
  strategy_id uuid not null references public.strategies(id) on delete cascade,
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  symbol text not null,
  timeframe text not null check (timeframe in ('M1','M5','M15','M30','H1','H4','D1','W1')),
  status text not null check (status in (
    'disabled','session_blocked','symbol_disabled','missing_bars','stale_candles',
    'no_setup','direction_blocked','spread_blocked','cooldown_blocked','duplicate_bar',
    'shadow_signal','manual_signal','ea_version_blocked','policy_blocked','risk_blocked',
    'broker_mapping_failed','command_failed','command_queued'
  )),
  source_bar_time timestamptz,
  candle_age_seconds integer,
  detail jsonb not null default '{}'::jsonb,
  last_checked_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (strategy_id, symbol)
);

create index idx_strategy_evaluation_state_terminal
  on public.strategy_evaluation_state(terminal_id, updated_at desc);

alter table public.strategy_evaluation_state enable row level security;
create policy "strategy_evaluation_state_select_own"
  on public.strategy_evaluation_state for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = terminal_id and t.user_id = (select auth.uid())
  ));
revoke insert, update, delete on public.strategy_evaluation_state from authenticated;
grant select on public.strategy_evaluation_state to authenticated;

create or replace function public.record_strategy_evaluation_states(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;

  insert into public.strategy_evaluation_state as current (
    strategy_id, terminal_id, symbol, timeframe, status, source_bar_time,
    candle_age_seconds, detail, last_checked_at, updated_at
  )
  select
    row.strategy_id, row.terminal_id, row.symbol, row.timeframe, row.status,
    row.source_bar_time, row.candle_age_seconds, coalesce(row.detail, '{}'::jsonb),
    now(), now()
  from jsonb_to_recordset(p_rows) as row(
    strategy_id uuid,
    terminal_id uuid,
    symbol text,
    timeframe text,
    status text,
    source_bar_time timestamptz,
    candle_age_seconds integer,
    detail jsonb
  )
  on conflict (strategy_id, symbol) do update set
    terminal_id = excluded.terminal_id,
    timeframe = excluded.timeframe,
    status = excluded.status,
    source_bar_time = excluded.source_bar_time,
    candle_age_seconds = excluded.candle_age_seconds,
    detail = excluded.detail,
    last_checked_at = now(),
    updated_at = now()
  where current.status is distinct from excluded.status
     or current.source_bar_time is distinct from excluded.source_bar_time
     or current.detail is distinct from excluded.detail
     or current.last_checked_at < now() - interval '5 minutes';

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.record_strategy_evaluation_states(jsonb)
  from public, anon, authenticated;
grant execute on function public.record_strategy_evaluation_states(jsonb)
  to service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'strategy_evaluation_state'
  ) then
    alter publication supabase_realtime add table public.strategy_evaluation_state;
  end if;
end $$;

comment on table public.strategy_evaluation_state is
  'Latest evaluation outcome per strategy/symbol. Compact health telemetry, not a historical signal log.';
