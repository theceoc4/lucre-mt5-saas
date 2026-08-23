alter table public.mt5_terminals
  add column allow_long boolean not null default true,
  add column allow_short boolean not null default true,
  add column daily_profit_target_pct numeric,
  add column risk_appetite text not null default 'balanced',
  add column hedging_enabled boolean not null default false,
  add column hedge_trigger_drawdown_pct numeric not null default 0.5,
  add column basket_profit_lock_pct numeric not null default 0.15,
  add column max_basket_exposure_lots numeric,
  add column max_hedge_layers int not null default 3,
  add column max_basket_drawdown_pct numeric not null default 3.0;

alter table public.mt5_terminals
  add constraint mt5_terminals_risk_appetite_check
    check (risk_appetite in ('conservative', 'balanced', 'aggressive')),
  add constraint mt5_terminals_daily_profit_target_pct_positive
    check (daily_profit_target_pct is null or daily_profit_target_pct > 0),
  add constraint mt5_terminals_hedge_trigger_drawdown_pct_positive
    check (hedge_trigger_drawdown_pct > 0),
  add constraint mt5_terminals_basket_profit_lock_pct_positive
    check (basket_profit_lock_pct > 0),
  add constraint mt5_terminals_max_basket_exposure_lots_positive
    check (max_basket_exposure_lots is null or max_basket_exposure_lots > 0),
  add constraint mt5_terminals_max_hedge_layers_positive
    check (max_hedge_layers > 0),
  add constraint mt5_terminals_max_basket_drawdown_pct_positive
    check (max_basket_drawdown_pct > 0);

comment on column public.mt5_terminals.allow_long is
  'Account-wide default for whether new signals/manual orders may open long. strategies.allow_long overrides this per strategy when not null (migration 020).';
comment on column public.mt5_terminals.allow_short is
  'Same as allow_long, for short.';
comment on column public.mt5_terminals.daily_profit_target_pct is
  'Optional daily profit target as a % of day-start balance. Once hit, the dynamic sizing state machine (§7.2) throttles new position size for the rest of the trading day; NULL disables target-based throttling.';
comment on column public.mt5_terminals.risk_appetite is
  'Coarse risk band the dynamic sizing formula (§7) scales the base per-trade risk % against. balanced is the neutral multiplier.';
comment on column public.mt5_terminals.hedging_enabled is
  'Explicit opt-in required before the basket manager will ever issue a hedge_open command for this terminal, independent of margin_mode/broker_regulatory_class support. Defaults off.';
comment on column public.mt5_terminals.hedge_trigger_drawdown_pct is
  'Combined floating loss, as a % of balance, at which the basket state machine (§6) transitions flat/building/monitoring -> defending and becomes eligible to open a hedge.';
comment on column public.mt5_terminals.basket_profit_lock_pct is
  'Combined floating profit, as a % of balance, at which the basket manager locks in gains (tightens trailing stops / partial close) rather than letting the basket ride.';
comment on column public.mt5_terminals.max_basket_exposure_lots is
  'Hard cap on combined open lots (all directions, all strategies) for this terminal. NULL means no basket-level cap beyond the existing per-order max_manual_lot_size / max_open_positions ceilings.';
comment on column public.mt5_terminals.max_hedge_layers is
  'Hard cap on hedge_links.hedge_layer depth the basket manager will stack for this terminal before refusing further hedge_open commands.';
comment on column public.mt5_terminals.max_basket_drawdown_pct is
  'Combined floating loss, as a % of balance, at which flatten_basket is triggered server-side. The EA independently enforces this same cap locally as a defense-in-depth hard stop (close_reason ea_local_hard_stop, migration 022) in case the server cannot reach it in time.';;
