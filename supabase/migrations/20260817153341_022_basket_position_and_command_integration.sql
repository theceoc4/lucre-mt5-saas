alter table public.positions
  add column basket_state_id uuid references public.basket_state(id) on delete set null,
  add column is_hedge boolean not null default false,
  add column hedge_layer int;

alter table public.positions
  add constraint positions_hedge_layer_positive
    check (hedge_layer is null or hedge_layer > 0);

create index idx_positions_basket_state_id on public.positions(basket_state_id) where basket_state_id is not null;

comment on column public.positions.basket_state_id is
  'Which basket (mt5_terminals has one basket_state row at a time) this position was opened as part of. NULL for positions opened before the basket manager existed or outside basket tracking.';
comment on column public.positions.is_hedge is
  'true if this position is a hedge leg opened by the basket manager rather than a primary signal/manual entry. See hedge_links for the paired primary position and correlation-cluster detail.';
comment on column public.positions.hedge_layer is
  'Hedge stacking depth (1 = first hedge layer) when is_hedge is true, mirrored from hedge_links.hedge_layer for cheap filtering without a join. NULL when is_hedge is false.';

alter table public.trade_history
  add column close_reason text,
  add column basket_state_id uuid references public.basket_state(id) on delete set null,
  add column is_hedge boolean not null default false,
  add column hedge_layer int;

alter table public.trade_history
  add constraint trade_history_close_reason_check
    check (close_reason is null or close_reason in (
      'tp', 'sl', 'manual', 'agent', 'eod_flat', 'basket_flatten', 'ea_local_hard_stop'
    )),
  add constraint trade_history_hedge_layer_positive
    check (hedge_layer is null or hedge_layer > 0);

comment on column public.trade_history.close_reason is
  'Why the position closed. basket_flatten: server-issued flatten_basket command. ea_local_hard_stop: EA self-triggered flatten because max_basket_drawdown_pct was breached before a server command arrived (the defense-in-depth path, see mt5_terminals.max_basket_drawdown_pct). NULL for trades closed before this column was added.';
comment on column public.trade_history.basket_state_id is
  'Carried forward from positions.basket_state_id at close time, for basket-level P/L reporting on closed trades.';
comment on column public.trade_history.is_hedge is
  'Carried forward from positions.is_hedge at close time.';

alter table public.ea_commands
  drop constraint ea_commands_command_type_check;

alter table public.ea_commands
  add constraint ea_commands_command_type_check
    check (command_type in (
      'open', 'modify', 'close', 'hedge_open', 'flatten_basket', 'modify_sl_tp'
    ));

comment on column public.ea_commands.command_type is
  'open/modify/close: original per-position command set. hedge_open: basket manager opening a hedge leg (see hedge_links). flatten_basket: close every open position tied to one basket_state_id at once. modify_sl_tp: basket-manager-issued SL/TP adjustment distinct from a user-initiated modify (source stays auto_signal/dashboard_modify as appropriate; command_type distinguishes intent).';

alter table public.agent_policies
  add column decided_by text not null default 'auto_throttle';

alter table public.agent_policies
  add constraint agent_policies_decided_by_check
    check (decided_by in ('auto_throttle', 'llm_recommend', 'llm_auto', 'user_override'));

comment on column public.agent_policies.decided_by is
  'auto_throttle: fast deterministic rule-ladder decision (§9). llm_recommend/llm_auto: the analyst agent proposed/applied this decision. user_override: dashboard user manually forced this decision, which the throttle/LLM must not overwrite until it expires.';;
