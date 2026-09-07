-- v1.0.81 -- Private CDN-backed social media and expressive reactions.

alter table public.social_posts
  add column if not exists media_path text,
  add column if not exists media_type text,
  add column if not exists media_mime text;

alter table public.social_posts drop constraint if exists social_posts_body_length;
alter table public.social_posts drop constraint if exists social_posts_media_type_check;
alter table public.social_posts drop constraint if exists social_posts_media_path_check;
alter table public.social_posts drop constraint if exists social_posts_content_check;

alter table public.social_posts
  add constraint social_posts_media_type_check
    check (media_type is null or media_type in ('image', 'video')),
  add constraint social_posts_media_path_check
    check (media_path is null or (
      char_length(media_path) between 40 and 500
      and split_part(media_path, '/', 1) = user_id::text
    )),
  add constraint social_posts_content_check
    check (
      char_length(trim(body)) <= 1200
      and (char_length(trim(body)) >= 1 or media_path is not null)
      and ((media_path is null and media_type is null and media_mime is null)
        or (media_path is not null and media_type is not null and media_mime is not null))
    );

update public.social_post_reactions set reaction = 'wow' where reaction = 'insightful';
alter table public.social_post_reactions drop constraint if exists social_post_reactions_reaction_check;
alter table public.social_post_reactions
  add constraint social_post_reactions_reaction_check
  check (reaction in ('like', 'love', 'laugh', 'wow', 'support'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('social-media', 'social-media', false, 52428800,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif',
        'video/mp4', 'video/webm', 'video/quicktime'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "social_media_authenticated_read" on storage.objects;
drop policy if exists "social_media_own_insert" on storage.objects;
drop policy if exists "social_media_own_update" on storage.objects;
drop policy if exists "social_media_own_delete" on storage.objects;

create policy "social_media_authenticated_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'social-media');

create policy "social_media_own_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'social-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "social_media_own_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'social-media'
    and (storage.foldername(name))[1] = auth.uid()::text
    and owner_id = auth.uid()::text
  )
  with check (
    bucket_id = 'social-media'
    and (storage.foldername(name))[1] = auth.uid()::text
    and owner_id = auth.uid()::text
  );

create policy "social_media_own_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'social-media'
    and (storage.foldername(name))[1] = auth.uid()::text
    and owner_id = auth.uid()::text
  );
