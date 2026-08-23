create index idx_hedge_links_opposing_position_id
  on public.hedge_links(opposing_position_id)
  where opposing_position_id is not null;

create index idx_trade_history_basket_state_id
  on public.trade_history(basket_state_id)
  where basket_state_id is not null;;
