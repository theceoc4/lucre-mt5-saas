-- 038_position_scenario_context.sql
--
-- Root cause: scenario_stats (and therefore the adaptive throttle ladder /
-- agent_policies) never accumulates rows because it requires trade_history
-- rows with non-null strategy_id + session + htf_regime, and those columns
-- only ever got populated on the one close path that reads them off the
-- *closing* ea_commands row (executed close-command path). The other two
-- close paths -- the closed_deals report handler and the "self-heal a
-- stuck/never-reported position" reconciler -- have never had that context
-- available at all, because `positions` itself never stored it. It was only
-- ever generated once, at signal time, in strategy-signal-engine, and
-- attached to the *opening* ea_commands row.
--
-- Fix: give `positions` its own copies of session/htf_regime/near_news_event
-- /news_event_id, populated when a reported position is first seen (from its
-- originating "open" ea_commands row, matched by mt5_ticket), so every close
-- path can read the context straight off the position instead of needing a
-- specific command row to still be reachable.
alter table public.positions
  add column if not exists session text,
  add column if not exists htf_regime text,
  add column if not exists near_news_event boolean not null default false,
  add column if not exists news_event_id uuid references public.calendar_events(id);

comment on column public.positions.session is
  'Trading session (asia/london/ny/overlap) captured from the originating open ea_commands row when this position was first reported by the EA. Propagated onto trade_history at close so scenario_stats can group by it.';
comment on column public.positions.htf_regime is
  'Higher-timeframe regime tag captured from the originating open ea_commands row. Propagated onto trade_history at close.';
comment on column public.positions.near_news_event is
  'Whether the opening signal fired near a high-impact calendar event, captured from the originating open ea_commands row.';
comment on column public.positions.news_event_id is
  'calendar_events.id the opening signal was near, if any, captured from the originating open ea_commands row.';

-- Backfill: for currently-closed positions, there is no way to recover this
-- (the rows never stored it and the originating command context has already
-- been consumed once at close time for the subset that did get it). This is
-- a forward-fix only -- see CHANGELOG for the accompanying data note.
