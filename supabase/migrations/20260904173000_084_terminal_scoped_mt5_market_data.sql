-- v1.0.59 -- every MT5-originated market record belongs to one terminal.

-- Calendar events were historically merged by MQL5 value id. Preserve events
-- already referenced by tenant records by cloning them into the referencing
-- terminal, then remove the unowned global copies. Fresh EA syncs repopulate
-- each terminal's complete calendar independently.
alter table public.calendar_events
  add column terminal_id uuid references public.mt5_terminals(id) on delete cascade;

drop index if exists public.idx_calendar_events_mql5_value_id;

-- The production project currently has one terminal, so its existing feed has
-- unambiguous ownership and can remain warm through the migration. On a future
-- multi-tenant upgrade, only events already referenced by a tenant record are
-- preserved and mapped below; unowned shared rows are deliberately discarded.
do $$
declare
  v_terminal_count integer;
  v_only_terminal uuid;
begin
  select count(*) into v_terminal_count from public.mt5_terminals;
  if v_terminal_count = 1 then
    select id into v_only_terminal from public.mt5_terminals limit 1;
    update public.calendar_events set terminal_id = v_only_terminal
    where terminal_id is null;
  end if;
end
$$;

create temporary table legacy_calendar_event_map (
  terminal_id uuid not null,
  old_event_id uuid not null,
  new_event_id uuid not null default gen_random_uuid(),
  primary key (terminal_id, old_event_id)
) on commit drop;

insert into legacy_calendar_event_map (terminal_id, old_event_id)
select distinct referenced.terminal_id, referenced.news_event_id
from (
  select terminal_id, news_event_id from public.signals where news_event_id is not null
  union all
  select terminal_id, news_event_id from public.trade_history where news_event_id is not null
  union all
  select terminal_id, news_event_id from public.ea_commands where news_event_id is not null
  union all
  select terminal_id, news_event_id from public.positions where news_event_id is not null
) referenced
join public.calendar_events legacy_event on legacy_event.id = referenced.news_event_id
where legacy_event.terminal_id is null;

insert into public.calendar_events (
  id, terminal_id, event_time, country, impact, title, affected_symbols,
  created_at, currency, forecast, previous, actual, higher_is_bullish,
  source, mql5_event_id, mql5_value_id, is_global
)
select
  mapping.new_event_id, mapping.terminal_id, event.event_time, event.country,
  event.impact, event.title, event.affected_symbols, event.created_at,
  event.currency, event.forecast, event.previous, event.actual,
  event.higher_is_bullish, event.source, event.mql5_event_id,
  event.mql5_value_id, event.is_global
from legacy_calendar_event_map mapping
join public.calendar_events event on event.id = mapping.old_event_id;

update public.signals child set news_event_id = mapping.new_event_id
from legacy_calendar_event_map mapping
where child.terminal_id = mapping.terminal_id and child.news_event_id = mapping.old_event_id;

update public.trade_history child set news_event_id = mapping.new_event_id
from legacy_calendar_event_map mapping
where child.terminal_id = mapping.terminal_id and child.news_event_id = mapping.old_event_id;

update public.ea_commands child set news_event_id = mapping.new_event_id
from legacy_calendar_event_map mapping
where child.terminal_id = mapping.terminal_id and child.news_event_id = mapping.old_event_id;

update public.positions child set news_event_id = mapping.new_event_id
from legacy_calendar_event_map mapping
where child.terminal_id = mapping.terminal_id and child.news_event_id = mapping.old_event_id;

delete from public.calendar_events where terminal_id is null;

alter table public.calendar_events alter column terminal_id set not null;
alter table public.calendar_events
  add constraint calendar_events_id_terminal_key unique (id, terminal_id);

create unique index idx_calendar_events_terminal_mql5_value_id
  on public.calendar_events(terminal_id, mql5_value_id)
  where mql5_value_id is not null;
create index idx_calendar_events_terminal_event_time
  on public.calendar_events(terminal_id, event_time desc);

alter table public.signals drop constraint signals_news_event_id_fkey;
alter table public.signals add constraint signals_news_event_terminal_fkey
  foreign key (news_event_id, terminal_id)
  references public.calendar_events(id, terminal_id)
  on delete set null (news_event_id);

alter table public.trade_history drop constraint trade_history_news_event_id_fkey;
alter table public.trade_history add constraint trade_history_news_event_terminal_fkey
  foreign key (news_event_id, terminal_id)
  references public.calendar_events(id, terminal_id)
  on delete set null (news_event_id);

alter table public.ea_commands drop constraint ea_commands_news_event_id_fkey;
alter table public.ea_commands add constraint ea_commands_news_event_terminal_fkey
  foreign key (news_event_id, terminal_id)
  references public.calendar_events(id, terminal_id)
  on delete set null (news_event_id);

alter table public.positions drop constraint positions_news_event_id_fkey;
alter table public.positions add constraint positions_news_event_terminal_fkey
  foreign key (news_event_id, terminal_id)
  references public.calendar_events(id, terminal_id)
  on delete set null (news_event_id);

drop policy if exists "calendar_events_select_all" on public.calendar_events;
create policy "calendar_events_select_own_terminal" on public.calendar_events
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals terminal
    where terminal.id = calendar_events.terminal_id
      and terminal.user_id = (select auth.uid())
  ));
revoke all on table public.calendar_events from public, anon, authenticated;
grant select on table public.calendar_events to authenticated;
grant all on table public.calendar_events to service_role;

-- Feed health is meaningful only for the terminal that supplied the feed.
alter table public.market_feed_health
  add column terminal_id uuid references public.mt5_terminals(id) on delete cascade;
do $$
declare
  v_terminal_count integer;
  v_only_terminal uuid;
begin
  select count(*) into v_terminal_count from public.mt5_terminals;
  if v_terminal_count = 1 then
    select id into v_only_terminal from public.mt5_terminals limit 1;
    update public.market_feed_health set terminal_id = v_only_terminal
    where terminal_id is null;
  end if;
end
$$;
delete from public.market_feed_health where terminal_id is null;
alter table public.market_feed_health alter column terminal_id set not null;
alter table public.market_feed_health drop constraint market_feed_health_pkey;
alter table public.market_feed_health
  add constraint market_feed_health_pkey primary key (terminal_id, feed_name);
create index idx_market_feed_health_terminal
  on public.market_feed_health(terminal_id, updated_at desc);

drop policy if exists "market_feed_health_read" on public.market_feed_health;
create policy "market_feed_health_select_own_terminal" on public.market_feed_health
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals terminal
    where terminal.id = market_feed_health.terminal_id
      and terminal.user_id = (select auth.uid())
  ));
revoke all on table public.market_feed_health from public, anon, authenticated;
grant select on table public.market_feed_health to authenticated;
grant all on table public.market_feed_health to service_role;

-- Correlations must stay in the same broker/terminal price universe that
-- produced them. The table is currently empty, so no unowned values survive.
alter table public.symbol_correlations
  add column terminal_id uuid references public.mt5_terminals(id) on delete cascade;
delete from public.symbol_correlations where terminal_id is null;
alter table public.symbol_correlations alter column terminal_id set not null;
alter table public.symbol_correlations drop constraint symbol_correlations_pkey;
alter table public.symbol_correlations
  add constraint symbol_correlations_pkey
  primary key (terminal_id, symbol_a, symbol_b, timeframe);

drop policy if exists "symbol_correlations_select_all" on public.symbol_correlations;
create policy "symbol_correlations_select_own_terminal" on public.symbol_correlations
  for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals terminal
    where terminal.id = symbol_correlations.terminal_id
      and terminal.user_id = (select auth.uid())
  ));
revoke all on table public.symbol_correlations from public, anon, authenticated;
grant select on table public.symbol_correlations to authenticated;
grant all on table public.symbol_correlations to service_role;

comment on table public.symbol_correlations is
  'Rolling correlations derived within one terminal broker price universe; never shared across terminals or users.';

-- Terminal-aware helpers replace the old global variants.
create function public.symbols_for_currency(
  p_terminal_id uuid,
  p_currency text
)
returns text[]
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct scoped.symbol), '{}')
  from (
    select symbol from public.symbol_settings where terminal_id = p_terminal_id
    union
    select symbol from public.positions where terminal_id = p_terminal_id
    union
    select symbol from public.signals where terminal_id = p_terminal_id
    union
    select symbol from public.trade_history where terminal_id = p_terminal_id
  ) scoped
  where p_currency is not null
    and length(scoped.symbol) = 6
    and (
      upper(left(scoped.symbol, 3)) = upper(p_currency)
      or upper(right(scoped.symbol, 3)) = upper(p_currency)
    );
$$;

revoke all on function public.symbols_for_currency(uuid,text) from public, anon, authenticated;
grant execute on function public.symbols_for_currency(uuid,text) to service_role;

create function public.news_context(
  p_terminal_id uuid,
  p_symbol text,
  p_at timestamptz,
  p_window_minutes int default 30,
  p_min_impact text default 'low'
)
returns table (
  event_id uuid,
  title text,
  impact text,
  event_time timestamptz,
  minutes_to_event numeric,
  currency text,
  forecast numeric,
  previous numeric,
  actual numeric,
  effective_higher_is_bullish boolean
)
language sql
stable
set search_path = public, pg_temp
as $$
  select event.id, event.title, event.impact, event.event_time,
         round(extract(epoch from (event.event_time - p_at)) / 60.0, 1),
         event.currency, event.forecast, event.previous, event.actual,
         coalesce(event.higher_is_bullish, public.guess_higher_is_bullish(event.title))
  from public.calendar_events event
  where event.terminal_id = p_terminal_id
    and event.event_time between p_at - (p_window_minutes || ' minutes')::interval
                            and p_at + (p_window_minutes || ' minutes')::interval
    and (event.is_global or p_symbol = any(event.affected_symbols))
    and case event.impact when 'high' then 3 when 'medium' then 2 else 1 end
        >= case p_min_impact when 'high' then 3 when 'medium' then 2 else 1 end
  order by abs(extract(epoch from (event.event_time - p_at))) asc
  limit 1;
$$;

revoke all on function public.news_context(uuid,text,timestamptz,int,text)
  from public, anon, authenticated;
grant execute on function public.news_context(uuid,text,timestamptz,int,text)
  to service_role;

create function public.ingest_calendar_events(
  p_terminal_id uuid,
  p_events jsonb
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_event jsonb;
  v_idx int := -1;
  v_inserted int := 0;
  v_updated int := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_mql5_value_id bigint;
  v_event_time timestamptz;
  v_currency text;
  v_impact text;
  v_title text;
  v_is_global boolean;
  v_affected_symbols text[];
  v_existing_id uuid;
begin
  if not exists (select 1 from public.mt5_terminals where id = p_terminal_id) then
    raise exception 'terminal_not_found';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'p_events must be a jsonb array';
  end if;

  for v_event in select * from jsonb_array_elements(p_events)
  loop
    v_idx := v_idx + 1;
    begin v_mql5_value_id := (v_event->>'mql5_value_id')::bigint;
    exception when others then v_mql5_value_id := null; end;
    if v_mql5_value_id is null then
      v_skipped := v_skipped || jsonb_build_object('index', v_idx, 'reason', 'missing_or_invalid_mql5_value_id');
      continue;
    end if;

    begin v_event_time := (v_event->>'event_time')::timestamptz;
    exception when others then v_event_time := null; end;
    if v_event_time is null then
      v_skipped := v_skipped || jsonb_build_object('index', v_idx, 'reason', 'missing_or_invalid_event_time');
      continue;
    end if;

    v_impact := v_event->>'impact';
    if v_impact is null or v_impact not in ('low', 'medium', 'high') then
      v_skipped := v_skipped || jsonb_build_object('index', v_idx, 'reason', 'missing_or_invalid_impact');
      continue;
    end if;

    v_title := v_event->>'title';
    if v_title is null or length(trim(v_title)) = 0 then
      v_skipped := v_skipped || jsonb_build_object('index', v_idx, 'reason', 'missing_title');
      continue;
    end if;

    v_currency := nullif(upper(v_event->>'currency'), '');
    if v_currency is not null and v_currency !~ '^[A-Z]{3}$' then
      v_skipped := v_skipped || jsonb_build_object('index', v_idx, 'reason', 'invalid_currency_format');
      continue;
    end if;

    v_is_global := v_currency is null;
    v_affected_symbols := case when v_is_global then '{}'::text[]
      else public.symbols_for_currency(p_terminal_id, v_currency) end;

    select id into v_existing_id
    from public.calendar_events
    where terminal_id = p_terminal_id and mql5_value_id = v_mql5_value_id;

    if v_existing_id is null then
      insert into public.calendar_events (
        terminal_id, event_time, country, impact, title, affected_symbols,
        currency, forecast, previous, actual, higher_is_bullish,
        source, mql5_event_id, mql5_value_id, is_global
      ) values (
        p_terminal_id, v_event_time, v_event->>'country', v_impact, v_title,
        v_affected_symbols, v_currency, (v_event->>'forecast')::numeric,
        (v_event->>'previous')::numeric, (v_event->>'actual')::numeric,
        (v_event->>'higher_is_bullish')::boolean, 'mt5_calendar',
        nullif(v_event->>'mql5_event_id', '')::bigint,
        v_mql5_value_id, v_is_global
      );
      v_inserted := v_inserted + 1;
    else
      update public.calendar_events
      set event_time = v_event_time,
          country = v_event->>'country',
          impact = v_impact,
          title = v_title,
          affected_symbols = v_affected_symbols,
          currency = v_currency,
          forecast = (v_event->>'forecast')::numeric,
          previous = (v_event->>'previous')::numeric,
          actual = (v_event->>'actual')::numeric,
          higher_is_bullish = coalesce(higher_is_bullish, (v_event->>'higher_is_bullish')::boolean),
          is_global = v_is_global
      where id = v_existing_id and terminal_id = p_terminal_id;
      v_updated := v_updated + 1;
    end if;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'skipped', v_skipped);
end;
$$;

revoke all on function public.ingest_calendar_events(uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_calendar_events(uuid,jsonb) to service_role;

-- Rebind the automatic signal policy to the originating terminal's calendar.
create or replace function public.apply_news_policy(p_signal_id uuid)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_signal public.signals;
  v_strategy public.strategies;
  v_news record;
  v_current_rank int;
  v_new_rank int;
  v_new_decision text;
  v_half_window numeric;
  v_is_upcoming boolean;
  v_is_near boolean;
  v_has_forecast boolean;
  v_base_mult numeric;
  v_forecast_adj numeric;
  v_proximity_adj numeric;
  v_final_mult numeric;
  v_base_ccy text;
  v_quote_ccy text;
  v_has_direction_data boolean;
  v_diff numeric;
  v_currency_bias text;
  v_pair_bullish boolean;
  v_implied_side text;
  v_aligned boolean;
  v_settle_minutes numeric;
begin
  select * into v_signal from public.signals where id = p_signal_id;
  if v_signal is null then return; end if;

  select * into v_strategy from public.strategies where id = v_signal.strategy_id;
  if v_strategy is null then return; end if;

  select * into v_news from public.news_context(
    v_signal.terminal_id, v_signal.symbol, v_signal.generated_at,
    v_strategy.news_window_minutes, v_strategy.news_min_impact
  );
  if v_news.event_id is null then return; end if;

  update public.signals set near_news_event = true, news_event_id = v_news.event_id
  where id = p_signal_id;
  if v_strategy.news_posture = 'neutral' then return; end if;

  v_half_window := v_strategy.news_window_minutes / 2.0;
  v_is_upcoming := v_news.minutes_to_event > 0;
  if v_is_upcoming then
    if v_strategy.news_posture = 'exploit' or v_news.impact = 'low' then return; end if;
    v_is_near := abs(v_news.minutes_to_event) <= v_half_window;
    v_has_forecast := v_news.forecast is not null;
    v_base_mult := case v_news.impact when 'high' then 0.4 else 0.7 end;
    v_forecast_adj := case when v_has_forecast then 1.25 else 0.8 end;
    v_proximity_adj := case when v_is_near then 0.6 else 1.0 end;
    v_final_mult := least(1.0, v_base_mult * v_forecast_adj * v_proximity_adj);
    if v_final_mult < 0.20 then
      v_new_decision := 'block';
    elsif v_final_mult < 0.90 then
      v_new_decision := 'downweight';
      update public.signals set suggested_volume = round(suggested_volume * v_final_mult, 2)
      where id = p_signal_id;
    else
      v_new_decision := 'ok';
    end if;
    v_current_rank := case v_signal.policy_decision when 'block' then 3 when 'downweight' then 2 else 1 end;
    v_new_rank := case v_new_decision when 'block' then 3 when 'downweight' then 2 else 1 end;
    if v_new_rank > v_current_rank then
      update public.signals set policy_decision = v_new_decision where id = p_signal_id;
    end if;
    return;
  end if;

  v_has_direction_data := v_news.currency is not null
    and v_news.actual is not null
    and coalesce(v_news.forecast, v_news.previous) is not null
    and length(v_signal.symbol) = 6;
  if v_has_direction_data then
    v_base_ccy := upper(left(v_signal.symbol, 3));
    v_quote_ccy := upper(right(v_signal.symbol, 3));
    if upper(v_news.currency) not in (v_base_ccy, v_quote_ccy) then
      v_has_direction_data := false;
    end if;
  end if;

  v_aligned := null;
  if v_has_direction_data then
    v_diff := v_news.actual - coalesce(v_news.forecast, v_news.previous);
    if v_diff = 0 then v_currency_bias := 'neutral';
    elsif (v_diff > 0) = v_news.effective_higher_is_bullish then v_currency_bias := 'bullish';
    else v_currency_bias := 'bearish'; end if;
    if v_currency_bias <> 'neutral' then
      v_pair_bullish := case when upper(v_news.currency) = v_base_ccy
        then v_currency_bias = 'bullish' else v_currency_bias = 'bearish' end;
      v_implied_side := case when v_pair_bullish then 'buy' else 'sell' end;
      v_aligned := v_signal.side = v_implied_side;
    end if;
  end if;

  if v_aligned is null then
    v_settle_minutes := least(v_strategy.news_window_minutes, 10);
    if abs(v_news.minutes_to_event) <= v_settle_minutes then
      update public.signals
      set suggested_volume = round(suggested_volume * 0.7, 2),
          policy_decision = case when v_signal.policy_decision = 'ok' then 'downweight'
            else v_signal.policy_decision end
      where id = p_signal_id;
    end if;
    return;
  end if;
  if not v_aligned then
    update public.signals set policy_decision = 'block' where id = p_signal_id;
    return;
  end if;
  if v_strategy.news_posture = 'exploit' then
    update public.signals set suggested_volume = round(
      suggested_volume * v_strategy.news_exploit_size_multiplier
      * case when v_signal.htf_regime = 'trending' then 1.25 else 1.0 end, 2
    ) where id = p_signal_id;
  end if;
end;
$$;

revoke all on function public.apply_news_policy(uuid) from public, anon, authenticated;
grant execute on function public.apply_news_policy(uuid) to service_role;

drop function public.news_context(text,timestamptz,int,text);
drop function public.ingest_calendar_events(jsonb);
drop function public.symbols_for_currency(text);
