-- v1.0.63 -- Intentional public social identity plus private user messaging.
-- Trading/account data remains terminal scoped and is never referenced here.

alter table public.profiles
  add column if not exists avatar_path text;

alter table public.profiles
  drop constraint if exists profiles_avatar_path_length;
alter table public.profiles
  add constraint profiles_avatar_path_length
  check (avatar_path is null or char_length(avatar_path) <= 300);

create table public.social_profiles (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  display_name text not null,
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_profiles_display_name_length check (char_length(display_name) between 1 and 80),
  constraint social_profiles_avatar_path_length check (avatar_path is null or char_length(avatar_path) <= 300)
);

insert into public.social_profiles (user_id, display_name, avatar_path)
select id, coalesce(nullif(trim(display_name), ''), 'Lucre trader'), avatar_path
from public.profiles
on conflict (user_id) do nothing;

create trigger trg_social_profiles_updated_at
  before update on public.social_profiles
  for each row execute function public.set_updated_at();

create table public.social_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.social_profiles(user_id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_posts_body_length check (char_length(trim(body)) between 1 and 1200)
);

create trigger trg_social_posts_updated_at
  before update on public.social_posts
  for each row execute function public.set_updated_at();

create index idx_social_posts_created_at on public.social_posts(created_at desc);
create index idx_social_posts_user_created on public.social_posts(user_id, created_at desc);

create table public.social_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.social_posts(id) on delete cascade,
  user_id uuid not null references public.social_profiles(user_id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_comments_body_length check (char_length(trim(body)) between 1 and 600)
);

create trigger trg_social_comments_updated_at
  before update on public.social_comments
  for each row execute function public.set_updated_at();

create index idx_social_comments_post_created on public.social_comments(post_id, created_at);

create table public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.social_profiles(user_id) on delete cascade,
  recipient_id uuid not null references public.social_profiles(user_id) on delete cascade,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint direct_messages_not_self check (sender_id <> recipient_id),
  constraint direct_messages_body_length check (char_length(trim(body)) between 1 and 2000)
);

create index idx_direct_messages_sender_created on public.direct_messages(sender_id, created_at desc);
create index idx_direct_messages_recipient_created on public.direct_messages(recipient_id, created_at desc);

alter table public.social_profiles enable row level security;
alter table public.social_posts enable row level security;
alter table public.social_comments enable row level security;
alter table public.direct_messages enable row level security;

create policy "social_profiles_authenticated_read" on public.social_profiles
  for select to authenticated using (true);
create policy "social_profiles_own_insert" on public.social_profiles
  for insert to authenticated with check (user_id = auth.uid());
create policy "social_profiles_own_update" on public.social_profiles
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "social_posts_authenticated_read" on public.social_posts
  for select to authenticated using (true);
create policy "social_posts_own_insert" on public.social_posts
  for insert to authenticated with check (user_id = auth.uid());
create policy "social_posts_own_update" on public.social_posts
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "social_posts_own_delete" on public.social_posts
  for delete to authenticated using (user_id = auth.uid());

create policy "social_comments_authenticated_read" on public.social_comments
  for select to authenticated using (true);
create policy "social_comments_own_insert" on public.social_comments
  for insert to authenticated with check (user_id = auth.uid());
create policy "social_comments_own_update" on public.social_comments
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "social_comments_own_delete" on public.social_comments
  for delete to authenticated using (user_id = auth.uid());

create policy "direct_messages_participant_read" on public.direct_messages
  for select to authenticated using (sender_id = auth.uid() or recipient_id = auth.uid());
create policy "direct_messages_sender_insert" on public.direct_messages
  for insert to authenticated with check (sender_id = auth.uid());
create policy "direct_messages_sender_delete" on public.direct_messages
  for delete to authenticated using (sender_id = auth.uid());
create policy "direct_messages_recipient_update" on public.direct_messages
  for update to authenticated using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

revoke all on table public.social_profiles, public.social_posts, public.social_comments, public.direct_messages
  from public, anon, authenticated;
grant select, insert, update on table public.social_profiles to authenticated;
grant select, insert, update, delete on table public.social_posts, public.social_comments to authenticated;
grant select, insert, delete on table public.direct_messages to authenticated;
grant update(read_at) on table public.direct_messages to authenticated;
grant all on table public.social_profiles, public.social_posts, public.social_comments, public.direct_messages to service_role;

-- A profile image is the only intentionally public asset. Object mutations are
-- restricted to the authenticated user's own UUID folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-avatars', 'profile-avatars', true, 5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "profile_avatars_own_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'profile-avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "profile_avatars_own_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'profile-avatars' and owner_id = auth.uid()::text);
create policy "profile_avatars_own_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'profile-avatars' and owner_id = auth.uid()::text)
  with check (bucket_id = 'profile-avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "profile_avatars_own_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'profile-avatars' and owner_id = auth.uid()::text);

-- Ensure future Auth users receive both their private and deliberate social identity.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  generated_name text := coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), split_part(new.email, '@', 1), 'Lucre trader');
begin
  insert into public.profiles (id, display_name) values (new.id, generated_name);
  insert into public.social_profiles (user_id, display_name) values (new.id, generated_name);
  return new;
end;
$$;
