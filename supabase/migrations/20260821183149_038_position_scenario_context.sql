alter table public.positions
  add column if not exists session text,
  add column if not exists htf_regime text,
  add column if not exists near_news_event boolean not null default false,
  add column if not exists news_event_id uuid references public.calendar_events(id);

comment on column public.positions.session is 'Trading session (asia/london/ny/overlap) captured from the originating open ea_commands row when this position was first reported by the EA. Propagated onto trade_history at close so scenario_stats can group by it.';
comment on column public.positions.htf_regime is 'Higher-timeframe regime tag captured from the originating open ea_commands row. Propagated onto trade_history at close.';
comment on column public.positions.near_news_event is 'Whether the opening signal fired near a high-impact calendar event, captured from the originating open ea_commands row.';
comment on column public.positions.news_event_id is 'calendar_events.id the opening signal was near, if any, captured from the originating open ea_commands row.';
;
