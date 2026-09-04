-- v1.0.49 -- Terminal-scoped external signal sources.
-- External providers may propose a side, symbol, and timeframe, but they never
-- choose account identity, lot size, risk, stops, or execution policy. Those
-- remain properties of the owning Lucre strategy and its terminal.

alter table public.strategies
  add column signal_source text not null default 'internal'
    check (signal_source in ('internal','tradingview','generic_webhook','mt5_indicator'));

alter table public.strategies drop constraint if exists strategies_definition_valid;
alter table public.strategies add constraint strategies_definition_valid check (
  kind <> 'custom_rules'
  or signal_source <> 'internal'
  or public.valid_strategy_definition(rule_definition)
);

comment on column public.strategies.signal_source is
  'Where the required trigger originates. External triggers may optionally use rule_definition as confirmation filters; all downstream policy and risk checks remain server-side.';

create table public.external_signal_endpoints (
  id uuid primary key default gen_random_uuid(),
  public_id text not null unique,
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  strategy_id uuid not null,
  provider text not null check (provider in ('tradingview','generic_webhook','mt5_indicator')),
  token_hash text not null unique check (length(token_hash) = 64),
  token_last_four text not null check (length(token_last_four) = 4),
  enabled boolean not null default true,
  rate_limit_per_minute integer not null default 30 check (rate_limit_per_minute between 1 and 300),
  last_received_at timestamptz,
  last_accepted_at timestamptz,
  last_status text,
  rotated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (strategy_id),
  unique (id, terminal_id, strategy_id),
  foreign key (strategy_id, terminal_id)
    references public.strategies(id, terminal_id) on delete cascade
);

create index idx_external_signal_endpoints_terminal
  on public.external_signal_endpoints (terminal_id, updated_at desc);

create trigger trg_external_signal_endpoints_updated_at
  before update on public.external_signal_endpoints
  for each row execute function public.set_updated_at();

create or replace function public.disable_changed_external_strategy_endpoint()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.signal_source = 'internal' or new.signal_source is distinct from old.signal_source then
    update public.external_signal_endpoints
    set enabled = false
    where strategy_id = new.id;
  end if;
  return new;
end;
$$;

create trigger trg_disable_changed_external_strategy_endpoint
  after update of signal_source on public.strategies
  for each row execute function public.disable_changed_external_strategy_endpoint();

revoke all on function public.disable_changed_external_strategy_endpoint() from public, anon, authenticated;

create table public.external_signal_events (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null,
  terminal_id uuid not null references public.mt5_terminals(id) on delete cascade,
  strategy_id uuid not null,
  provider text not null check (provider in ('tradingview','generic_webhook','mt5_indicator')),
  provider_event_id text not null check (length(provider_event_id) between 1 and 180),
  payload_hash text not null check (length(payload_hash) = 64),
  symbol_received text not null,
  canonical_symbol text,
  timeframe text not null check (timeframe in ('M1','M5','M15','M30','H1','H4','D1','W1')),
  side text not null check (side in ('buy','sell')),
  source_price numeric,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  next_attempt_at timestamptz not null default now(),
  status text not null default 'received' check (status in (
    'received','processing','accepted','blocked','duplicate','expired','invalid',
    'rate_limited','mapping_failed','processing_failed','shadow_recorded','manual_pending','command_queued'
  )),
  block_reason text,
  signal_id uuid,
  sanitized_payload jsonb not null default '{}'::jsonb,
  unique (endpoint_id, provider_event_id),
  unique (id, terminal_id),
  foreign key (endpoint_id, terminal_id, strategy_id)
    references public.external_signal_endpoints(id, terminal_id, strategy_id) on delete cascade,
  foreign key (strategy_id, terminal_id)
    references public.strategies(id, terminal_id) on delete cascade
);

create index idx_external_signal_events_terminal_received
  on public.external_signal_events (terminal_id, received_at desc);
create index idx_external_signal_events_pending
  on public.external_signal_events (status, received_at)
  where status in ('received','processing');

alter table public.signals
  add column source_kind text not null default 'internal'
    check (source_kind in ('internal','tradingview','generic_webhook','mt5_indicator')),
  add column external_event_id uuid;

alter table public.signals
  add constraint signals_external_event_terminal_fkey
  foreign key (external_event_id, terminal_id)
  references public.external_signal_events(id, terminal_id)
  on delete set null (external_event_id);

create unique index idx_signals_external_event
  on public.signals (external_event_id) where external_event_id is not null;

alter table public.external_signal_events
  add constraint external_signal_events_signal_fkey
  foreign key (signal_id, terminal_id)
  references public.signals(id, terminal_id)
  on delete set null (signal_id);

alter table public.external_signal_endpoints enable row level security;
alter table public.external_signal_events enable row level security;

create policy "external_signal_endpoints_select_own"
  on public.external_signal_endpoints for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals terminal
    where terminal.id = terminal_id and terminal.user_id = (select auth.uid())
  ));

create policy "external_signal_events_select_own"
  on public.external_signal_events for select to authenticated
  using (exists (
    select 1 from public.mt5_terminals terminal
    where terminal.id = terminal_id and terminal.user_id = (select auth.uid())
  ));

revoke all on public.external_signal_endpoints, public.external_signal_events from anon;
revoke insert, update, delete on public.external_signal_endpoints, public.external_signal_events from authenticated;
revoke select on public.external_signal_endpoints from authenticated;
grant select (
  id, public_id, terminal_id, strategy_id, provider, token_last_four, enabled,
  rate_limit_per_minute, last_received_at, last_accepted_at, last_status,
  rotated_at, created_at, updated_at
) on public.external_signal_endpoints to authenticated;
grant select on public.external_signal_events to authenticated;

-- Dispatch one durable event into the existing secured strategy engine. pg_net
-- starts the HTTP request only after this transaction commits, so the worker
-- can always read the row the ingress just acknowledged.
create or replace function public.dispatch_external_signal_event(p_event_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, vault, net, pg_temp
as $$
declare
  request_id bigint;
begin
  if not exists (
    select 1 from public.external_signal_events where id = p_event_id and status = 'received'
  ) then
    raise exception 'external signal event is not dispatchable';
  end if;

  select net.http_post(
    url := 'https://qxlfnscmrhwfcpattqxa.supabase.co/functions/v1/strategy-signal-engine',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-lucre-scheduler-secret', (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'strategy_engine_scheduler_secret'
      )
    ),
    body := jsonb_build_object('external_event_id', p_event_id),
    timeout_milliseconds := 10000
  ) into request_id;
  return request_id;
end;
$$;

revoke all on function public.dispatch_external_signal_event(uuid) from public, anon, authenticated;
grant execute on function public.dispatch_external_signal_event(uuid) to service_role;

create or replace function public.retry_external_signal_events()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  event_row record;
  dispatched integer := 0;
begin
  update public.external_signal_events
  set status = 'processing_failed',
      block_reason = coalesce(block_reason, 'worker_timeout'),
      next_attempt_at = now()
  where status = 'processing'
    and processed_at is null
    and received_at < now() - interval '30 seconds';

  for event_row in
    select id, attempt_count from public.external_signal_events
    where (
      status = 'processing_failed'
      or (status = 'received' and received_at < now() - interval '10 seconds')
    )
      and next_attempt_at <= now()
      and attempt_count < 8
      and received_at > now() - interval '1 day'
    order by received_at
    limit 50
    for update skip locked
  loop
    update public.external_signal_events
    set status = 'received',
        block_reason = null,
        attempt_count = attempt_count + 1,
        next_attempt_at = now() + make_interval(
          secs => least(300, (5 * power(2, event_row.attempt_count))::integer)
        )
    where id = event_row.id;
    perform public.dispatch_external_signal_event(event_row.id);
    dispatched := dispatched + 1;
  end loop;
  return dispatched;
end;
$$;

revoke all on function public.retry_external_signal_events() from public, anon, authenticated;
grant execute on function public.retry_external_signal_events() to service_role;

select cron.schedule(
  'retry-external-signal-events-1min',
  '* * * * *',
  $cron$select public.retry_external_signal_events();$cron$
);

create or replace function public.prune_external_signal_events()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed integer;
begin
  delete from public.external_signal_events
  where received_at < now() - interval '90 days';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.prune_external_signal_events() from public, anon, authenticated;
grant execute on function public.prune_external_signal_events() to service_role;

select cron.schedule(
  'prune-external-signal-events-daily',
  '17 3 * * *',
  $cron$select public.prune_external_signal_events();$cron$
);

comment on table public.external_signal_events is
  'Append-only, terminal-owned ingress audit log. A provider proposes a candidate; Lucre remains authoritative for broker data, filtering, risk, and execution.';
