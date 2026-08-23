alter table public.positions add column if not exists closing_since timestamptz;

alter table public.trade_history add column if not exists profit_verified boolean not null default true;

alter table public.trade_history drop constraint if exists trade_history_close_reason_check;
alter table public.trade_history add constraint trade_history_close_reason_check
  check (close_reason is null or close_reason = any (array['tp','sl','manual','agent','eod_flat','basket_flatten','ea_local_hard_stop','reconciled_missing_ea_report']));
;
