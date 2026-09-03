-- v1.0.53 -- Private, user-scoped PWA push notifications.
-- Events are written to a durable outbox and delivered by Edge Functions in
-- the background. State/latches make every event transition-based, so an
-- unchanged condition cannot create notification noise.

create table public.push_notification_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  terminal_disconnected boolean not null default true,
  position_opened boolean not null default true,
  position_closed boolean not null default true,
  trend_extreme boolean not null default true,
  floating_pl_target boolean not null default true,
  updated_at timestamptz not null default now()
);

create trigger trg_push_notification_preferences_updated_at
  before update on public.push_notification_preferences
  for each row execute function public.set_updated_at();

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, endpoint)
);

create index idx_push_subscriptions_user on public.push_subscriptions(user_id);

create table public.push_notification_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  terminal_id uuid references public.mt5_terminals(id) on delete cascade,
  event_type text not null check (event_type in (
    'terminal_disconnected', 'position_opened', 'position_closed',
    'trend_extreme', 'floating_pl_target'
  )),
  dedupe_key text not null,
  title text not null,
  body text not null,
  data jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (user_id, dedupe_key)
);

create index idx_push_notification_events_pending
  on public.push_notification_events(next_attempt_at, created_at)
  where status in ('pending', 'failed');

create table public.push_position_cluster_state (
  terminal_id uuid primary key references public.mt5_terminals(id) on delete cascade,
  cluster_id uuid,
  open_position_count integer not null default 0,
  last_total_pl numeric not null default 0,
  target_notified boolean not null default false,
  cluster_started_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.push_notification_preferences enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_notification_events enable row level security;
alter table public.push_position_cluster_state enable row level security;

create policy "push_preferences_own" on public.push_notification_preferences
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "push_subscriptions_own" on public.push_subscriptions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, insert, update, delete on public.push_notification_preferences to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
revoke all on public.push_notification_events from authenticated;
revoke all on public.push_position_cluster_state from authenticated;

create or replace function public.push_event_enabled(p_user_id uuid, p_event_type text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(select 1 from public.push_subscriptions s where s.user_id = p_user_id)
    and coalesce((select case p_event_type
      when 'terminal_disconnected' then terminal_disconnected
      when 'position_opened' then position_opened
      when 'position_closed' then position_closed
      when 'trend_extreme' then trend_extreme
      when 'floating_pl_target' then floating_pl_target
      else false end
      from public.push_notification_preferences where user_id = p_user_id), true);
$$;

revoke all on function public.push_event_enabled(uuid,text) from public, anon, authenticated;
grant execute on function public.push_event_enabled(uuid,text) to service_role;

create or replace function public.enqueue_push_notification(
  p_user_id uuid,
  p_terminal_id uuid,
  p_event_type text,
  p_dedupe_key text,
  p_title text,
  p_body text,
  p_data jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare event_id uuid;
begin
  if not public.push_event_enabled(p_user_id, p_event_type) then return null; end if;
  insert into public.push_notification_events(
    user_id, terminal_id, event_type, dedupe_key, title, body, data
  ) values (
    p_user_id, p_terminal_id, p_event_type, p_dedupe_key, p_title, p_body, coalesce(p_data, '{}'::jsonb)
  ) on conflict (user_id, dedupe_key) do nothing returning id into event_id;
  return event_id;
end;
$$;

revoke all on function public.enqueue_push_notification(uuid,uuid,text,text,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.enqueue_push_notification(uuid,uuid,text,text,text,text,jsonb)
  to service_role;

create or replace function public.on_position_push_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare owner_id uuid; terminal_label text; realized numeric;
begin
  select user_id, label into owner_id, terminal_label
  from public.mt5_terminals where id = new.terminal_id;

  if tg_op = 'INSERT' and new.status = 'open' then
    perform public.enqueue_push_notification(
      owner_id, new.terminal_id, 'position_opened',
      'position-opened:' || new.terminal_id || ':' || new.mt5_ticket,
      upper(new.symbol) || ' position opened',
      upper(new.side) || ' ' || trim(to_char(new.volume, 'FM999999990.00')) || ' lots at ' || trim(to_char(new.open_price, 'FM999999990.########')),
      jsonb_build_object('url','/?view=dashboard&tab=positions','symbol',new.symbol,'side',new.side,'ticket',new.mt5_ticket,'terminal_label',terminal_label)
    );
  elsif tg_op = 'UPDATE' and old.status <> 'closed' and new.status = 'closed' then
    select coalesce(net_profit, profit) into realized
    from public.trade_history
    where terminal_id = new.terminal_id and mt5_ticket = new.mt5_ticket;
    perform public.enqueue_push_notification(
      owner_id, new.terminal_id, 'position_closed',
      'position-closed:' || new.terminal_id || ':' || new.mt5_ticket,
      upper(new.symbol) || ' position closed',
      upper(new.side) || ' position closed' || case when realized is null then '' else ' · ' || case when realized >= 0 then '+' else '' end || '$' || trim(to_char(realized, 'FM999999990.00')) end,
      jsonb_build_object('url','/?view=dashboard&tab=positions','symbol',new.symbol,'side',new.side,'ticket',new.mt5_ticket,'profit',realized,'terminal_label',terminal_label)
    );
  end if;
  return new;
end;
$$;

create trigger trg_positions_push_event
  after insert or update of status on public.positions
  for each row execute function public.on_position_push_event();

create or replace function public.on_trend_extreme_push_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare owner_id uuid; terminal_label text; extreme text;
begin
  if new.score >= 100 and (tg_op = 'INSERT' or old.score < 100) then extreme := 'bullish';
  elsif new.score <= -100 and (tg_op = 'INSERT' or old.score > -100) then extreme := 'bearish';
  else return new;
  end if;
  select user_id, label into owner_id, terminal_label
  from public.mt5_terminals where id = new.terminal_id;
  perform public.enqueue_push_notification(
    owner_id, new.terminal_id, 'trend_extreme',
    'trend-extreme:' || new.terminal_id || ':' || new.symbol || ':' || extreme || ':' || coalesce(new.source_bar_time::text,new.computed_at::text),
    upper(new.symbol) || ' is 100% ' || extreme,
    'Trend Strength reached ' || case when extreme = 'bullish' then '+100' else '-100' end || ' · ' || initcap(new.regime),
    jsonb_build_object('url','/?view=pairs','symbol',new.symbol,'direction',extreme,'score',new.score,'terminal_label',terminal_label)
  );
  return new;
end;
$$;

create trigger trg_symbol_trend_extreme_push_event
  after insert or update of score on public.symbol_trend_state
  for each row execute function public.on_trend_extreme_push_event();

create or replace function public.evaluate_floating_pl_push(
  p_terminal_id uuid,
  p_open_position_count integer,
  p_total_pl numeric,
  p_threshold numeric default 1.00
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare s public.push_position_cluster_state%rowtype; owner_id uuid; terminal_label text; queued uuid;
begin
  select * into s from public.push_position_cluster_state where terminal_id = p_terminal_id for update;
  if not found then
    insert into public.push_position_cluster_state(terminal_id) values (p_terminal_id)
    returning * into s;
  end if;

  if p_open_position_count <= 0 then
    update public.push_position_cluster_state set cluster_id = null, open_position_count = 0,
      last_total_pl = 0, target_notified = false, cluster_started_at = null, updated_at = now()
    where terminal_id = p_terminal_id;
    return false;
  end if;

  if s.open_position_count <= 0 or s.cluster_id is null then
    s.cluster_id := gen_random_uuid();
    s.target_notified := false;
    -- A flat account starts at $0, so a first reported snapshot already above
    -- the target is a legitimate crossing for this brand-new trade cluster.
    s.last_total_pl := 0;
    s.cluster_started_at := now();
  end if;

  if not s.target_notified and p_total_pl >= p_threshold and s.last_total_pl < p_threshold then
    select user_id, label into owner_id, terminal_label from public.mt5_terminals where id = p_terminal_id;
    queued := public.enqueue_push_notification(
      owner_id, p_terminal_id, 'floating_pl_target',
      'floating-pl-target:' || p_terminal_id || ':' || s.cluster_id,
      'Floating P/L crossed +$' || trim(to_char(p_threshold, 'FM999999990.00')),
      trim(to_char(p_open_position_count, 'FM999999990')) || ' open position' || case when p_open_position_count = 1 then '' else 's' end || ' · +' || '$' || trim(to_char(p_total_pl, 'FM999999990.00')),
      jsonb_build_object('url','/?view=dashboard&tab=positions','floating_pl',p_total_pl,'position_count',p_open_position_count,'cluster_id',s.cluster_id,'terminal_label',terminal_label)
    );
    s.target_notified := true;
  end if;

  update public.push_position_cluster_state set cluster_id = s.cluster_id,
    open_position_count = p_open_position_count, last_total_pl = p_total_pl,
    target_notified = s.target_notified, cluster_started_at = s.cluster_started_at, updated_at = now()
  where terminal_id = p_terminal_id;
  return queued is not null;
end;
$$;

revoke all on function public.evaluate_floating_pl_push(uuid,integer,numeric,numeric)
  from public, anon, authenticated;
grant execute on function public.evaluate_floating_pl_push(uuid,integer,numeric,numeric)
  to service_role;

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
    where status = 'connected' and last_heartbeat_at < now() - p_stale_after
    returning id, user_id, label, last_heartbeat_at
  ), queued as (
    select public.enqueue_push_notification(
      user_id, id, 'terminal_disconnected',
      'terminal-disconnected:' || id || ':' || last_heartbeat_at::text,
      label || ' disconnected',
      'No MT5 heartbeat has arrived for more than 90 seconds.',
      jsonb_build_object('url','/?view=dashboard','terminal_id',id,'terminal_label',label,'last_heartbeat_at',last_heartbeat_at)
    ) from stale
  ) select count(*) into changed from queued;
  return changed;
end;
$$;

revoke all on function public.detect_disconnected_terminals_for_push(interval)
  from public, anon, authenticated;
grant execute on function public.detect_disconnected_terminals_for_push(interval)
  to service_role;

select cron.schedule(
  'push-terminal-disconnect-check', '* * * * *',
  $cron$select public.detect_disconnected_terminals_for_push(interval '90 seconds');$cron$
);
