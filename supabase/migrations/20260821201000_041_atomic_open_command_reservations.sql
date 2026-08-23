-- v1.0.20 — serialize open-command admission across every command source.
--
-- Counting only reported positions is racy: several dashboard/signal requests
-- can all see the same count before the EA has reported any of their fills.
-- A reservation is created in the same transaction as every open/hedge_open
-- command and is released only on a reported fill or terminal command failure.

create table public.open_command_reservations (
  ea_command_id uuid primary key references public.ea_commands(id) on delete cascade,
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  reserved_at timestamptz not null default now()
);

create index idx_open_command_reservations_terminal_id
  on public.open_command_reservations(terminal_id);

create or replace function public.reserve_open_command_slot()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_max_open_positions int;
  v_open_positions int;
  v_reserved_positions int;
begin
  if new.command_type not in ('open', 'hedge_open') then
    return new;
  end if;

  -- Serializing on the terminal row makes the count-and-reserve operation
  -- atomic even when several Edge Function instances insert simultaneously.
  select max_open_positions
    into v_max_open_positions
    from public.mt5_terminals
   where id = new.terminal_id
   for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'terminal_not_found';
  end if;

  select count(*) into v_open_positions
    from public.positions
   where terminal_id = new.terminal_id
     and status = 'open';

  select count(*) into v_reserved_positions
    from public.open_command_reservations
   where terminal_id = new.terminal_id;

  if v_open_positions + v_reserved_positions >= v_max_open_positions then
    raise exception using errcode = 'P0001', message = 'max_open_positions_reached';
  end if;

  insert into public.open_command_reservations (ea_command_id, terminal_id)
  values (new.id, new.terminal_id);

  return new;
end;
$$;

create trigger trg_reserve_open_command_slot
after insert on public.ea_commands
for each row execute function public.reserve_open_command_slot();

create or replace function public.release_open_command_reservation_on_terminal_status()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.command_type in ('open', 'hedge_open')
     and new.status in ('failed', 'expired')
     and new.status is distinct from old.status then
    delete from public.open_command_reservations where ea_command_id = new.id;
  end if;
  return new;
end;
$$;

create trigger trg_release_open_command_reservation_on_terminal_status
after update of status on public.ea_commands
for each row execute function public.release_open_command_reservation_on_terminal_status();

create or replace function public.release_open_command_reservation_on_position_report()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'open' then
    delete from public.open_command_reservations reservations
    using public.ea_commands commands
    where reservations.ea_command_id = commands.id
      and commands.terminal_id = new.terminal_id
      and commands.command_type in ('open', 'hedge_open')
      and commands.mt5_ticket = new.mt5_ticket;
  end if;
  return new;
end;
$$;

create trigger trg_release_open_command_reservation_on_position_report
after insert or update of status, mt5_ticket on public.positions
for each row execute function public.release_open_command_reservation_on_position_report();

-- Existing active commands predate the reservation trigger. Preserve only the
-- oldest commands that still fit their terminal's reported capacity; expire
-- surplus queued/sent rows rather than allowing a post-migration burst above
-- the hard cap.
with active_open_commands as (
  select
    command.id,
    command.terminal_id,
    row_number() over (
      partition by command.terminal_id
      order by command.requested_at, command.id
    ) as queue_position,
    greatest(
      terminal.max_open_positions - (
        select count(*)
        from public.positions position
        where position.terminal_id = command.terminal_id
          and position.status = 'open'
      ),
      0
    ) as remaining_capacity
  from public.ea_commands command
  join public.mt5_terminals terminal on terminal.id = command.terminal_id
  where command.command_type in ('open', 'hedge_open')
    and command.status in ('queued', 'sent', 'acknowledged')
)
update public.ea_commands command
   set status = 'expired',
       error_message = coalesce(command.error_message, 'max_open_positions_reached_during_reservation_migration')
  from active_open_commands active
 where command.id = active.id
   and active.queue_position > active.remaining_capacity;

insert into public.open_command_reservations (ea_command_id, terminal_id)
select command.id, command.terminal_id
from public.ea_commands command
where command.command_type in ('open', 'hedge_open')
  and command.status in ('queued', 'sent', 'acknowledged')
on conflict (ea_command_id) do nothing;

comment on table public.open_command_reservations is
  'One in-flight capacity slot for an open/hedge_open command. The INSERT trigger serializes capacity admission per terminal; rows are removed only after the EA reports the resulting position or terminal command failure/expiry.';
