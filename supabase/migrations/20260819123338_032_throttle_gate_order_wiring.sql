-- 032_throttle_gate_order_wiring
--
-- Wires the Adaptive Throttle Engine's output (public.agent_policies) into
-- the actual order path for the first time. Until now, throttle_sweep() /
-- apply_throttle_ladder() computed a real profit-factor-based decision per
-- (terminal, strategy, symbol, session, htf_regime, near_news_event) cell
-- every 15 minutes, but nothing downstream ever read agent_policies -- it
-- was pure background computation with zero effect on trading.
--
-- Two gate points, mirroring the existing news-policy pattern
-- (apply_news_policy / trg_signals_apply_news_policy, migration 026/027):
--
-- 1. Signal generation time (apply_throttle_gate / trg_signals_apply_throttle_gate):
--    AFTER INSERT on signals, looks up the matching agent_policies cell and:
--      - decision = 'block'      -> escalates signals.policy_decision to 'block'
--      - decision = 'downweight' -> escalates policy_decision to 'downweight' AND
--                                    scales suggested_volume by downweight_factor
--      - decision = 'ok' / no policy row yet (insufficient sample) -> no change
--    Uses the same rank-merge as the news trigger (block > downweight > ok,
--    never downgrades a stronger decision already set) so whichever gate --
--    news or throttle -- found the bigger problem wins.
--
-- 2. Tap-to-execute time (signal-action edge function, deployed alongside this
--    migration): re-checks agent_policies immediately before inserting the
--    ea_commands row.
--
-- Manual orders (manual-order edge function) are deliberately NOT gated here:
-- they carry strategy_id = NULL and htf_regime = NULL by design, so they can
-- never match an agent_policies row.

-- 'blocked' is a new terminal state for a signal delivery that was rejected
-- at tap time by the throttle gate.
alter table public.signal_deliveries
  drop constraint signal_deliveries_status_check;

alter table public.signal_deliveries
  add constraint signal_deliveries_status_check
  check (status = any (array['pending','delivered','tapped','auto_executed','expired','cancelled','failed','blocked']));

create or replace function public.apply_throttle_gate(p_signal_id uuid)
returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_signal   public.signals;
  v_policy   public.agent_policies;
  v_current_rank int;
  v_new_rank int;
begin
  select * into v_signal from public.signals where id = p_signal_id;
  if v_signal is null then
    return;
  end if;

  select * into v_policy
    from public.agent_policies
   where terminal_id     = v_signal.terminal_id
     and strategy_id      = v_signal.strategy_id
     and symbol           = v_signal.symbol
     and session           = v_signal.session
     and htf_regime        = v_signal.htf_regime
     and near_news_event   = v_signal.near_news_event;

  if v_policy is null or v_policy.decision = 'ok' then
    return;
  end if;

  if v_policy.decision = 'downweight' and v_policy.downweight_factor is not null then
    update public.signals
       set suggested_volume = round(suggested_volume * v_policy.downweight_factor, 2)
     where id = p_signal_id;
  end if;

  v_current_rank := case v_signal.policy_decision when 'block' then 3 when 'downweight' then 2 else 1 end;
  v_new_rank     := case v_policy.decision         when 'block' then 3 when 'downweight' then 2 else 1 end;

  if v_new_rank > v_current_rank then
    update public.signals set policy_decision = v_policy.decision where id = p_signal_id;
  end if;
end;
$function$;

create or replace function public.trg_signals_apply_throttle_gate()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  perform public.apply_throttle_gate(new.id);
  return new;
end;
$function$;

create trigger trg_signals_apply_throttle_gate
  after insert on public.signals
  for each row execute function public.trg_signals_apply_throttle_gate();
;
