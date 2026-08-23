-- v1.0.3 — Margin mode + broker regulatory class on mt5_terminals.
--
-- Backs the Basket & Exposure Manager (architecture spec v0.2 §6): hedging
-- behavior must branch on whether the account is a hedging, netting, or
-- exchange-style account (MQL5 ACCOUNT_MARGIN_MODE), and on whether the
-- broker is US/NFA-regulated (FIFO + no-hedging compliance rules apply).
-- Both are read from the EA at heartbeat time via AccountInfoInteger, not
-- known at terminal-creation time, so both are nullable/defaulted here and
-- populated by the ea-sync edge function on first heartbeat after this
-- migration ships.

alter table public.mt5_terminals
  add column margin_mode text,
  add column broker_regulatory_class text not null default 'unknown';

alter table public.mt5_terminals
  add constraint mt5_terminals_margin_mode_check
    check (margin_mode is null or margin_mode in ('hedging', 'netting', 'exchange')),
  add constraint mt5_terminals_broker_regulatory_class_check
    check (broker_regulatory_class in ('us_nfa', 'international', 'unknown'));

comment on column public.mt5_terminals.margin_mode is
  'MQL5 ACCOUNT_MARGIN_MODE reported by the EA at heartbeat time: hedging (independent opposing positions allowed), netting (opposing orders net into one position), or exchange (exchange-traded, position netting by contract). NULL until the first heartbeat after this column was added. The basket manager uses this to decide whether a hedge_open command opens a second independent position or must instead reduce the net position.';
comment on column public.mt5_terminals.broker_regulatory_class is
  'us_nfa brokers are bound by NFA Compliance Rule 2-43b (no hedging, FIFO close order); international brokers generally are not. Defaults to unknown until the user confirms it (dashboard onboarding) or it is inferred from the broker/server name. The basket manager refuses hedge_open commands on us_nfa terminals and falls back to same-direction adds instead.';;
