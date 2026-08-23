alter table public.ea_commands
  add column sl_pips numeric,
  add column tp_pips numeric,
  add constraint ea_commands_sl_pips_positive check (sl_pips is null or sl_pips > 0),
  add constraint ea_commands_tp_pips_positive check (tp_pips is null or tp_pips > 0);

comment on column public.ea_commands.sl_pips is
  'Optional stop-loss distance in pips from the fill price. Set instead of an absolute sl when the caller (currently only the Pairs view''s quick Buy/Sell with Auto SL/TP) has no live price to compute one. The EA resolves this to an absolute sl at execution time using its own current price. NULL when sl already carries an absolute value, or no stop was requested.';
comment on column public.ea_commands.tp_pips is
  'Same as sl_pips, for take-profit.';
;
