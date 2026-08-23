-- v1.0.6 -- News-aware signal policy + dashboard-wide auto-trading toggle.

-- A1. Per-strategy news configuration
alter table public.strategies
  add column news_posture text not null default 'avoid'
    check (news_posture in ('avoid', 'neutral', 'exploit')),
  add column news_window_minutes int not null default 30
    check (news_window_minutes > 0 and news_window_minutes <= 240),
  add column news_min_impact text not null default 'medium'
    check (news_min_impact in ('low', 'medium', 'high')),
  add column news_exploit_size_multiplier numeric not null default 1.5
    check (news_exploit_size_multiplier > 0 and news_exploit_size_multiplier <= 3.0);

comment on column public.strategies.news_posture is
  'How this strategy reacts to a qualifying nearby calendar event: avoid (downweight/block near news), neutral (tag only), exploit (do not block; scale suggested_volume up -- for strategies designed to trade news-driven volatility, e.g. breakout/momentum families).';
comment on column public.strategies.news_exploit_size_multiplier is
  'Only applied when news_posture = exploit. Multiplies suggested_volume on the qualifying signal. Not a signal-frequency knob -- how often new signals fire near news is decided by the external signal-engine worker (spec section 5.1), not by this database.';

-- A2. Canonical news-lookup function
create or replace function public.news_context(
  p_symbol text,
  p_at timestamptz,
  p_window_minutes int default 30,
  p_min_impact text default 'low'
) returns table (
  event_id uuid,
  title text,
  impact text,
  event_time timestamptz,
  minutes_to_event numeric
)
language sql
stable
as $$
  select ce.id, ce.title, ce.impact, ce.event_time,
         round(extract(epoch from (ce.event_time - p_at)) / 60.0, 1)
    from public.calendar_events ce
   where ce.event_time between p_at - (p_window_minutes || ' minutes')::interval
                            and p_at + (p_window_minutes || ' minutes')::interval
     and (ce.affected_symbols = '{}' or p_symbol = any (ce.affected_symbols))
     and case ce.impact when 'high' then 3 when 'medium' then 2 else 1 end
         >= case p_min_impact when 'high' then 3 when 'medium' then 2 else 1 end
   order by abs(extract(epoch from (ce.event_time - p_at))) asc
   limit 1;
$$;

comment on function public.news_context is
  'Nearest qualifying calendar event for a symbol at a point in time, within +/- window_minutes and at/above min_impact. Canonical replacement for the previously duplicated nearNewsCheck() JS helper.';

-- A3. apply_news_policy
create or replace function public.apply_news_policy(p_signal_id uuid)
returns void
language plpgsql
as $$
declare
  v_signal   public.signals;
  v_strategy public.strategies;
  v_news     record;
  v_new_decision text;
  v_current_rank int;
  v_new_rank int;
begin
  select * into v_signal from public.signals where id = p_signal_id;
  if v_signal is null then
    return;
  end if;

  select * into v_strategy from public.strategies where id = v_signal.strategy_id;
  if v_strategy is null then
    return;
  end if;

  select * into v_news
    from public.news_context(
      v_signal.symbol, v_signal.generated_at,
      v_strategy.news_window_minutes, v_strategy.news_min_impact
    );

  if v_news.event_id is null then
    return;
  end if;

  if v_strategy.news_posture = 'exploit' then
    update public.signals
       set near_news_event = true,
           news_event_id = v_news.event_id,
           suggested_volume = round(suggested_volume * v_strategy.news_exploit_size_multiplier, 2)
     where id = p_signal_id;
    return;
  end if;

  if v_strategy.news_posture = 'neutral' then
    update public.signals
       set near_news_event = true,
           news_event_id = v_news.event_id
     where id = p_signal_id;
    return;
  end if;

  if v_news.impact = 'high' and abs(v_news.minutes_to_event) <= (v_strategy.news_window_minutes / 2.0) then
    v_new_decision := 'block';
  else
    v_new_decision := 'downweight';
  end if;

  v_current_rank := case v_signal.policy_decision when 'block' then 3 when 'downweight' then 2 else 1 end;
  v_new_rank := case v_new_decision when 'block' then 3 when 'downweight' then 2 else 1 end;

  update public.signals
     set near_news_event = true,
         news_event_id = v_news.event_id,
         policy_decision = case when v_new_rank > v_current_rank then v_new_decision
                                else policy_decision end
   where id = p_signal_id;
end;
$$;

create or replace function public.trg_signals_apply_news_policy()
returns trigger
language plpgsql
as $$
begin
  perform public.apply_news_policy(new.id);
  return new;
end;
$$;

drop trigger if exists trg_signals_apply_news_policy on public.signals;
create trigger trg_signals_apply_news_policy
  after insert on public.signals
  for each row
  execute function public.trg_signals_apply_news_policy();

-- B. Dashboard-wide automatic trading toggle
alter table public.mt5_terminals
  add column auto_trading_enabled boolean not null default true;

comment on column public.mt5_terminals.auto_trading_enabled is
  'Master dashboard switch. false forces every signal on this terminal to manual_confirm regardless of the owning strategy''s delivery_mode. Signal generation is unaffected either way -- signals still fire and appear on the dashboard for tap-to-accept via the existing signal-action accept/decline flow (v1.0.0).';

revoke update on public.mt5_terminals from authenticated;
grant update (label, broker, account_login, server, is_live, auto_trading_enabled)
  on public.mt5_terminals to authenticated;

create or replace function public.effective_delivery_mode(
  p_terminal_id uuid,
  p_strategy_id uuid
) returns text
language sql
stable
as $$
  select case
           when not coalesce((select auto_trading_enabled from public.mt5_terminals where id = p_terminal_id), true)
             then 'manual_confirm'
           else coalesce((select delivery_mode from public.strategies where id = p_strategy_id), 'manual_confirm')
         end;
$$;

comment on function public.effective_delivery_mode is
  'Call this when creating a signal_deliveries row. Combines the terminal-level master auto-trading switch with the strategy-level delivery_mode: master off always wins (forces manual_confirm); master on defers to the strategy''s own setting.';
;
