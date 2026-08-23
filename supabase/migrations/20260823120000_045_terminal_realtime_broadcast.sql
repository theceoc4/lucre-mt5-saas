-- v1.0.22 — scalable, terminal-scoped command wake-ups over Realtime Broadcast.
--
-- The broadcast is deliberately public-but-unguessable and contains no command
-- or account data. It is only a hint to call the API-key-authenticated ea-sync
-- endpoint, which remains the durable source of truth. This avoids creating a
-- Supabase Auth user (and potential MAU) for every connected MT5 terminal.

alter table public.mt5_terminals
  add column if not exists realtime_topic_id uuid not null default gen_random_uuid() unique;

create or replace function public.broadcast_ea_command_available()
returns trigger
language plpgsql
security definer
set search_path = public, realtime, pg_temp
as $$
declare
  topic_id uuid;
begin
  select terminal.realtime_topic_id
    into topic_id
    from public.mt5_terminals terminal
   where terminal.id = new.terminal_id;

  if topic_id is not null then
    perform realtime.send(
      '{}'::jsonb,
      'command_available',
      'terminal:' || topic_id::text,
      false
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_broadcast_ea_command_available on public.ea_commands;
create trigger trg_broadcast_ea_command_available
  after insert on public.ea_commands
  for each row execute function public.broadcast_ea_command_available();

comment on column public.mt5_terminals.realtime_topic_id is
  'Random non-secret Realtime wake-up topic id. Broadcasts contain no trading data; ea-sync remains authoritative.';
comment on function public.broadcast_ea_command_available is
  'Broadcasts a non-durable terminal-scoped wake-up after an ea_commands insert; ea-sync remains authoritative.';
