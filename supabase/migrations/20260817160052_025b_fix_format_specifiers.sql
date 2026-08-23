create or replace function public.apply_throttle_ladder(p_scenario_stats_id uuid) returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
  s public.scenario_stats%rowtype;
  existing public.agent_policies%rowtype;
  v_found boolean;
  v_tier int;
  v_decision text;
  v_downweight numeric;
  v_reason text;
  v_existing_score numeric;
  v_new_score numeric;
  v_final_decision text;
  v_final_downweight numeric;
  v_final_decided_by text;
  v_final_reason text;
  v_final_cooldown timestamptz;
  c_min_sample constant int := 20;
  c_cooldown_days constant int := 5;
  c_bad_avg_r constant numeric := -0.3;
begin
  select * into s from public.scenario_stats where id = p_scenario_stats_id;
  if not found then
    return;
  end if;

  if s.trade_count < c_min_sample then
    v_tier := 0; v_decision := 'ok'; v_downweight := 1.0;
    v_reason := format('insufficient sample (%s/%s trades) - full base risk', s.trade_count, c_min_sample);
  elsif s.profit_factor is null then
    v_tier := 0; v_decision := 'ok'; v_downweight := 1.0;
    v_reason := 'no losing trades yet in sample - full base risk';
  elsif s.profit_factor < 0.4 or (s.avg_r_multiple is not null and s.avg_r_multiple <= c_bad_avg_r) then
    v_tier := 3; v_decision := 'block'; v_downweight := 0;
    v_reason := format('profit factor %s, avg R %s - blocked, %s-day cooldown', round(s.profit_factor, 2), round(coalesce(s.avg_r_multiple, 0), 2), c_cooldown_days);
  elsif s.profit_factor < 0.7 then
    v_tier := 2; v_decision := 'downweight'; v_downweight := 0.5;
    v_reason := format('profit factor %s - tier 2 downweight, frequency capped', round(s.profit_factor, 2));
  elsif s.profit_factor < 1.0 then
    v_tier := 1; v_decision := 'downweight'; v_downweight := 0.75;
    v_reason := format('profit factor %s - tier 1 downweight, extra confluence required', round(s.profit_factor, 2));
  else
    v_tier := 0; v_decision := 'ok'; v_downweight := 1.0;
    v_reason := format('profit factor %s - performing, full base risk', round(s.profit_factor, 2));
  end if;

  select * into existing from public.agent_policies
   where terminal_id = s.terminal_id and strategy_id = s.strategy_id and symbol = s.symbol
     and session = s.session and htf_regime = s.htf_regime and near_news_event = s.near_news_event;
  v_found := found;

  if v_found and existing.decided_by = 'auto_throttle' and existing.decision = 'block'
     and existing.cooldown_until is not null and existing.cooldown_until <= now() then
    v_tier := 2; v_decision := 'downweight'; v_downweight := 0.5;
    v_reason := 'cooldown elapsed - auto-recovered to tier 2 probation (shadow-signal PF gate not yet implemented, see migration 025)';
  end if;

  v_final_cooldown := case when v_tier = 3 then
      case when v_found and existing.decision = 'block' and existing.cooldown_until is not null and existing.cooldown_until > now()
        then existing.cooldown_until
        else now() + make_interval(days => c_cooldown_days)
      end
    else null
  end;

  v_new_score := case v_decision when 'block' then 1000 else (1 - v_downweight) * 100 end;

  if v_found and existing.decided_by = 'user_override' then
    v_final_decision := existing.decision;
    v_final_downweight := existing.downweight_factor;
    v_final_decided_by := existing.decided_by;
    v_final_reason := existing.reason;
  elsif v_found and existing.decided_by in ('llm_recommend', 'llm_auto') then
    v_existing_score := case existing.decision when 'block' then 1000 else (1 - existing.downweight_factor) * 100 end;
    if v_existing_score >= v_new_score then
      v_final_decision := existing.decision;
      v_final_downweight := existing.downweight_factor;
      v_final_decided_by := existing.decided_by;
      v_final_reason := existing.reason;
    else
      v_final_decision := v_decision;
      v_final_downweight := v_downweight;
      v_final_decided_by := 'auto_throttle';
      v_final_reason := v_reason || format(' (floor raised past prior %s setting)', existing.decided_by);
    end if;
  else
    v_final_decision := v_decision;
    v_final_downweight := v_downweight;
    v_final_decided_by := 'auto_throttle';
    v_final_reason := v_reason;
  end if;

  insert into public.agent_policies (
    terminal_id, strategy_id, symbol, session, htf_regime, near_news_event,
    decision, downweight_factor, decided_by, reason, scenario_stats_id,
    auto_tier, auto_decision, auto_downweight_factor, auto_computed_at, cooldown_until
  ) values (
    s.terminal_id, s.strategy_id, s.symbol, s.session, s.htf_regime, s.near_news_event,
    v_final_decision, v_final_downweight, v_final_decided_by, v_final_reason, s.id,
    v_tier, v_decision, v_downweight, now(), v_final_cooldown
  )
  on conflict (terminal_id, strategy_id, symbol, session, htf_regime, near_news_event)
  do update set
    decision = excluded.decision,
    downweight_factor = excluded.downweight_factor,
    decided_by = excluded.decided_by,
    reason = excluded.reason,
    scenario_stats_id = excluded.scenario_stats_id,
    auto_tier = excluded.auto_tier,
    auto_decision = excluded.auto_decision,
    auto_downweight_factor = excluded.auto_downweight_factor,
    auto_computed_at = excluded.auto_computed_at,
    cooldown_until = excluded.cooldown_until;
end;
$$;;
