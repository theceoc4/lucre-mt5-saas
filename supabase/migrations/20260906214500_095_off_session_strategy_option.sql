-- v1.0.77 — make the weekend/off-session bucket an explicit, opt-in
-- strategy session instead of an unconditional engine block.

alter table public.signals drop constraint if exists signals_session_check;
alter table public.signals
  add constraint signals_session_check
  check (session in ('asia', 'london', 'ny', 'overlap', 'off_session'));

alter table public.strategies drop constraint if exists strategies_allowed_sessions_check;
alter table public.strategies
  add constraint strategies_allowed_sessions_check
  check (
    allowed_sessions <@ array['asia','london','overlap','ny','off_session']::text[]
    and cardinality(allowed_sessions) > 0
  );

comment on column public.strategies.allowed_sessions is
  'Sessions in which a strategy may evaluate. off_session is opt-in and covers the weekend boundary defined by market_session_utc().';
