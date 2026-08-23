-- v1.0.8 — Native MT5 calendar ingestion worker.
--
-- Closes the "known limitation" documented in v1.0.7 (CHANGELOG/README):
-- nothing ingested calendar_events.currency/forecast/previous/actual from a
-- real source, so apply_news_policy()'s Phase 2 directional logic always
-- fell back to the unknown-direction branch. This migration adds the
-- schema + RPC a new calendar-sync edge function uses to accept calendar
-- data pushed by the MT5 EA (which reads it from MetaTrader's own native
-- Economic Calendar API — CalendarValueHistory/CalendarValueLast — the
-- data source the user chose, since there is no public HTTP endpoint for
-- MT5's calendar; it only exists inside a running terminal/EA process).
-- The EA is already the sole inbound bridge for terminal data (ea-sync,
-- v1.0.0) — this reuses the exact same x-api-key terminal-auth model
-- rather than introducing a second credential type.
--
-- Three things, in order:
--
--   A. calendar_events gains ingestion metadata:
--        source          'manual' | 'mt5_calendar' — provenance tag.
--        mql5_event_id   MQL5 MqlCalendarEvent.id (the event *definition*,
--                        e.g. "US Non-Farm Payrolls" — recurs every release).
--        mql5_value_id   MQL5 MqlCalendarValue.id (one specific *occurrence*
--                        of that event) — globally unique per release, so
--                        it is the natural idempotency key for upserts. A
--                        release's forecast is known days ahead and its
--                        actual lands later; both writes hit the same row
--                        via this key rather than creating duplicates.
--
--   B. Bug fix uncovered while designing the ingestion path:
--      affected_symbols = '{}' has been overloaded since v1.0.6 to mean
--      "global event, matches every symbol" (see migration 026 comment).
--      That was a safe assumption when every calendar_events row was
--      inserted by hand for genuinely macro events (FOMC, NFP). It stops
--      being safe once a worker ingests *every* MT5 calendar release: a
--      currency with no currently-tracked symbol (say NZD, if nothing
--      NZD-denominated is traded) would compute an empty affected_symbols
--      array by simple absence-of-match — which the old '{}' == global
--      check would then silently broadcast to EVERY symbol, including
--      completely unrelated pairs. This migration adds an explicit
--      `is_global` flag so "no known symbols currently match this
--      currency" and "this event is intentionally global" are no longer
--      the same bit pattern. Existing hand-inserted rows (affected_symbols
--      = '{}') are backfilled to is_global = true so their behavior is
--      unchanged; news_context() is updated to key off is_global instead
--      of the array-emptiness heuristic.
--
--   C. public.symbols_for_currency(text) + public.ingest_calendar_events
--      (jsonb) — the batch upsert RPC the new calendar-sync edge function
--      calls. Locked to service_role only: this writes shared reference
--      data no per-user JWT should be able to touch (same reasoning as
--      the pre-existing `revoke insert, update, delete on calendar_events
--      from authenticated` in migration 011).

-- ---------------------------------------------------------------------
-- A. Ingestion metadata + idempotency key
-- ---------------------------------------------------------------------
alter table public.calendar_events
  add column source text not null default 'manual'
    check (source in ('manual', 'mt5_calendar')),
  add column mql5_event_id bigint,
  add column mql5_value_id bigint,
  add column is_global boolean not null default false;

create unique index idx_calendar_events_mql5_value_id
  on public.calendar_events(mql5_value_id)
  where mql5_value_id is not null;

comment on column public.calendar_events.source is
  'Provenance: manual (hand-inserted, e.g. test fixtures) or mt5_calendar '
  '(written by calendar-sync from the MT5 EA''s native Economic Calendar '
  'feed via ingest_calendar_events()).';
comment on column public.calendar_events.mql5_value_id is
  'MQL5 MqlCalendarValue.id — identifies one specific release occurrence. '
  'Globally unique per release, used as the upsert key so a forecast '
  'written ahead of release and the actual written after it land on the '
  'same row instead of duplicating it. Null for manual/fixture rows.';
comment on column public.calendar_events.mql5_event_id is
  'MQL5 MqlCalendarEvent.id — identifies the recurring event definition '
  '(e.g. "US Non-Farm Payrolls"), shared across many mql5_value_id '
  'occurrences of the same event. Informational; not used for dedup.';

-- ---------------------------------------------------------------------
-- B. is_global correctness fix
-- ---------------------------------------------------------------------
update public.calendar_events
   set is_global = true
 where affected_symbols = '{}';

comment on column public.calendar_events.is_global is
  'Explicit flag: this event matches every symbol regardless of '
  'affected_symbols (macro releases like FOMC/NFP with no single '
  'currency, or a country-wide holiday). Replaces the pre-v1.0.8 '
  'overload where affected_symbols = ''{}'' meant global — that broke '
  'once a worker could ingest currency-tagged events for a currency with '
  'no currently-tracked symbol, which would otherwise compute an empty '
  'affected_symbols array by coincidence and get treated as global.';

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
     and (ce.is_global or p_symbol = any (ce.affected_symbols))
     and case ce.impact when 'high' then 3 when 'medium' then 2 else 1 end
         >= case p_min_impact when 'high' then 3 when 'medium' then 2 else 1 end
   order by abs(extract(epoch from (ce.event_time - p_at))) asc
   limit 1;
$$;

comment on function public.news_context is
  'Nearest qualifying calendar event for a symbol at a point in time, '
  'within +/- window_minutes and at/above min_impact, including '
  'forecast/previous/actual and the resolved higher_is_bullish flag. '
  'Global events match via is_global (v1.0.8); affected_symbols is the '
  'explicit currency-derived symbol list for non-global events.';

-- ---------------------------------------------------------------------
-- C1. symbols_for_currency — distinct symbols currently referenced
-- anywhere in the schema whose base or quote leg matches a currency.
-- Used only to compute affected_symbols at ingestion time; read-only,
-- no side effects.
-- ---------------------------------------------------------------------
create or replace function public.symbols_for_currency(p_currency text)
returns text[]
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
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
$$;

comment on function public.symbols_for_currency is
  'Distinct 6-char FX symbols seen anywhere in the schema (symbol_settings, '
  'positions, signals, trade_history) whose base or quote currency matches '
  'p_currency. Used by ingest_calendar_events() to derive affected_symbols '
  'for a currency-tagged event without a hardcoded symbol universe. '
  'Returns {} (not global — see is_global) when p_currency is null or no '
  'currently-tracked symbol matches it.';

revoke execute on function public.symbols_for_currency(text) from public, anon, authenticated;
grant execute on function public.symbols_for_currency(text) to service_role;

-- ---------------------------------------------------------------------
-- C2. ingest_calendar_events — batch upsert RPC called by calendar-sync.
--
-- p_events is a jsonb array of objects:
--   {
--     mql5_value_id: number (required, bigint-safe integer),
--     mql5_event_id: number | null,
--     event_time: string (ISO 8601, required),
--     country: string | null,
--     currency: string | null (3-letter ISO, or null for a currency-less
--               event such as a country holiday),
--     impact: 'low' | 'medium' | 'high' (required — the edge function
--             maps MQL5's CALENDAR_IMPORTANCE enum before calling this),
--     title: string (required),
--     forecast: number | null,
--     previous: number | null,
--     actual: number | null,
--     higher_is_bullish: boolean | null (only applied on first insert —
--             never overwrites an existing manual override, see below)
--   }
--
-- Returns { inserted: int, updated: int, skipped: [{index, reason}] }.
-- Invalid rows (missing required field, bad impact/currency) are skipped
-- individually rather than failing the whole batch, since one malformed
-- calendar row should never block ingestion of the other 100+ in the
-- same sync.
-- ---------------------------------------------------------------------
create or replace function public.ingest_calendar_events(p_events jsonb)
returns jsonb
language plpgsql
set search_path to 'public', 'pg_temp'
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
$$;

comment on function public.ingest_calendar_events is
  'Batch upsert for calendar_events, keyed on mql5_value_id. Called by the '
  'calendar-sync edge function with a jsonb array of events read from the '
  'MT5 EA''s native Economic Calendar feed. Invalid rows are skipped '
  'individually (see skipped[] in the return value) rather than failing '
  'the batch. service_role only.';

revoke execute on function public.ingest_calendar_events(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_calendar_events(jsonb) to service_role;
;
