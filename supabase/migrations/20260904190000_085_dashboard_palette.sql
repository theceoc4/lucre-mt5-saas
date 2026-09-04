-- v1.0.60 -- persist the user's dashboard palette across devices.

alter table public.profiles
  add column if not exists dashboard_palette text not null default 'lucre';

alter table public.profiles
  drop constraint if exists profiles_dashboard_palette_allowed;

alter table public.profiles
  add constraint profiles_dashboard_palette_allowed
  check (dashboard_palette in ('lucre', 'soleau-gold'));

comment on column public.profiles.dashboard_palette is
  'Private user-selected dashboard color palette. Light/dark display mode remains independent.';
