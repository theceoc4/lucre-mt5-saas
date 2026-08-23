alter table public.ea_commands
  add column session text check (session in ('asia', 'london', 'ny', 'overlap')),
  add column htf_regime text check (htf_regime in ('trending', 'ranging')),
  add column near_news_event boolean not null default false,
  add column news_event_id uuid references public.calendar_events(id) on delete set null;

comment on column public.ea_commands.session is
  'Trading session at command creation time (asia/london/ny/overlap), computed from the request timestamp (UTC) for manual/tap commands; inherited from the signal for auto_signal commands.';
comment on column public.ea_commands.htf_regime is
  'Higher-timeframe regime (trending/ranging) at command creation time. Populated for auto_signal commands via the signal engine. NULL for manual/tap commands until a standalone regime-detection source is wired up (tracked as follow-up work) — scenario_stats treats NULL as its own bucket rather than silently mislabeling a regime.';
comment on column public.ea_commands.near_news_event is
  'Whether a calendar_events row with impact medium/high falls within the near-news window of the command''s creation time, computed at insert time for every source.';
comment on column public.ea_commands.news_event_id is
  'The specific calendar_events row that triggered near_news_event = true, if any.';

create index idx_ea_commands_news_event_id on public.ea_commands(news_event_id);;
