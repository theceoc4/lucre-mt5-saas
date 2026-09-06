-- Make net account impact the single P/L contract for live positions and
-- scenario analytics. Gross broker profit remains stored for auditability.

alter table public.positions
  add column if not exists commission numeric not null default 0,
  add column if not exists fee numeric not null default 0;

alter table public.mt5_terminals
  add column if not exists positions_commission numeric not null default 0,
  add column if not exists positions_fee numeric not null default 0;

comment on column public.positions.commission is
  'Commission already charged on entry deals belonging to the still-open MT5 position.';
comment on column public.positions.fee is
  'Broker fees already charged on entry deals belonging to the still-open MT5 position.';
comment on column public.mt5_terminals.floating_pl is
  'Net open-position P/L: position profit plus swap, entry commission and entry fees.';

-- Best-effort backfill for currently open positions. EA v1.51 becomes the
-- authoritative source on its next durable snapshot.
with entry_costs as (
  select terminal_id, position_id,
    coalesce(sum(commission), 0) as commission,
    coalesce(sum(fee), 0) as fee
  from public.mt5_account_history
  where position_id is not null and entry_type in (0, 2)
  group by terminal_id, position_id
)
update public.positions p set
  commission = c.commission,
  fee = c.fee
from entry_costs c
where p.terminal_id = c.terminal_id
  and p.mt5_ticket = c.position_id
  and p.status <> 'closed';

create or replace function public.compute_scenario_stats(
  p_terminal_id uuid,
  p_strategy_id uuid,
  p_symbol text,
  p_session text,
  p_htf_regime text,
  p_near_news_event boolean
) returns uuid
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_trade_count int;
  v_win_count int;
  v_gross_profit numeric;
  v_gross_loss numeric;
  v_profit_factor numeric;
  v_expectancy numeric;
  v_avg_r numeric;
  v_raw_win_rate numeric;
  v_shrunk_win_rate numeric;
  v_recency_win_rate numeric;
  v_id uuid;
  c_prior_mean constant numeric := 0.45;
  c_prior_strength constant numeric := 10;
  c_decay constant numeric := 0.95;
begin
  select
    count(*),
    count(*) filter (where coalesce(th.net_profit, th.profit) > 0),
    coalesce(sum(coalesce(th.net_profit, th.profit)) filter (where coalesce(th.net_profit, th.profit) > 0), 0),
    coalesce(sum(-coalesce(th.net_profit, th.profit)) filter (where coalesce(th.net_profit, th.profit) < 0), 0),
    avg(th.r_multiple)
  into v_trade_count, v_win_count, v_gross_profit, v_gross_loss, v_avg_r
  from public.trade_history th
  where th.terminal_id = p_terminal_id
    and th.strategy_id = p_strategy_id
    and th.symbol = p_symbol
    and th.session = p_session
    and th.htf_regime = p_htf_regime
    and th.near_news_event = p_near_news_event
    and th.is_hedge = false
    and th.profit_verified = true;

  v_profit_factor := case when v_gross_loss > 0 then v_gross_profit / v_gross_loss else null end;
  v_expectancy := case when v_trade_count > 0 then (v_gross_profit - v_gross_loss) / v_trade_count else null end;
  v_raw_win_rate := case when v_trade_count > 0 then v_win_count::numeric / v_trade_count else null end;
  v_shrunk_win_rate := case when v_trade_count + c_prior_strength > 0
    then (v_win_count + c_prior_mean * c_prior_strength) / (v_trade_count + c_prior_strength)
    else null end;

  select case when sum(w.weight) > 0
    then sum(w.weight * (w.net_profit > 0)::int) / sum(w.weight)
    else null end
  into v_recency_win_rate
  from (
    select coalesce(th.net_profit, th.profit) as net_profit,
      power(c_decay, (row_number() over (order by th.close_time desc) - 1)::numeric) as weight
    from public.trade_history th
    where th.terminal_id = p_terminal_id
      and th.strategy_id = p_strategy_id
      and th.symbol = p_symbol
      and th.session = p_session
      and th.htf_regime = p_htf_regime
      and th.near_news_event = p_near_news_event
      and th.is_hedge = false
      and th.profit_verified = true
  ) w;

  insert into public.scenario_stats (
    terminal_id, strategy_id, symbol, session, htf_regime, near_news_event,
    trade_count, win_count, raw_win_rate, shrunk_win_rate, recency_weighted_win_rate,
    avg_r_multiple, gross_profit, gross_loss, profit_factor, expectancy_per_trade, computed_at
  ) values (
    p_terminal_id, p_strategy_id, p_symbol, p_session, p_htf_regime, p_near_news_event,
    v_trade_count, v_win_count, v_raw_win_rate, v_shrunk_win_rate, v_recency_win_rate,
    v_avg_r, v_gross_profit, v_gross_loss, v_profit_factor, v_expectancy, now()
  )
  on conflict (terminal_id, strategy_id, symbol, session, htf_regime, near_news_event)
  do update set
    trade_count = excluded.trade_count,
    win_count = excluded.win_count,
    raw_win_rate = excluded.raw_win_rate,
    shrunk_win_rate = excluded.shrunk_win_rate,
    recency_weighted_win_rate = excluded.recency_weighted_win_rate,
    avg_r_multiple = excluded.avg_r_multiple,
    gross_profit = excluded.gross_profit,
    gross_loss = excluded.gross_loss,
    profit_factor = excluded.profit_factor,
    expectancy_per_trade = excluded.expectancy_per_trade,
    computed_at = excluded.computed_at
  returning id into v_id;

  return v_id;
end;
$function$;

-- Rebuild the adaptive scenario cache so its win rate, profit factor and
-- expectancy immediately reflect costs rather than waiting for the next close.
select public.throttle_sweep();
