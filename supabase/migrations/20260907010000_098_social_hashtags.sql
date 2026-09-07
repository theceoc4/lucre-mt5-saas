-- v1.0.80 -- Free-form hashtags replace required curated post tags.

alter table public.social_posts alter column tag_id drop not null;

create table public.social_hashtags (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  created_at timestamptz not null default now(),
  constraint social_hashtags_slug_format check (slug ~ '^[a-z0-9][a-z0-9_]{0,39}$')
);
create unique index social_hashtags_slug_unique on public.social_hashtags(lower(slug));

create table public.social_post_hashtags (
  post_id uuid not null references public.social_posts(id) on delete cascade,
  hashtag_id uuid not null references public.social_hashtags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, hashtag_id)
);
create index idx_social_post_hashtags_hashtag on public.social_post_hashtags(hashtag_id, created_at desc);

alter table public.social_hashtags enable row level security;
alter table public.social_post_hashtags enable row level security;

create policy social_hashtags_authenticated_read on public.social_hashtags
  for select to authenticated using (true);
create policy social_post_hashtags_authenticated_read on public.social_post_hashtags
  for select to authenticated using (true);

revoke all on public.social_hashtags, public.social_post_hashtags from public, anon, authenticated;
grant select on public.social_hashtags, public.social_post_hashtags to authenticated;
grant all on public.social_hashtags, public.social_post_hashtags to service_role;

create or replace function public.sync_social_post_hashtags()
returns trigger language plpgsql security definer set search_path = public as $$
declare matched_slug text; matched_id uuid;
begin
  delete from public.social_post_hashtags where post_id = new.id;
  for matched_slug in
    select distinct lower((match_value)[1])
    from regexp_matches(new.body, '(?:^|[[:space:]])#([A-Za-z0-9][A-Za-z0-9_]{0,39})', 'g') as matches(match_value)
  loop
    insert into public.social_hashtags(slug) values (matched_slug)
      on conflict ((lower(slug))) do update set slug = excluded.slug
      returning id into matched_id;
    insert into public.social_post_hashtags(post_id, hashtag_id)
      values (new.id, matched_id) on conflict do nothing;
  end loop;
  return new;
end;
$$;
revoke all on function public.sync_social_post_hashtags() from public, anon, authenticated;

create trigger trg_sync_social_post_hashtags
  after insert or update of body on public.social_posts
  for each row execute function public.sync_social_post_hashtags();

-- Backfill hashtags from existing posts without changing their timestamps.
insert into public.social_hashtags(slug)
select distinct lower((match_value)[1])
from public.social_posts post
cross join lateral regexp_matches(post.body, '(?:^|[[:space:]])#([A-Za-z0-9][A-Za-z0-9_]{0,39})', 'g') as matches(match_value)
on conflict ((lower(slug))) do nothing;

insert into public.social_post_hashtags(post_id, hashtag_id)
select distinct post.id, hashtag.id
from public.social_posts post
cross join lateral regexp_matches(post.body, '(?:^|[[:space:]])#([A-Za-z0-9][A-Za-z0-9_]{0,39})', 'g') as matches(match_value)
join public.social_hashtags hashtag on lower(hashtag.slug) = lower((match_value)[1])
on conflict do nothing;

create or replace function public.social_trending_hashtags(p_limit integer default 8)
returns table(hashtag text, post_count bigint)
language sql stable security definer set search_path = public as $$
  select hashtag.slug, count(distinct link.post_id)::bigint
  from public.social_post_hashtags link
  join public.social_hashtags hashtag on hashtag.id = link.hashtag_id
  join public.social_posts post on post.id = link.post_id
  where post.created_at >= now() - interval '30 days'
  group by hashtag.slug
  order by count(distinct link.post_id) desc, hashtag.slug asc
  limit least(greatest(coalesce(p_limit, 8), 1), 25);
$$;
revoke all on function public.social_trending_hashtags(integer) from public, anon;
grant execute on function public.social_trending_hashtags(integer) to authenticated, service_role;
