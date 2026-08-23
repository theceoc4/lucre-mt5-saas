create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  event_time timestamptz not null,
  country text,
  impact text not null check (impact in ('low', 'medium', 'high')),
  title text not null,
  affected_symbols text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index idx_calendar_events_event_time on public.calendar_events(event_time);
;
