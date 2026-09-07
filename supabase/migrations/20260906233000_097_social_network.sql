-- v1.0.79 -- Following-first social graph, engagement, discovery and alerts.
-- Trading/account data is never joined into these public social surfaces.

alter table public.social_profiles
  add column if not exists handle text,
  add column if not exists bio text,
  add column if not exists discoverable boolean not null default true;

update public.social_profiles
set handle = 'trader_' || substr(replace(user_id::text, '-', ''), 1, 8)
where handle is null;

update public.social_profiles social
set bio = left(profile.bio, 240)
from public.profiles profile
where profile.id = social.user_id and social.bio is null and profile.bio is not null;

alter table public.social_profiles alter column handle set not null;
alter table public.social_profiles
  add constraint social_profiles_handle_format
  check (handle ~ '^[a-z][a-z0-9_]{2,29}$'),
  add constraint social_profiles_bio_length
  check (bio is null or char_length(bio) <= 240);
create unique index social_profiles_handle_unique on public.social_profiles(lower(handle));
create index social_profiles_handle_search on public.social_profiles(lower(handle) text_pattern_ops)
  where discoverable = true;

create table public.social_tags (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  label text not null,
  created_at timestamptz not null default now(),
  constraint social_tags_slug_format check (slug ~ '^\$[A-Z0-9_]{2,20}$'),
  constraint social_tags_label_length check (char_length(label) between 2 and 40)
);
create unique index social_tags_slug_unique on public.social_tags(upper(slug));

insert into public.social_tags (slug, label) values
  ('$GENERAL', 'General'), ('$BTCUSD', 'Bitcoin'), ('$ETHUSD', 'Ethereum'),
  ('$EURUSD', 'Euro / US Dollar'), ('$GBPUSD', 'Pound / US Dollar'),
  ('$USDJPY', 'US Dollar / Yen'), ('$XAUUSD', 'Gold'),
  ('$TRADING', 'Trading'), ('$RISK', 'Risk Management')
on conflict do nothing;

alter table public.social_posts add column if not exists tag_id uuid references public.social_tags(id);
update public.social_posts set tag_id = (select id from public.social_tags where slug = '$GENERAL')
where tag_id is null;
alter table public.social_posts alter column tag_id set not null;
create index idx_social_posts_tag_created on public.social_posts(tag_id, created_at desc);

create table public.social_follows (
  follower_id uuid not null references public.social_profiles(user_id) on delete cascade,
  followed_id uuid not null references public.social_profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followed_id),
  constraint social_follows_not_self check (follower_id <> followed_id)
);
create index idx_social_follows_followed on public.social_follows(followed_id, created_at desc);

create table public.social_friend_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.social_profiles(user_id) on delete cascade,
  addressee_id uuid not null references public.social_profiles(user_id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint social_friend_requests_not_self check (requester_id <> addressee_id)
);
create unique index social_friend_requests_pair_unique
  on public.social_friend_requests(least(requester_id, addressee_id), greatest(requester_id, addressee_id));

create table public.social_post_reactions (
  post_id uuid not null references public.social_posts(id) on delete cascade,
  user_id uuid not null references public.social_profiles(user_id) on delete cascade,
  reaction text not null default 'like' check (reaction in ('like', 'insightful', 'support')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table public.social_post_shares (
  post_id uuid not null references public.social_posts(id) on delete cascade,
  user_id uuid not null references public.social_profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table public.social_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.social_profiles(user_id) on delete cascade,
  actor_id uuid references public.social_profiles(user_id) on delete cascade,
  event_type text not null check (event_type in (
    'message', 'mention', 'comment', 'follow', 'friend_request',
    'friend_accepted', 'reaction', 'share'
  )),
  resource_type text,
  resource_id uuid,
  title text not null,
  detail text not null,
  url text not null default '/?view=social',
  dedupe_key text not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);
create index idx_social_notifications_user_created on public.social_notifications(user_id, created_at desc);
create index idx_social_notifications_unread on public.social_notifications(user_id, created_at desc)
  where read_at is null;

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'social_notifications'
  ) then alter publication supabase_realtime add table public.social_notifications; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'direct_messages'
  ) then alter publication supabase_realtime add table public.direct_messages; end if;
end $$;

alter table public.social_tags enable row level security;
alter table public.social_follows enable row level security;
alter table public.social_friend_requests enable row level security;
alter table public.social_post_reactions enable row level security;
alter table public.social_post_shares enable row level security;
alter table public.social_notifications enable row level security;

create policy social_tags_authenticated_read on public.social_tags for select to authenticated using (true);
create policy social_follows_authenticated_read on public.social_follows for select to authenticated using (true);
create policy social_follows_own_insert on public.social_follows for insert to authenticated
  with check (follower_id = auth.uid());
create policy social_follows_participant_delete on public.social_follows for delete to authenticated
  using (follower_id = auth.uid() or followed_id = auth.uid());

create policy social_friend_requests_participant_read on public.social_friend_requests for select to authenticated
  using (requester_id = auth.uid() or addressee_id = auth.uid());
create policy social_friend_requests_own_insert on public.social_friend_requests for insert to authenticated
  with check (requester_id = auth.uid() and status = 'pending');
create policy social_friend_requests_addressee_update on public.social_friend_requests for update to authenticated
  using (addressee_id = auth.uid()) with check (addressee_id = auth.uid());
create policy social_friend_requests_participant_delete on public.social_friend_requests for delete to authenticated
  using (requester_id = auth.uid() or addressee_id = auth.uid());

create policy social_post_reactions_authenticated_read on public.social_post_reactions for select to authenticated using (true);
create policy social_post_reactions_own_insert on public.social_post_reactions for insert to authenticated
  with check (user_id = auth.uid());
create policy social_post_reactions_own_update on public.social_post_reactions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy social_post_reactions_own_delete on public.social_post_reactions for delete to authenticated
  using (user_id = auth.uid());

create policy social_post_shares_authenticated_read on public.social_post_shares for select to authenticated using (true);
create policy social_post_shares_own_insert on public.social_post_shares for insert to authenticated
  with check (user_id = auth.uid());
create policy social_post_shares_own_delete on public.social_post_shares for delete to authenticated
  using (user_id = auth.uid());

create policy social_notifications_own_read on public.social_notifications for select to authenticated
  using (user_id = auth.uid());
create policy social_notifications_own_update on public.social_notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy social_notifications_own_delete on public.social_notifications for delete to authenticated
  using (user_id = auth.uid());

revoke all on public.social_tags, public.social_follows, public.social_friend_requests,
  public.social_post_reactions, public.social_post_shares, public.social_notifications
  from public, anon, authenticated;
grant select on public.social_tags to authenticated;
grant select, insert, delete on public.social_follows, public.social_post_shares to authenticated;
grant select, insert, update, delete on public.social_friend_requests, public.social_post_reactions to authenticated;
grant select, update, delete on public.social_notifications to authenticated;
grant all on public.social_tags, public.social_follows, public.social_friend_requests,
  public.social_post_reactions, public.social_post_shares, public.social_notifications to service_role;

create or replace function public.social_actor_label(p_user_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(display_name, '$' || handle, 'A Lucre trader')
  from public.social_profiles where user_id = p_user_id;
$$;
revoke all on function public.social_actor_label(uuid) from public, anon, authenticated;

create or replace function public.notify_social_mentions()
returns trigger language plpgsql security definer set search_path = public as $$
declare mention text; target_id uuid; actor_name text; post_owner uuid; post_id uuid;
begin
  actor_name := public.social_actor_label(new.user_id);
  if tg_table_name = 'social_comments' then
    select user_id into post_owner from public.social_posts where id = new.post_id;
    post_id := new.post_id;
    if post_owner <> new.user_id then
      insert into public.social_notifications(user_id, actor_id, event_type, resource_type, resource_id, title, detail, dedupe_key)
      values (post_owner, new.user_id, 'comment', 'post', new.post_id, actor_name || ' commented on your post',
        left(new.body, 180), 'comment:' || new.id) on conflict do nothing;
    end if;
  else
    post_id := new.id;
  end if;

  for mention in select (regexp_matches(new.body, '\$([A-Za-z][A-Za-z0-9_]{2,29})', 'g'))[1]
  loop
    select user_id into target_id from public.social_profiles where lower(handle) = lower(mention);
    if target_id is not null and target_id <> new.user_id then
      insert into public.social_notifications(user_id, actor_id, event_type, resource_type, resource_id, title, detail, dedupe_key)
      values (target_id, new.user_id, 'mention', 'post', post_id, actor_name || ' mentioned you',
        left(new.body, 180), 'mention:' || tg_table_name || ':' || new.id || ':' || target_id)
      on conflict do nothing;
    end if;
  end loop;
  return new;
end;
$$;

create trigger trg_social_post_mentions after insert on public.social_posts
  for each row execute function public.notify_social_mentions();
create trigger trg_social_comment_notifications after insert on public.social_comments
  for each row execute function public.notify_social_mentions();

create or replace function public.notify_social_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare target_id uuid; actor_id uuid; kind text; heading text; detail_text text; resource uuid; actor_name text;
begin
  if tg_table_name = 'direct_messages' then
    actor_id := new.sender_id; target_id := new.recipient_id; kind := 'message'; resource := new.id;
  elsif tg_table_name = 'social_follows' then
    actor_id := new.follower_id; target_id := new.followed_id; kind := 'follow'; resource := null;
  elsif tg_table_name = 'social_friend_requests' then
    actor_id := new.requester_id; target_id := new.addressee_id; kind := 'friend_request'; resource := new.id;
  elsif tg_table_name = 'social_post_reactions' then
    actor_id := new.user_id;
    select user_id into target_id from public.social_posts where id = new.post_id;
    kind := 'reaction'; resource := new.post_id;
  else
    actor_id := new.user_id;
    select user_id into target_id from public.social_posts where id = new.post_id;
    kind := 'share'; resource := new.post_id;
  end if;
  actor_name := public.social_actor_label(actor_id);
  if kind = 'message' then heading := 'New message from ' || actor_name; detail_text := left(new.body, 180);
  elsif kind = 'follow' then heading := actor_name || ' followed you'; detail_text := 'You have a new follower.';
  elsif kind = 'friend_request' then heading := actor_name || ' sent a friend request'; detail_text := 'Open Social to respond.';
  elsif kind = 'reaction' then heading := actor_name || ' reacted to your post'; detail_text := initcap(new.reaction);
  else heading := actor_name || ' shared your post'; detail_text := 'Your post was shared.';
  end if;
  if target_id is not null and target_id <> actor_id then
    insert into public.social_notifications(user_id, actor_id, event_type, resource_type, resource_id, title, detail, dedupe_key)
    values (target_id, actor_id, kind,
      case when resource is null then null else 'social' end, resource, heading, detail_text,
      kind || ':' || coalesce(resource::text, target_id::text) || ':' || actor_id::text)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

create trigger trg_direct_message_social_notification after insert on public.direct_messages
  for each row execute function public.notify_social_event();
create trigger trg_social_follow_notification after insert on public.social_follows
  for each row execute function public.notify_social_event();
create trigger trg_social_friend_request_notification after insert on public.social_friend_requests
  for each row when (new.status = 'pending') execute function public.notify_social_event();
create trigger trg_social_reaction_notification after insert on public.social_post_reactions
  for each row execute function public.notify_social_event();
create trigger trg_social_share_notification after insert on public.social_post_shares
  for each row execute function public.notify_social_event();

create or replace function public.notify_friend_accepted()
returns trigger language plpgsql security definer set search_path = public as $$
declare actor_name text;
begin
  if old.status = 'pending' and new.status = 'accepted' then
    actor_name := public.social_actor_label(new.addressee_id);
    insert into public.social_notifications(user_id, actor_id, event_type, resource_type, resource_id, title, detail, dedupe_key)
    values (new.requester_id, new.addressee_id, 'friend_accepted', 'friend_request', new.id,
      actor_name || ' accepted your friend request', 'You are now friends on Lucre.', 'friend-accepted:' || new.id)
    on conflict do nothing;
  end if;
  return new;
end;
$$;
create trigger trg_social_friend_accepted after update of status on public.social_friend_requests
  for each row execute function public.notify_friend_accepted();

alter table public.push_notification_preferences
  add column if not exists social_messages boolean not null default true,
  add column if not exists social_mentions boolean not null default true,
  add column if not exists social_comments boolean not null default true;

alter table public.push_notification_events drop constraint if exists push_notification_events_event_type_check;
alter table public.push_notification_events add constraint push_notification_events_event_type_check
  check (event_type in ('terminal_disconnected', 'position_opened', 'position_closed',
    'trend_extreme', 'floating_pl_target', 'social_message', 'social_mention', 'social_comment'));

create or replace function public.push_event_enabled(p_user_id uuid, p_event_type text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.push_subscriptions s where s.user_id = p_user_id)
    and coalesce((select case p_event_type
      when 'terminal_disconnected' then terminal_disconnected
      when 'position_opened' then position_opened
      when 'position_closed' then position_closed
      when 'trend_extreme' then trend_extreme
      when 'floating_pl_target' then floating_pl_target
      when 'social_message' then social_messages
      when 'social_mention' then social_mentions
      when 'social_comment' then social_comments
      else false end
      from public.push_notification_preferences where user_id = p_user_id), true);
$$;

create or replace function public.queue_social_push()
returns trigger language plpgsql security definer set search_path = public as $$
declare push_type text;
begin
  push_type := case new.event_type
    when 'message' then 'social_message'
    when 'mention' then 'social_mention'
    when 'comment' then 'social_comment'
    else null end;
  if push_type is not null then
    perform public.enqueue_push_notification(new.user_id, null, push_type,
      'social:' || new.dedupe_key, new.title, new.detail,
      jsonb_build_object('url', new.url, 'social_notification_id', new.id));
  end if;
  return new;
end;
$$;
create trigger trg_social_notification_push after insert on public.social_notifications
  for each row execute function public.queue_social_push();

-- New Auth users receive a collision-proof initial handle. They can later
-- replace it with a memorable public handle in Account & profile.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  generated_name text := coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), split_part(new.email, '@', 1), 'Lucre trader');
  generated_handle text := 'trader_' || substr(replace(new.id::text, '-', ''), 1, 8);
begin
  insert into public.profiles (id, display_name) values (new.id, generated_name);
  insert into public.social_profiles (user_id, display_name, handle) values (new.id, generated_name, generated_handle);
  return new;
end;
$$;
