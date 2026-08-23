alter table public.strategies
  add column signal_family text not null default 'momentum',
  add column allow_long boolean,
  add column allow_short boolean;

alter table public.strategies
  alter column signal_family drop default;

alter table public.strategies
  add constraint strategies_signal_family_check
    check (signal_family in (
      'momentum',
      'vwap_reversion',
      'breakout',
      'trend_pullback',
      'trend_swing',
      'support_resistance_bounce',
      'support_resistance_break',
      'reversal_climax'
    ));

comment on column public.strategies.signal_family is
  'Market-behavior grouping, orthogonal to kind (the implementation). See architecture spec v0.2 §5.2 for the S1-S10 catalog and family mapping. No default going forward — required at creation time; the transient default above only exists to satisfy NOT NULL while the table has 0 rows.';
comment on column public.strategies.allow_long is
  'Per-strategy override of mt5_terminals.allow_long. NULL inherits the account-wide default; false/true here forces that direction off/on for this strategy regardless of the account default.';
comment on column public.strategies.allow_short is
  'Same as allow_long, for short.';;
