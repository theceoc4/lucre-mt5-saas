-- v1.0.14 — M5/M1 price-bar store for the server-side strategy signal engine.
--
-- The MT5 EA reports only CLOSED M5 bars through report-bars. Keeping the
-- canonical symbol here (rather than a broker-specific spelling) lets the
-- strategy engine evaluate the same configured strategy symbols that the
-- dashboard displays; the final auto-execution step resolves back to the
-- terminal's broker symbol before inserting ea_commands.
--
-- This is intentionally a short rolling operational data set, not a market
-- data warehouse: all current strategy indicators use <=300 M5 bars and the
-- housekeeping job below removes bars after seven days.

create table public.price_bars (
  id uuid primary key default gen_random_uuid(),
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  symbol text not null,
  timeframe text not null default 'M5' check (timeframe in ('M1', 'M5')),
  bar_time timestamptz not null,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  volume numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (terminal_id, symbol, timeframe, bar_time)
);

create index idx_price_bars_terminal_symbol_timeframe_time
  on public.price_bars (terminal_id, symbol, timeframe, bar_time desc);

-- RLS, matching the trust model established in 011_row_level_security.sql:
-- anon gets nothing, authenticated dashboard users may read their own
-- terminal's bars (useful for future charting), only service_role (used by
-- report-bars and strategy-signal-engine) may write.
revoke all on public.price_bars from anon;
alter table public.price_bars enable row level security;

create policy "price_bars_select_own_terminal" on public.price_bars
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals t
    where t.id = price_bars.terminal_id and t.user_id = auth.uid()
  ));

revoke insert, update, delete on public.price_bars from authenticated;

create or replace function public.prune_old_price_bars() returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  delete from public.price_bars
  where bar_time < now() - interval '7 days';
end;
$$;

comment on function public.prune_old_price_bars is
  'Removes closed M1/M5 bars older than seven days. price_bars is an operational indicator-input cache, not long-term market-data storage.';

create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'prune-old-price-bars-hourly') then
    perform cron.unschedule('prune-old-price-bars-hourly');
  end if;
end $$;

select cron.schedule(
  'prune-old-price-bars-hourly',
  '0 * * * *',
  $cron$select public.prune_old_price_bars();$cron$
);
;
