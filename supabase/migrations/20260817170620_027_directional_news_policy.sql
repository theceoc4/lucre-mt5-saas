-- v1.0.7 — Directional news policy: graduated pre-news caution, alignment-
-- aware post-news encouragement.
--
-- v1.0.6 gave the news filter three static postures (avoid/neutral/exploit)
-- but two things about it were too blunt:
--   1. 'avoid' treated every qualifying high-impact event the same
--      (block inside half the window, downweight otherwise) regardless of
--      whether the market already had a published consensus forecast for
--      it.
--   2. 'exploit' boosted suggested_volume near ANY qualifying event,
--      whether or not the signal's own direction had anything to do with
--      what the news actually did.
--
-- See migrations/027_directional_news_policy.sql in the repo for the
-- full design rationale (kept in the file; abbreviated here for the
-- migration tool).

-- ---------------------------------------------------------------------
-- A1. Economic calendar gains forecast/actual/currency data
-- ---------------------------------------------------------------------
alter table public.calendar_events
  add column currency text,
  add column forecast numeric,
  add column previous numeric,
  add column actual numeric,
  add column higher_is_bullish boolean;

alter table public.calendar_events
  add constraint calendar_events_currency_format
    check (currency is null or currency ~ '^[A-Z]{3}$');

comment on column public.calendar_events.currency is
  'Three-letter currency this event pertains to (e.g. USD). Required for '
  'apply_news_policy() to compute a directional bias for a specific pair; '
  'events with no currency (e.g. a global holiday) never trigger the '
  'post-news directional logic.';
comment on column public.calendar_events.actual is
  'Populated when the event releases. Nothing in this Supabase project '
  'ingests this from a live calendar feed yet (same gap as the external '
  'signal-engine worker, spec §5.1) — stays null until a future '
  'ingestion job writes it. apply_news_policy() degrades gracefully to '
  'its documented unknown-direction fallback while this is null.';
comment on column public.calendar_events.higher_is_bullish is
  'Per-event override: does a higher actual-vs-baseline value mean good '
  'news for `currency`? Null defers to public.guess_higher_is_bullish() '
  '(a keyword heuristic — e.g. false for unemployment rate/jobless '
  'claims, true otherwise). Set explicitly for anything the heuristic '
  'would get wrong.';

-- ---------------------------------------------------------------------
-- A2. Best-guess "higher is good news for the currency" classifier.
-- ---------------------------------------------------------------------
create or replace function public.guess_higher_is_bullish(p_title text)
returns boolean
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select not (
    lower(p_title) ~ 'unemployment rate|unemployment claims|jobless claims|initial claims|continuing claims|unemployment change'
  );
$$;

comment on function public.guess_higher_is_bullish is
  'Best-guess default for calendar_events.higher_is_bullish when not set '
  'explicitly. False (higher = bad news for the currency) only for '
  'well-known inverse indicators (unemployment rate/claims); true '
  'otherwise (NFP, GDP, retail sales, PMI, etc. — a beat is good news).';

-- ---------------------------------------------------------------------
-- A3. news_context() — extended to surface the data Phase 2 needs.
-- Return shape changed, so drop + recreate rather than CREATE OR REPLACE.
-- ---------------------------------------------------------------------
drop function if exists public.news_context(text, timestamptz, int, text);

create function public.news_context(
  p_symbol text,
  p_at timestamptz,
  p_window_minutes int default 30,
  p_min_impact text default 'low'
) returns table (
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
set search_path to 'public', 'pg_temp'
as $$
  select ce.id, ce.title, ce.impact, ce.event_time,
         round(extract(epoch from (ce.event_time - p_at)) / 60.0, 1),
         ce.currency, ce.forecast, ce.previous, ce.actual,
         coalesce(ce.higher_is_bullish, public.guess_higher_is_bullish(ce.title))
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
  'Nearest qualifying calendar event for a symbol at a point in time, '
  'within +/- window_minutes and at/above min_impact, including '
  'forecast/previous/actual and the resolved higher_is_bullish flag for '
  'directional-bias computation in apply_news_policy().';

-- ---------------------------------------------------------------------
-- A4. apply_news_policy() — rewritten two-phase version.
-- ---------------------------------------------------------------------
create or replace function public.apply_news_policy(p_signal_id uuid)
returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
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
$$;

comment on function public.apply_news_policy is
  'Two-phase news policy run automatically by trg_signals_apply_news_policy '
  'on every new signal. Phase 1 (event still upcoming): graduated '
  'pre-news caution scaled by impact/forecast-presence/proximity, avoid '
  'posture only. Phase 2 (event already released): computes a '
  'directional bias for the signal''s specific symbol from actual vs '
  'forecast-or-previous and blocks signals opposed to it, boosts aligned '
  'exploit-posture signals (extra multiplier if htf_regime = trending), '
  'and applies a brief settle-window caution when direction can''t be '
  'determined. See migrations/027_directional_news_policy.sql header for '
  'the full design rationale.';;
