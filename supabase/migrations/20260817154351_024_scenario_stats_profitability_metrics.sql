alter table public.scenario_stats
  add column gross_profit numeric not null default 0,
  add column gross_loss numeric not null default 0,
  add column profit_factor numeric,
  add column expectancy_per_trade numeric;

alter table public.scenario_stats
  add constraint scenario_stats_gross_profit_nonneg check (gross_profit >= 0),
  add constraint scenario_stats_gross_loss_nonneg check (gross_loss >= 0),
  add constraint scenario_stats_profit_factor_nonneg check (profit_factor is null or profit_factor >= 0);

comment on table public.scenario_stats is
  'The learning grid: one row per (terminal, strategy, symbol, session, htf_regime, near_news_event) cell, rebuilt by the nightly batch job / close-triggered recompute (Phase 4, not yet built). Win-rate columns (raw/shrunk/recency_weighted) are DISPLAY/context metrics only. The adaptive throttle engine (architecture spec v0.2 section 9.2) and agent_policies decisions must be driven by profit_factor and expectancy_per_trade/avg_r_multiple -- a strategy can be profitable at a 30% win rate (small losses, large wins) and unprofitable at a 70% win rate (large losses, small wins), so win rate alone must never gate a block/downweight decision.';
comment on column public.scenario_stats.gross_profit is
  'Sum of profit across winning trades in this cell (>= 0). Denominator-free half of profit_factor.';
comment on column public.scenario_stats.gross_loss is
  'Sum of |loss| across losing trades in this cell, stored as a non-negative magnitude (>= 0) so profit_factor = gross_profit / gross_loss reads the standard way.';
comment on column public.scenario_stats.profit_factor is
  'gross_profit / gross_loss. NULL when gross_loss = 0 (no losing trades yet in the cell -- treat as insufficient data to rule out, not as infinitely good). This is the primary metric architecture spec v0.2 section 9.2''s throttle rule ladder keys off (tier 1: 0.7-1.0, tier 2: 0.4-0.7, tier 3 block: less than 0.4).';
comment on column public.scenario_stats.expectancy_per_trade is
  'Average realized profit per trade in this cell, in account currency. Dollar-denominated complement to avg_r_multiple (which is risk-normalized/R-denominated) -- the throttle engine''s tier-3 block condition (materially negative expectancy) reads this or avg_r_multiple, never win_count/raw_win_rate.';
comment on column public.scenario_stats.raw_win_rate is
  'Context/display metric only -- percent of trades won in this cell. Not sufficient on its own to judge a strategy''s success: see profit_factor/expectancy_per_trade, which account for win/loss magnitude, not just count.';

comment on column public.agent_policies.decision is
  'Written by the adaptive throttle engine (decided_by = auto_throttle) primarily from scenario_stats.profit_factor and expectancy_per_trade/avg_r_multiple per architecture spec v0.2 section 9.2 -- never from win rate alone.';
;
