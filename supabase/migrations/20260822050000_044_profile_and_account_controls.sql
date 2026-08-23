-- Private profile fields now; no public/profile-discovery policy is added.
alter table public.profiles
  add column if not exists bio text,
  add column if not exists location text,
  add column if not exists website text,
  add column if not exists trading_style text,
  add column if not exists social_links jsonb not null default '{}'::jsonb;

alter table public.profiles
  add constraint profiles_bio_length check (bio is null or char_length(bio) <= 500),
  add constraint profiles_location_length check (location is null or char_length(location) <= 100),
  add constraint profiles_website_length check (website is null or char_length(website) <= 300),
  add constraint profiles_trading_style_length check (trading_style is null or char_length(trading_style) <= 100);
