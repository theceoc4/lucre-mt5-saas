-- v1.0.23 — keep MT5 trade profit and account-net P/L as distinct values.
-- The deal ledger is authoritative and includes both entry and exit costs.

with position_totals as (
  select
    terminal_id,
    position_id,
    sum(profit) as trade_profit,
    sum(profit + commission + swap + fee) as net_profit
  from public.mt5_account_history
  where position_id is not null
  group by terminal_id, position_id
)
update public.trade_history as th
set
  profit = totals.trade_profit,
  net_profit = totals.net_profit,
  outcome = case
    when totals.net_profit > 0 then 'win'
    when totals.net_profit < 0 then 'loss'
    else 'breakeven'
  end
from position_totals as totals
where th.terminal_id = totals.terminal_id
  and th.mt5_ticket = totals.position_id
  and th.profit_verified = true;

update public.trade_history
set net_profit = profit
where net_profit is null;

comment on column public.trade_history.profit is
  'Gross MT5 deal profit for the full position, excluding commission, swap and fees.';

comment on column public.trade_history.net_profit is
  'Realized account-currency P/L inclusive of entry and exit commission, swap and fees when MT5 deal data is available.';
