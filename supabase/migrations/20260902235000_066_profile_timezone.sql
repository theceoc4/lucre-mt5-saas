-- Store one IANA timezone per user so every dashboard surface can render the
-- same instant consistently across desktop and mobile. Null means "use the
-- current device timezone" until the user explicitly saves a preference.
alter table public.profiles
  add column if not exists timezone text;

alter table public.profiles
  drop constraint if exists profiles_timezone_length;

alter table public.profiles
  add constraint profiles_timezone_length
  check (timezone is null or char_length(timezone) between 1 and 100);

comment on column public.profiles.timezone is
  'User-selected IANA timezone used for dashboard display and chart bucketing; null follows the current device timezone.';
