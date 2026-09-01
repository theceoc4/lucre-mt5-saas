-- v1.0.34 -- Durable, broker-specific candle-feed checkpoints.
--
-- The EA used to remember its latest successfully reported candle only in
-- process memory. A restart therefore made every selected symbol/timeframe
-- look empty and triggered a blind 1,000-bar replay. With a large symbol
-- universe those recovery batches could starve the exact feeds used by live
-- strategies. This compact table makes Supabase's accepted state authoritative.

create table public.price_feed_series_state (
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  symbol text not null,
  timeframe text not null check (timeframe in ('M1','M5','M15','M30','H1','H4','D1','W1')),
  latest_bar_time timestamptz not null,
  last_received_at timestamptz not null default now(),
  last_batch_bar_count integer not null default 0 check (last_batch_bar_count between 0 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (terminal_id, symbol, timeframe)
);

create index idx_price_feed_series_state_terminal_freshness
  on public.price_feed_series_state (terminal_id, last_received_at desc);

alter table public.price_feed_series_state enable row level security;
create policy "price_feed_series_state_select_own" on public.price_feed_series_state
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals terminal
    where terminal.id = price_feed_series_state.terminal_id
      and terminal.user_id = (select auth.uid())
  ));
revoke all on public.price_feed_series_state from anon;
revoke insert, update, delete on public.price_feed_series_state from authenticated;
grant select on public.price_feed_series_state to authenticated;

-- Preserve the already-accepted state when this migration lands. This avoids
-- one final global replay for terminals that already have a warm price cache.
insert into public.price_feed_series_state (
  terminal_id, symbol, timeframe, latest_bar_time,
  last_received_at, last_batch_bar_count, created_at, updated_at
)
select
  terminal_id,
  symbol,
  timeframe,
  max(bar_time),
  max(created_at),
  0,
  now(),
  now()
from public.price_bars
group by terminal_id, symbol, timeframe
on conflict (terminal_id, symbol, timeframe) do nothing;

-- One call records all series accepted in a report-bars request. GREATEST
-- prevents a delayed/older batch from moving a checkpoint backwards.
create or replace function public.record_price_feed_batches(
  p_terminal_id uuid,
  p_batches jsonb
) returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  batch jsonb;
  batch_count integer;
begin
  if jsonb_typeof(p_batches) is distinct from 'array' then
    raise exception 'p_batches must be a JSON array';
  end if;

  for batch in select value from jsonb_array_elements(p_batches)
  loop
    batch_count := least(greatest(coalesce((batch->>'bar_count')::integer, 0), 0), 1000);
    insert into public.price_feed_series_state (
      terminal_id, symbol, timeframe, latest_bar_time,
      last_received_at, last_batch_bar_count, updated_at
    ) values (
      p_terminal_id,
      batch->>'symbol',
      batch->>'timeframe',
      (batch->>'latest_bar_time')::timestamptz,
      now(),
      batch_count,
      now()
    )
    on conflict (terminal_id, symbol, timeframe) do update set
      latest_bar_time = greatest(
        public.price_feed_series_state.latest_bar_time,
        excluded.latest_bar_time
      ),
      last_received_at = now(),
      last_batch_bar_count = batch_count,
      updated_at = now();
  end loop;
end;
$$;

revoke all on function public.record_price_feed_batches(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_price_feed_batches(uuid, jsonb) to service_role;

comment on table public.price_feed_series_state is
  'Authoritative latest accepted closed-candle checkpoint per user terminal, canonical symbol, and timeframe. Used by ea-sync to prevent blind EA backfills after restarts.';
comment on function public.record_price_feed_batches(uuid, jsonb) is
  'Service-role ingestion helper that advances price-feed checkpoints monotonically after price_bars accepts a request.';
