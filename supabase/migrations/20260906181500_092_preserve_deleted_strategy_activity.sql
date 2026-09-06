-- v1.0.73 -- strategy deletion stops future execution, but must not erase the
-- historical signal ledger the product explicitly promises to preserve.

alter table public.signals
  add column if not exists strategy_name_at_generation text;

alter table public.external_signal_events
  add column if not exists strategy_name_at_generation text;

update public.signals as signal
set strategy_name_at_generation = strategy.name
from public.strategies as strategy
where strategy.id = signal.strategy_id
  and signal.strategy_name_at_generation is null;

update public.external_signal_events as event
set strategy_name_at_generation = strategy.name
from public.strategies as strategy
where strategy.id = event.strategy_id
  and event.strategy_name_at_generation is null;

create or replace function public.capture_strategy_name_at_generation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.strategy_name_at_generation is null and new.strategy_id is not null then
    select strategy.name into new.strategy_name_at_generation
    from public.strategies as strategy
    where strategy.id = new.strategy_id
      and strategy.terminal_id = new.terminal_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_signals_capture_strategy_name on public.signals;
create trigger trg_signals_capture_strategy_name
  before insert or update of strategy_id on public.signals
  for each row execute function public.capture_strategy_name_at_generation();

drop trigger if exists trg_external_events_capture_strategy_name on public.external_signal_events;
create trigger trg_external_events_capture_strategy_name
  before insert or update of strategy_id on public.external_signal_events
  for each row execute function public.capture_strategy_name_at_generation();

-- Drop only the strategy relationships. Terminal/account deletion intentionally
-- remains cascading because that is the user's explicit account-data boundary.
do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'public.signals'::regclass
      and confrelid = 'public.strategies'::regclass
      and contype = 'f'
  loop
    execute format('alter table public.signals drop constraint %I', constraint_row.conname);
  end loop;

  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'public.external_signal_events'::regclass
      and confrelid in ('public.strategies'::regclass, 'public.external_signal_endpoints'::regclass)
      and contype = 'f'
  loop
    execute format('alter table public.external_signal_events drop constraint %I', constraint_row.conname);
  end loop;
end;
$$;

alter table public.signals alter column strategy_id drop not null;
alter table public.external_signal_events alter column endpoint_id drop not null;
alter table public.external_signal_events alter column strategy_id drop not null;

alter table public.signals
  add constraint signals_strategy_id_fkey
    foreign key (strategy_id) references public.strategies(id) on delete set null,
  add constraint signals_strategy_terminal_fkey
    foreign key (strategy_id, terminal_id) references public.strategies(id, terminal_id)
    on delete set null (strategy_id) not valid;

alter table public.signals validate constraint signals_strategy_terminal_fkey;

alter table public.external_signal_events
  add constraint external_signal_events_endpoint_terminal_strategy_fkey
    foreign key (endpoint_id, terminal_id, strategy_id)
    references public.external_signal_endpoints(id, terminal_id, strategy_id)
    on delete set null (endpoint_id, strategy_id),
  add constraint external_signal_events_strategy_terminal_fkey
    foreign key (strategy_id, terminal_id)
    references public.strategies(id, terminal_id)
    on delete set null (strategy_id) not valid;

alter table public.external_signal_events
  validate constraint external_signal_events_strategy_terminal_fkey;

comment on column public.signals.strategy_name_at_generation is
  'Immutable strategy label captured when the signal is generated; retained after strategy deletion.';
comment on column public.external_signal_events.strategy_name_at_generation is
  'Immutable strategy label captured when the webhook is received; retained after strategy or endpoint deletion.';
