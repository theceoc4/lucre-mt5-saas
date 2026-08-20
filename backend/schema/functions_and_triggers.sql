-- Database functions and triggers (public schema)
-- Introspected live via pg_get_functiondef(). See ../schema/tables.md for the
-- schema-snapshot caveat (this reflects current state, not migration history).

-- ===== apply_news_policy =====
CREATE OR REPLACE FUNCTION public.apply_news_policy(p_signal_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_signal   public.signals;
  v_strategy public.strategies;
  v_news     record;
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

  update public.signals
     set near_news_event = true,
         news_event_id = v_news.event_id
   where id = p_signal_id;

  if v_strategy.news_posture = 'neutral' then
    return;
  end if;

  v_half_window := v_strategy.news_window_minutes / 2.0;
  v_is_upcoming := v_news.minutes_to_event > 0;

  if v_is_upcoming then
    if v_strategy.news_posture = 'exploit' then
      return;
    end if;

    if v_news.impact = 'low' then
      return;
    end if;

    v_is_near      := abs(v_news.minutes_to_event) <= v_half_window;
    v_has_forecast := v_news.forecast is not null;

    v_base_mult     := case v_news.impact when 'high' then 0.4 else 0.7 end;
    v_forecast_adj  := case when v_has_forecast then 1.25 else 0.8 end;
    v_proximity_adj := case when v_is_near then 0.6 else 1.0 end;
    v_final_mult    := least(1.0, v_base_mult * v_forecast_adj * v_proximity_adj);

    if v_final_mult < 0.20 then
      v_new_decision := 'block';
    elsif v_final_mult < 0.90 then
      v_new_decision := 'downweight';
      update public.signals
         set suggested_volume = round(suggested_volume * v_final_mult, 2)
       where id = p_signal_id;
    else
      v_new_decision := 'ok';
    end if;

    v_current_rank := case v_signal.policy_decision when 'block' then 3 when 'downweight' then 2 else 1 end;
    v_new_rank     := case v_new_decision      when 'block' then 3 when 'downweight' then 2 else 1 end;

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
    v_base_ccy  := upper(left(v_signal.symbol, 3));
    v_quote_ccy := upper(right(v_signal.symbol, 3));
    if upper(v_news.currency) not in (v_base_ccy, v_quote_ccy) then
      v_has_direction_data := false;
    end if;
  end if;

  v_aligned := null;

  if v_has_direction_data then
    v_diff := v_news.actual - coalesce(v_news.forecast, v_news.previous);

    if v_diff = 0 then
      v_currency_bias := 'neutral';
    elsif (v_diff > 0) = v_news.effective_higher_is_bullish then
      v_currency_bias := 'bullish';
    else
      v_currency_bias := 'bearish';
    end if;

    if v_currency_bias != 'neutral' then
      v_pair_bullish := case when upper(v_news.currency) = v_base_ccy
                              then (v_currency_bias = 'bullish')
                              else (v_currency_bias = 'bearish')
                         end;
      v_implied_side := case when v_pair_bullish then 'buy' else 'sell' end;
      v_aligned := (v_signal.side = v_implied_side);
    end if;
  end if;

  if v_aligned is null then
    v_settle_minutes := least(v_strategy.news_window_minutes, 10);
    if abs(v_news.minutes_to_event) <= v_settle_minutes then
      update public.signals
         set suggested_volume = round(suggested_volume * 0.7, 2),
             policy_decision  = case when v_signal.policy_decision = 'ok' then 'downweight'
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
    update public.signals
       set suggested_volume = round(
             suggested_volume * v_strategy.news_exploit_size_multiplier
             * (case when v_signal.htf_regime = 'trending' then 1.25 else 1.0 end),
           2)
     where id = p_signal_id;
  end if;
end;
$function$

-- ===== apply_throttle_gate =====
CREATE OR REPLACE FUNCTION public.apply_throttle_gate(p_signal_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$

-- ===== apply_throttle_ladder =====
CREATE OR REPLACE FUNCTION public.apply_throttle_ladder(p_scenario_stats_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$

-- ===== compute_scenario_stats =====
CREATE OR REPLACE FUNCTION public.compute_scenario_stats(p_terminal_id uuid, p_strategy_id uuid, p_symbol text, p_session text, p_htf_regime text, p_near_news_event boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_trade_count int;
  v_win_count int;
  v_gross_profit numeric;
  v_gross_loss numeric;
  v_profit_factor numeric;
  v_expectancy numeric;
  v_avg_r numeric;
  v_raw_win_rate numeric;
  v_shrunk_win_rate numeric;
  v_recency_win_rate numeric;
  v_id uuid;
  -- Bayesian shrinkage prior: pulls small samples toward a neutral 45% win
  -- rate with a strength of 10 pseudo-trades, so an early 2-for-3 streak
  -- doesn't read as a durable 67% edge. Display metric only (see v1.0.4).
  c_prior_mean constant numeric := 0.45;
  c_prior_strength constant numeric := 10;
  -- Recency decay: each trade back in time is weighted 0.95^age, a ~13-trade
  -- half-life, so a hot/cold streak shows up before 20 trades accumulate.
  -- Display metric only.
  c_decay constant numeric := 0.95;
begin
  select
    count(*),
    count(*) filter (where th.outcome = 'win'),
    coalesce(sum(th.profit) filter (where th.profit > 0), 0),
    coalesce(sum(-th.profit) filter (where th.profit < 0), 0),
    avg(th.r_multiple)
  into v_trade_count, v_win_count, v_gross_profit, v_gross_loss, v_avg_r
  from public.trade_history th
  where th.terminal_id = p_terminal_id
    and th.strategy_id = p_strategy_id
    and th.symbol = p_symbol
    and th.session = p_session
    and th.htf_regime = p_htf_regime
    and th.near_news_event = p_near_news_event
    and th.is_hedge = false;

  v_profit_factor := case when v_gross_loss > 0 then v_gross_profit / v_gross_loss else null end;
  v_expectancy := case when v_trade_count > 0 then (v_gross_profit - v_gross_loss) / v_trade_count else null end;
  v_raw_win_rate := case when v_trade_count > 0 then v_win_count::numeric / v_trade_count else null end;
  v_shrunk_win_rate := case when v_trade_count + c_prior_strength > 0
    then (v_win_count + c_prior_mean * c_prior_strength) / (v_trade_count + c_prior_strength)
    else null end;

  select case when sum(w.weight) > 0 then sum(w.weight * (w.outcome = 'win')::int) / sum(w.weight) else null end
  into v_recency_win_rate
  from (
    select th.outcome, power(c_decay, (row_number() over (order by th.close_time desc) - 1)::numeric) as weight
    from public.trade_history th
    where th.terminal_id = p_terminal_id
      and th.strategy_id = p_strategy_id
      and th.symbol = p_symbol
      and th.session = p_session
      and th.htf_regime = p_htf_regime
      and th.near_news_event = p_near_news_event
      and th.is_hedge = false
  ) w;

  insert into public.scenario_stats (
    terminal_id, strategy_id, symbol, session, htf_regime, near_news_event,
    trade_count, win_count, raw_win_rate, shrunk_win_rate, recency_weighted_win_rate,
    avg_r_multiple, gross_profit, gross_loss, profit_factor, expectancy_per_trade, computed_at
  ) values (
    p_terminal_id, p_strategy_id, p_symbol, p_session, p_htf_regime, p_near_news_event,
    v_trade_count, v_win_count, v_raw_win_rate, v_shrunk_win_rate, v_recency_win_rate,
    v_avg_r, v_gross_profit, v_gross_loss, v_profit_factor, v_expectancy, now()
  )
  on conflict (terminal_id, strategy_id, symbol, session, htf_regime, near_news_event)
  do update set
    trade_count = excluded.trade_count,
    win_count = excluded.win_count,
    raw_win_rate = excluded.raw_win_rate,
    shrunk_win_rate = excluded.shrunk_win_rate,
    recency_weighted_win_rate = excluded.recency_weighted_win_rate,
    avg_r_multiple = excluded.avg_r_multiple,
    gross_profit = excluded.gross_profit,
    gross_loss = excluded.gross_loss,
    profit_factor = excluded.profit_factor,
    expectancy_per_trade = excluded.expectancy_per_trade,
    computed_at = excluded.computed_at
  returning id into v_id;

  return v_id;
end;
$function$

-- ===== effective_delivery_mode =====
CREATE OR REPLACE FUNCTION public.effective_delivery_mode(p_terminal_id uuid, p_strategy_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select case
           when not coalesce((select auto_trading_enabled from public.mt5_terminals where id = p_terminal_id), true)
             then 'manual_confirm'
           else coalesce((select delivery_mode from public.strategies where id = p_strategy_id), 'manual_confirm')
         end;
$function$

-- ===== guess_higher_is_bullish =====
CREATE OR REPLACE FUNCTION public.guess_higher_is_bullish(p_title text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select not (
    lower(p_title) ~ 'unemployment rate|unemployment claims|jobless claims|initial claims|continuing claims|unemployment change'
  );
$function$

-- ===== handle_new_user =====
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$function$

-- ===== ingest_calendar_events =====
CREATE OR REPLACE FUNCTION public.ingest_calendar_events(p_events jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  if p_events is null or jsonb_typeof(p_events) != 'array' then
    raise exception 'p_events must be a jsonb array';
  end if;

  for v_event in select * from jsonb_array_elements(p_events)
  loop
    v_idx := v_idx + 1;

    begin
      v_mql5_value_id := (v_event->>'mql5_value_id')::bigint;
    exception when others then
      v_mql5_value_id := null;
    end;
    if v_mql5_value_id is null then
      v_skipped := v_skipped || jsonb_build_object('index', v_idx, 'reason', 'missing_or_invalid_mql5_value_id');
      continue;
    end if;

    begin
      v_event_time := (v_event->>'event_time')::timestamptz;
    exception when others then
      v_event_time := null;
    end;
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

    v_is_global := (v_currency is null);
    v_affected_symbols := case when v_is_global then '{}'::text[]
                               else public.symbols_for_currency(v_currency) end;

    select id into v_existing_id
      from public.calendar_events
     where mql5_value_id = v_mql5_value_id;

    if v_existing_id is null then
      insert into public.calendar_events (
        event_time, country, impact, title, affected_symbols,
        currency, forecast, previous, actual, higher_is_bullish,
        source, mql5_event_id, mql5_value_id, is_global
      ) values (
        v_event_time,
        v_event->>'country',
        v_impact,
        v_title,
        v_affected_symbols,
        v_currency,
        (v_event->>'forecast')::numeric,
        (v_event->>'previous')::numeric,
        (v_event->>'actual')::numeric,
        (v_event->>'higher_is_bullish')::boolean,
        'mt5_calendar',
        nullif(v_event->>'mql5_event_id', '')::bigint,
        v_mql5_value_id,
        v_is_global
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
             -- Never clobber a manually-set override with a later sync.
             higher_is_bullish = coalesce(higher_is_bullish, (v_event->>'higher_is_bullish')::boolean),
             is_global = v_is_global
       where id = v_existing_id;
      v_updated := v_updated + 1;
    end if;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'skipped', v_skipped);
end;
$function$

-- ===== news_context =====
CREATE OR REPLACE FUNCTION public.news_context(p_symbol text, p_at timestamp with time zone, p_window_minutes integer DEFAULT 30, p_min_impact text DEFAULT 'low'::text)
 RETURNS TABLE(event_id uuid, title text, impact text, event_time timestamp with time zone, minutes_to_event numeric, currency text, forecast numeric, previous numeric, actual numeric, effective_higher_is_bullish boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select ce.id, ce.title, ce.impact, ce.event_time,
         round(extract(epoch from (ce.event_time - p_at)) / 60.0, 1),
         ce.currency, ce.forecast, ce.previous, ce.actual,
         coalesce(ce.higher_is_bullish, public.guess_higher_is_bullish(ce.title))
    from public.calendar_events ce
   where ce.event_time between p_at - (p_window_minutes || ' minutes')::interval
                            and p_at + (p_window_minutes || ' minutes')::interval
     and (ce.is_global or p_symbol = any (ce.affected_symbols))
     and case ce.impact when 'high' then 3 when 'medium' then 2 else 1 end
         >= case p_min_impact when 'high' then 3 when 'medium' then 2 else 1 end
   order by abs(extract(epoch from (ce.event_time - p_at))) asc
   limit 1;
$function$

-- ===== prune_old_price_bars =====
CREATE OR REPLACE FUNCTION public.prune_old_price_bars()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  delete from public.price_bars
  where bar_time < now() - interval '7 days';
end;
$function$

-- ===== set_updated_at =====
CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$

-- ===== sweep_stuck_commands =====
CREATE OR REPLACE FUNCTION public.sweep_stuck_commands()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  -- Rows that have already exhausted their retry budget: give up.
  update public.ea_commands
     set status = 'expired',
         error_message = coalesce(error_message, 'stuck_in_sent_status_expired_after_max_sweep_retries')
   where status = 'sent'
     and requested_at < now() - interval '5 minutes'
     and sweep_attempts >= 3;

  -- Rows still within budget: reset to 'queued' so ea-sync re-offers them
  -- to the EA on its next poll. EASync_ExecuteOpen's idempotency check
  -- (lucrehub:<command_id> position-comment lookup) protects against a
  -- duplicate order if the command actually executed the first time.
  update public.ea_commands
     set status = 'queued',
         sweep_attempts = sweep_attempts + 1
   where status = 'sent'
     and requested_at < now() - interval '5 minutes'
     and sweep_attempts < 3;
end;
$function$

-- ===== symbols_for_currency =====
CREATE OR REPLACE FUNCTION public.symbols_for_currency(p_currency text)
 RETURNS text[]
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(array_agg(distinct s.symbol), '{}')
    from (
      select symbol from public.symbol_settings
      union
      select symbol from public.positions
      union
      select symbol from public.signals
      union
      select symbol from public.trade_history
    ) s
   where p_currency is not null
     and length(s.symbol) = 6
     and (upper(left(s.symbol, 3)) = upper(p_currency)
          or upper(right(s.symbol, 3)) = upper(p_currency));
$function$

-- ===== throttle_sweep =====
CREATE OR REPLACE FUNCTION public.throttle_sweep()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  rec record;
  v_id uuid;
begin
  for rec in
    select terminal_id, strategy_id, symbol, session, htf_regime, near_news_event
    from public.scenario_stats
    union
    select terminal_id, strategy_id, symbol, session, htf_regime, near_news_event
    from public.trade_history
    where strategy_id is not null and session is not null and htf_regime is not null and is_hedge = false
  loop
    v_id := public.compute_scenario_stats(rec.terminal_id, rec.strategy_id, rec.symbol, rec.session, rec.htf_regime, rec.near_news_event);
    perform public.apply_throttle_ladder(v_id);
  end loop;
end;
$function$

-- ===== trg_recompute_scenario_on_trade_close =====
CREATE OR REPLACE FUNCTION public.trg_recompute_scenario_on_trade_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_scenario_id uuid;
begin
  if new.strategy_id is not null and new.session is not null and new.htf_regime is not null and new.is_hedge = false then
    v_scenario_id := public.compute_scenario_stats(new.terminal_id, new.strategy_id, new.symbol, new.session, new.htf_regime, new.near_news_event);
    perform public.apply_throttle_ladder(v_scenario_id);
  end if;
  return new;
end;
$function$

-- ===== trg_signals_apply_news_policy =====
CREATE OR REPLACE FUNCTION public.trg_signals_apply_news_policy()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  perform public.apply_news_policy(new.id);
  return new;
end;
$function$

-- ===== trg_signals_apply_throttle_gate =====
CREATE OR REPLACE FUNCTION public.trg_signals_apply_throttle_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  perform public.apply_throttle_gate(new.id);
  return new;
end;
$function$
