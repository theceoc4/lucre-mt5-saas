-- v1.0.76 — one weekend-aware session calendar and explicit entry/close
-- session attribution for every closed position.

create or replace function public.market_session_utc(p_at timestamptz)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when extract(dow from p_at at time zone 'UTC') = 6 then 'off_session'
    when extract(dow from p_at at time zone 'UTC') = 5
      and extract(hour from p_at at time zone 'UTC') >= 21 then 'off_session'
    when extract(dow from p_at at time zone 'UTC') = 0
      and extract(hour from p_at at time zone 'UTC') < 21 then 'off_session'
    when extract(hour from p_at at time zone 'UTC') < 7
      or extract(hour from p_at at time zone 'UTC') >= 21 then 'asia'
    when extract(hour from p_at at time zone 'UTC') < 12 then 'london'
    when extract(hour from p_at at time zone 'UTC') < 16 then 'overlap'
    else 'ny'
  end
$$;

comment on function public.market_session_utc(timestamptz) is
  'Lucre UTC session calendar v2. Friday 21:00 UTC through Sunday 21:00 UTC is off_session; broker tradability remains authoritative in MT5.';

alter table public.trade_history drop constraint if exists trade_history_session_check;
alter table public.ea_commands drop constraint if exists ea_commands_session_check;
alter table public.positions drop constraint if exists positions_session_check;
alter table public.scenario_stats drop constraint if exists scenario_stats_session_check;
alter table public.agent_policies drop constraint if exists agent_policies_session_check;

alter table public.trade_history
  add column if not exists entry_session text,
  add column if not exists close_session text;

-- Reclassify existing records from their actual timestamps. This repairs rows
-- previously labeled Asia/Overlap/New York solely because the mapper ignored
-- the day of week.
update public.ea_commands
set session = public.market_session_utc(requested_at)
where requested_at is not null;

update public.positions
set session = public.market_session_utc(open_time),
    entry_context = jsonb_set(
      jsonb_set(coalesce(entry_context, '{}'::jsonb), '{session}', to_jsonb(public.market_session_utc(open_time)), true),
      '{session_definition}', '"utc-v2-weekend-aware"'::jsonb, true
    )
where open_time is not null;

update public.trade_history
set entry_session = public.market_session_utc(open_time),
    close_session = public.market_session_utc(close_time),
    session = public.market_session_utc(open_time),
    entry_context = jsonb_set(
      jsonb_set(coalesce(entry_context, '{}'::jsonb), '{session}', to_jsonb(public.market_session_utc(open_time)), true),
      '{session_definition}', '"utc-v2-weekend-aware"'::jsonb, true
    );

alter table public.trade_history
  add constraint trade_history_session_check check (session in ('asia', 'london', 'ny', 'overlap', 'off_session')),
  add constraint trade_history_entry_session_check check (entry_session in ('asia', 'london', 'ny', 'overlap', 'off_session')),
  add constraint trade_history_close_session_check check (close_session in ('asia', 'london', 'ny', 'overlap', 'off_session'));
alter table public.ea_commands
  add constraint ea_commands_session_check check (session in ('asia', 'london', 'ny', 'overlap', 'off_session'));
alter table public.positions
  add constraint positions_session_check check (session in ('asia', 'london', 'ny', 'overlap', 'off_session'));
alter table public.scenario_stats
  add constraint scenario_stats_session_check check (session in ('asia', 'london', 'ny', 'overlap', 'off_session'));
alter table public.agent_policies
  add constraint agent_policies_session_check check (session in ('asia', 'london', 'ny', 'overlap', 'off_session'));

create or replace function public.set_position_session_from_open_time()
returns trigger
language plpgsql
set search_path = 'public', 'pg_temp'
as $$
begin
  new.session := public.market_session_utc(new.open_time);
  new.entry_context := jsonb_set(
    jsonb_set(coalesce(new.entry_context, '{}'::jsonb), '{session}', to_jsonb(new.session), true),
    '{session_definition}', '"utc-v2-weekend-aware"'::jsonb, true
  );
  return new;
end;
$$;

drop trigger if exists trg_positions_set_market_session on public.positions;
create trigger trg_positions_set_market_session
before insert or update of open_time on public.positions
for each row execute function public.set_position_session_from_open_time();

create or replace function public.set_trade_history_sessions()
returns trigger
language plpgsql
set search_path = 'public', 'pg_temp'
as $$
begin
  new.entry_session := public.market_session_utc(new.open_time);
  new.close_session := public.market_session_utc(new.close_time);
  new.session := new.entry_session;
  new.entry_context := jsonb_set(
    jsonb_set(coalesce(new.entry_context, '{}'::jsonb), '{session}', to_jsonb(new.entry_session), true),
    '{session_definition}', '"utc-v2-weekend-aware"'::jsonb, true
  );
  return new;
end;
$$;

drop trigger if exists trg_trade_history_set_market_sessions on public.trade_history;
create trigger trg_trade_history_set_market_sessions
before insert or update of open_time, close_time on public.trade_history
for each row execute function public.set_trade_history_sessions();

create index if not exists idx_trade_history_terminal_close_session
  on public.trade_history (terminal_id, close_session, close_time desc);

comment on column public.trade_history.entry_session is
  'Weekend-aware UTC market session derived from open_time. This is mirrored in session for existing analytics compatibility.';
comment on column public.trade_history.close_session is
  'Weekend-aware UTC market session derived from close_time, including off_session for weekend closures.';
