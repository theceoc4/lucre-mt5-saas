-- Keep the MT5 control plane responsive without introducing another service.
--
-- 1. Treat the active-EA lease as heartbeat evidence. The lightweight command
--    lane refreshes the lease even when a heavyweight account snapshot is
--    delayed by MT5 history/network work.
-- 2. Claim queued commands and mark them sent in one race-safe database call.
-- 3. Enqueue close-all and mark the affected positions closing atomically.

create or replace function public.claim_terminal_ea_instance(
  p_terminal_id uuid,
  p_instance_id text,
  p_is_vps boolean default false,
  p_lease_seconds integer default 45
) returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  current_instance text;
  current_seen timestamptz;
  current_is_vps boolean;
  lease_window interval;
begin
  if nullif(btrim(p_instance_id), '') is null then return false; end if;
  lease_window := make_interval(secs => least(greatest(p_lease_seconds, 15), 300));

  select active_ea_instance_id, active_ea_instance_seen_at, active_ea_is_vps
    into current_instance, current_seen, current_is_vps
    from public.mt5_terminals
   where id = p_terminal_id
   for update;
  if not found then return false; end if;

  if current_instance = p_instance_id then
    if current_seen is null or current_seen < now() - interval '15 seconds' then
      update public.mt5_terminals set
        active_ea_instance_seen_at = now(),
        active_ea_is_vps = coalesce(p_is_vps, false),
        last_heartbeat_at = now(),
        status = 'connected'
      where id = p_terminal_id;
    end if;
    return true;
  end if;

  if current_instance is not null
     and current_seen is not null
     and current_seen >= now() - lease_window
     and not (coalesce(p_is_vps, false) and not coalesce(current_is_vps, false)) then
    return false;
  end if;

  update public.mt5_terminals set
    active_ea_instance_id = p_instance_id,
    active_ea_instance_seen_at = now(),
    active_ea_is_vps = coalesce(p_is_vps, false),
    last_heartbeat_at = now(),
    status = 'connected'
  where id = p_terminal_id;
  return true;
end;
$$;

revoke all on function public.claim_terminal_ea_instance(uuid, text, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.claim_terminal_ea_instance(uuid, text, boolean, integer)
  to service_role;

comment on function public.claim_terminal_ea_instance(uuid, text, boolean, integer) is
  'Grants one authoritative EA lease and records throttled lease refreshes as terminal heartbeat evidence.';

create or replace function public.claim_queued_terminal_commands(p_terminal_id uuid)
returns setof public.ea_commands
language sql
security definer
set search_path to 'public', 'pg_temp'
as $$
  with picked as (
    select id
      from public.ea_commands
     where terminal_id = p_terminal_id
       and status = 'queued'
     order by requested_at
     for update skip locked
  ), dispatched as (
    update public.ea_commands command
       set status = 'sent',
           dispatched_at = coalesce(command.dispatched_at, now())
     where command.id in (select id from picked)
     returning command.*
  )
  select * from dispatched order by requested_at;
$$;

revoke all on function public.claim_queued_terminal_commands(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_queued_terminal_commands(uuid)
  to service_role;

comment on function public.claim_queued_terminal_commands(uuid) is
  'Atomically claims queued EA commands and marks them sent, avoiding select/update races and one database round trip.';

create or replace function public.enqueue_dashboard_close_all(
  p_terminal_id uuid,
  p_user_id uuid,
  p_idempotency_key text,
  p_max_deviation_points integer default 20
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  terminal_owner uuid;
  open_count integer;
  command_id uuid;
  command_status text;
begin
  select user_id into terminal_owner
    from public.mt5_terminals
   where id = p_terminal_id
   for update;

  if not found then return jsonb_build_object('error', 'terminal_not_found'); end if;
  if terminal_owner <> p_user_id then return jsonb_build_object('error', 'forbidden'); end if;

  select count(*)::integer into open_count
    from public.positions
   where terminal_id = p_terminal_id
     and status = 'open';
  if open_count = 0 then return jsonb_build_object('error', 'no_open_positions'); end if;

  insert into public.ea_commands (
    terminal_id, source, command_type, max_deviation_points, idempotency_key
  ) values (
    p_terminal_id,
    'dashboard_close',
    'close_all',
    least(greatest(coalesce(p_max_deviation_points, 20), 0), 10000),
    coalesce(nullif(btrim(p_idempotency_key), ''), 'close-all:' || p_terminal_id::text || ':' || extract(epoch from clock_timestamp())::text)
  )
  returning id, status into command_id, command_status;

  update public.positions
     set status = 'closing', updated_at = now()
   where terminal_id = p_terminal_id
     and status = 'open';

  return jsonb_build_object(
    'ea_command_id', command_id,
    'status', command_status,
    'position_count', open_count
  );
exception
  when unique_violation then
    return jsonb_build_object('error', 'already_closing');
end;
$$;

revoke all on function public.enqueue_dashboard_close_all(uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.enqueue_dashboard_close_all(uuid, uuid, text, integer)
  to service_role;

comment on function public.enqueue_dashboard_close_all(uuid, uuid, text, integer) is
  'Owner-checks and atomically creates one terminal-wide close command while moving its open positions into closing state.';

create or replace function public.detect_disconnected_terminals_for_push(p_stale_after interval default interval '90 seconds')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare changed integer;
begin
  with stale as (
    update public.mt5_terminals
    set status = 'disconnected', updated_at = now()
    where status = 'connected'
      and greatest(
        coalesce(last_heartbeat_at, '-infinity'::timestamptz),
        coalesce(active_ea_instance_seen_at, '-infinity'::timestamptz)
      ) < now() - p_stale_after
    returning id, user_id, label,
      greatest(
        coalesce(last_heartbeat_at, '-infinity'::timestamptz),
        coalesce(active_ea_instance_seen_at, '-infinity'::timestamptz)
      ) as effective_heartbeat_at
  ), queued as (
    select public.enqueue_push_notification(
      user_id, id, 'terminal_disconnected',
      'terminal-disconnected:' || id || ':' || effective_heartbeat_at::text,
      label || ' disconnected',
      'No MT5 heartbeat has arrived for more than 90 seconds.',
      jsonb_build_object('url','/?view=dashboard','terminal_id',id,'terminal_label',label,'last_heartbeat_at',effective_heartbeat_at)
    ) from stale
  ) select count(*) into changed from queued;
  return changed;
end;
$$;

revoke all on function public.detect_disconnected_terminals_for_push(interval)
  from public, anon, authenticated;
grant execute on function public.detect_disconnected_terminals_for_push(interval)
  to service_role;
