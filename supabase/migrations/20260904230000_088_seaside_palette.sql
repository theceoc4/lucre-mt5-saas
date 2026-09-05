-- v1.0.66 -- allow the Seaside dashboard palette.

alter table public.profiles
  drop constraint if exists profiles_dashboard_palette_allowed;

alter table public.profiles
  add constraint profiles_dashboard_palette_allowed
  check (dashboard_palette in ('lucre', 'soleau-gold', 'seaside'));

comment on column public.profiles.dashboard_palette is
  'Private user-selected dashboard color palette: Lucre Sage, Soleau Gold, or Seaside. Light/dark display mode remains independent.';
