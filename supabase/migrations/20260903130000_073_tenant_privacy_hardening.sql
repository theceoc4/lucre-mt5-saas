-- v1.0.46 -- tenant privacy and least-privilege hardening.
--
-- The durable dashboard tables were already protected by terminal-owner RLS.
-- This closes the remaining internal-table grant and moves ephemeral position
-- snapshots to an authenticated, owner-only Realtime Broadcast topic.

-- This table is trigger-maintained infrastructure. Browser roles never need
-- direct access; service_role and database triggers retain their access.
alter table public.open_command_reservations enable row level security;
revoke all on table public.open_command_reservations from public, anon, authenticated;
grant select, insert, update, delete on table public.open_command_reservations to service_role;

-- Internal calculation state is not part of the browser API.
revoke all on table public.symbol_trend_calculation_state from public, anon, authenticated;
grant select, insert, update, delete on table public.symbol_trend_calculation_state to service_role;

-- Trigger helpers and privileged state transitions must not be callable by an
-- anonymous client. The authenticated promotion function still performs its
-- own auth.uid() ownership check.
revoke all on function public.broadcast_ea_command_available() from public, anon, authenticated;
grant execute on function public.broadcast_ea_command_available() to service_role;
revoke all on function public.promote_strategy_to_live(uuid) from public, anon;
grant execute on function public.promote_strategy_to_live(uuid) to authenticated;

-- Calendar health is intentionally global operational metadata. Do not expose
-- which private terminal happened to supply the latest shared update.
alter table public.market_feed_health drop column if exists last_source_terminal_id;
revoke all on table public.market_feed_health from public, anon;
revoke insert, update, delete on table public.market_feed_health from authenticated;
grant select on table public.market_feed_health to authenticated;

-- Only an authenticated user who owns the terminal behind a topic may receive
-- its private position-state broadcasts. The browser never gets INSERT access
-- to realtime.messages; the server relay publishes with service_role.
drop policy if exists "terminal_owner_receives_private_position_state" on realtime.messages;
create policy "terminal_owner_receives_private_position_state"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and exists (
    select 1
    from public.mt5_terminals terminal
    where terminal.user_id = (select auth.uid())
      and (select realtime.topic()) =
        'terminal:' || terminal.realtime_topic_id::text || ':positions'
  )
);

-- EA-authenticated Edge Functions call this server-only helper after validating
-- the terminal key and the compact payload. `private = true` makes Realtime
-- enforce the owner policy above for every subscriber.
create or replace function public.broadcast_private_position_state(
  p_terminal_id uuid,
  p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = public, realtime, pg_temp
as $$
declare
  topic_id uuid;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'invalid_position_payload';
  end if;

  select terminal.realtime_topic_id
    into topic_id
    from public.mt5_terminals terminal
   where terminal.id = p_terminal_id;

  if topic_id is null then
    raise exception using errcode = 'P0002', message = 'terminal_not_found';
  end if;

  perform realtime.send(
    p_payload,
    'position_state',
    'terminal:' || topic_id::text || ':positions',
    true
  );
end;
$$;

revoke all on function public.broadcast_private_position_state(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.broadcast_private_position_state(uuid, jsonb)
  to service_role;

comment on function public.broadcast_private_position_state(uuid, jsonb) is
  'Server-only relay for compact EA mark-to-market snapshots on an authenticated owner-only Realtime topic.';
