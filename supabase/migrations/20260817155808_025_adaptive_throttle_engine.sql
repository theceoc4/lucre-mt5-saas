-- v1.0.5 — Adaptive Statistical Throttle Engine (architecture spec v0.2 §9),
-- fully implemented: deterministic, real-time, no LLM in the loop.
--
-- Three moving parts, all in Postgres so the engine works even if every
-- edge function / worker is down:
--
--   1. compute_scenario_stats(...)  — aggregates trade_history into a
--      scenario_stats row for one (terminal, strategy, symbol, session,
--      htf_regime, near_news_event) cell. Computes win-rate variants
--      (display only) AND profit_factor/expectancy_per_trade (the metrics
--      that actually drive decisions — see v1.0.4).
--   2. apply_throttle_ladder(...)   — reads a scenario_stats row, runs the
--      §9.2 rule ladder, and upserts the result into agent_policies,
--      respecting the §9.3 precedence rule (user_override is absolute; the
--      LLM may only tighten past the throttle-computed floor, never loosen
--      below it).
--   3. Two triggers into that pipeline:
--      a. trg_trade_history_recompute_scenario — AFTER INSERT on
--         trade_history, real-time, one cell.
--      b. throttle_sweep() on a pg_cron job every 15 minutes — backstop
--         recompute of every known cell, and the only place the
--         cooldown-based auto-recovery check runs for cells that are
--         currently blocked (a blocked cell generates no new signals, so
--         it can never re-trigger itself via new trade_history rows).
--
-- KNOWN LIMITATION (documented, not silently skipped): spec §9.2's
-- auto-recovery design gates unblocking on a *simulated profit factor from
-- shadow signals* — signals that still compute and log during the block
-- (status = 'skipped_throttle') get judged against what subsequent price
-- action would have done, with no execution required. That requires a
-- price/candle replay pipeline that does not exist yet anywhere in this
-- schema (no OHLC/tick storage). Implementing it here would mean silently
-- approximating "market data" that isn't real. Instead, apply_throttle_ladder
-- uses a time-based cooldown (5 days, matching the spec's cooldown_days) as
-- an interim, more permissive substitute: after cooldown elapses, the cell
-- reopens to real (tier-2-capped) trading so genuine stats resume
-- accumulating, rather than staying blocked forever. When a market-data
-- pipeline exists, replace the cooldown-elapsed check in step 2 below with
-- the shadow-signal simulated-PF gate the spec describes.

-- ---------------------------------------------------------------------------
-- Schema: agent_policies gains columns to track what the throttle engine
-- itself computed ("auto_*"), separate from the effective/applied decision
-- columns it already had — because §9.3 precedence means the effective
-- decision can come from the LLM or a user override instead.
-- ---------------------------------------------------------------------------

alter table public.agent_policies
  add column auto_tier int,
  add column auto_decision text,
  add column auto_downweight_factor numeric,
  add column auto_computed_at timestamptz,
  add column cooldown_until timestamptz;

alter table public.agent_policies
  add constraint agent_policies_auto_tier_range check (auto_tier is null or auto_tier between 0 and 3),
  add constraint agent_policies_auto_decision_check check (auto_decision is null or auto_decision in ('ok', 'downweight', 'block'));

comment on column public.agent_policies.auto_tier is
  'Rule-ladder tier (0-3) the throttle engine independently computed for this cell on its last run, per architecture spec v0.2 §9.2 — always kept fresh regardless of which layer (auto_throttle/llm_recommend/llm_auto/user_override) currently controls the effective decision/downweight_factor.';
comment on column public.agent_policies.auto_decision is 'What auto_throttle computed (ok/downweight/block), independent of the effective decision column.';
comment on column public.agent_policies.auto_downweight_factor is 'What auto_throttle computed as the multiplier, independent of the effective downweight_factor column.';
comment on column public.agent_policies.auto_computed_at is 'When the throttle engine last recomputed this cell (trigger-fired or sweep-fired).';
comment on column public.agent_policies.cooldown_until is 'Set when auto_tier=3 (blocked). Interim time-based substitute for the spec''s shadow-signal simulated-PF auto-recovery gate (not implemented — no price-replay pipeline exists yet); see migration 025 header.';

-- ---------------------------------------------------------------------------
-- Step 1: compute_scenario_stats — aggregate trade_history into one cell.
-- ---------------------------------------------------------------------------

create or replace function public.compute_scenario_stats(
  p_terminal_id uuid,
  p_strategy_id uuid,
  p_symbol text,
  p_session text,
  p_htf_regime text,
  p_near_news_event boolean
) returns uuid
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
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
$$;

comment on function public.compute_scenario_stats is
  'Aggregates trade_history into the scenario_stats row for one (terminal, strategy, symbol, session, htf_regime, near_news_event) cell. Returns the scenario_stats.id so the caller can feed it straight into apply_throttle_ladder.';

-- ---------------------------------------------------------------------------
-- Step 2: apply_throttle_ladder — the §9.2 rule ladder + §9.3 precedence.
-- ---------------------------------------------------------------------------

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
  -- Rule-ladder thresholds, architecture spec v0.2 §9.2.
  c_min_sample constant int := 20;
  c_cooldown_days constant int := 5;
  -- "Materially negative expectancy" (spec's tier-3 alternate trigger) is
  -- scoped to avg_r_multiple rather than raw expectancy_per_trade < 0:
  -- profit_factor < 1.0 already implies negative dollar expectancy for
  -- every tier-1/tier-2 cell, so gating tier 3 on expectancy_per_trade < 0
  -- would collapse the whole ladder into "block". avg_r_multiple is
  -- risk-normalized, so "losing more than 0.3R per trade on average" is a
  -- meaningful independent bar for "this is bad even if profit_factor looks
  -- borderline" (e.g. one oversized winner propping up the ratio).
  c_bad_avg_r constant numeric := -0.3;
begin
  select * into s from public.scenario_stats where id = p_scenario_stats_id;
  if not found then
    return;
  end if;

  -- 1. Ladder tier, purely from this cell's stats.
  if s.trade_count < c_min_sample then
    v_tier := 0; v_decision := 'ok'; v_downweight := 1.0;
    v_reason := format('insufficient sample (%s/%s trades) - full base risk', s.trade_count, c_min_sample);
  elsif s.profit_factor is null then
    -- gross_loss = 0: no losing trades yet. "Not yet disproven", not "infinitely good".
    v_tier := 0; v_decision := 'ok'; v_downweight := 1.0;
    v_reason := 'no losing trades yet in sample - full base risk';
  elsif s.profit_factor < 0.4 or (s.avg_r_multiple is not null and s.avg_r_multiple <= c_bad_avg_r) then
    v_tier := 3; v_decision := 'block'; v_downweight := 0;
    v_reason := format('profit factor %.2f, avg R %.2f - blocked, %s-day cooldown', s.profit_factor, coalesce(s.avg_r_multiple, 0), c_cooldown_days);
  elsif s.profit_factor < 0.7 then
    v_tier := 2; v_decision := 'downweight'; v_downweight := 0.5;
    v_reason := format('profit factor %.2f - tier 2 downweight, frequency capped', s.profit_factor);
  elsif s.profit_factor < 1.0 then
    v_tier := 1; v_decision := 'downweight'; v_downweight := 0.75;
    v_reason := format('profit factor %.2f - tier 1 downweight, extra confluence required', s.profit_factor);
  else
    v_tier := 0; v_decision := 'ok'; v_downweight := 1.0;
    v_reason := format('profit factor %.2f - performing, full base risk', s.profit_factor);
  end if;

  select * into existing from public.agent_policies
   where terminal_id = s.terminal_id and strategy_id = s.strategy_id and symbol = s.symbol
     and session = s.session and htf_regime = s.htf_regime and near_news_event = s.near_news_event;
  v_found := found;

  -- 2. Auto-recovery override: a blocked cell gets no new real trades, so
  -- step 1 will keep recomputing "block" against the same stale stats
  -- forever. Once cooldown elapses, force tier 2 probation so real trading
  -- (smaller, capped) resumes and genuine stats can accumulate again.
  -- See migration header for why this is time-based, not shadow-signal-based.
  if v_found and existing.decided_by = 'auto_throttle' and existing.decision = 'block'
     and existing.cooldown_until is not null and existing.cooldown_until <= now() then
    v_tier := 2; v_decision := 'downweight'; v_downweight := 0.5;
    v_reason := 'cooldown elapsed - auto-recovered to tier 2 probation (shadow-signal PF gate not yet implemented, see migration 025)';
  end if;

  -- cooldown_until always reflects the auto layer's OWN block timer,
  -- independent of which layer controls the effective decision below.
  v_final_cooldown := case when v_tier = 3 then
      case when v_found and existing.decision = 'block' and existing.cooldown_until is not null and existing.cooldown_until > now()
        then existing.cooldown_until -- already counting down - don't reset the clock on every recompute
        else now() + make_interval(days => c_cooldown_days)
      end
    else null
  end;

  -- 3. Precedence, architecture spec v0.2 §9.3: user_override is absolute.
  -- The LLM may only tighten past what the throttle floor independently
  -- computes - it may never leave the effective policy looser than this.
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
  -- updated_at is refreshed by the existing trg_agent_policies_updated_at trigger.
end;
$$;

comment on function public.apply_throttle_ladder is
  'Runs architecture spec v0.2 §9.2''s rule ladder against one scenario_stats row and upserts agent_policies, applying §9.3 precedence (user_override absolute; LLM may only tighten past the throttle floor) and time-based cooldown auto-recovery for blocked cells.';

-- ---------------------------------------------------------------------------
-- Step 3a: real-time trigger on trade_history close.
-- ---------------------------------------------------------------------------

create or replace function public.trg_recompute_scenario_on_trade_close() returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
  v_scenario_id uuid;
begin
  if new.strategy_id is not null and new.session is not null and new.htf_regime is not null and new.is_hedge = false then
    v_scenario_id := public.compute_scenario_stats(new.terminal_id, new.strategy_id, new.symbol, new.session, new.htf_regime, new.near_news_event);
    perform public.apply_throttle_ladder(v_scenario_id);
  end if;
  return new;
end;
$$;

comment on function public.trg_recompute_scenario_on_trade_close is
  'AFTER INSERT trigger on trade_history: recomputes and re-throttles the one affected (strategy, symbol, session, regime) cell in real time on every close. Skips manual/discretionary trades (strategy_id null) and hedge legs (is_hedge=true), which do not reflect a strategy''s signal quality.';

create trigger trg_trade_history_recompute_scenario
  after insert on public.trade_history
  for each row
  execute function public.trg_recompute_scenario_on_trade_close();

-- ---------------------------------------------------------------------------
-- Step 3b: 15-minute sweep backstop (architecture spec v0.2 §5.5) + pg_cron.
-- ---------------------------------------------------------------------------

create or replace function public.throttle_sweep() returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
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
$$;

comment on function public.throttle_sweep is
  'Backstop recompute of every known scenario cell (architecture spec v0.2 §5.5), scheduled every 15 minutes via pg_cron. Catches any cell the close-triggered path missed, and is the only place the cooldown-based auto-recovery check runs for a currently-blocked cell, since a block stops new signals (and therefore new trade_history rows) from ever firing the real-time trigger again.';

create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'throttle-sweep-15min') then
    perform cron.unschedule('throttle-sweep-15min');
  end if;
end $$;

select cron.schedule('throttle-sweep-15min', '*/15 * * * *', $cron$select public.throttle_sweep();$cron$);
;
