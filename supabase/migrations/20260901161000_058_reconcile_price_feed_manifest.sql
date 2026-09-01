-- v1.0.36 -- Keep the feed lifecycle manifest identical to the terminal's
-- current broker symbol mappings. Rows from deleted/replaced mappings must not
-- remain desired, otherwise health totals include series the EA can no longer
-- report.

create or replace function public.reconcile_price_feed_manifest(
  p_terminal_id uuid,
  p_desired jsonb
) returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  desired record;
begin
  if jsonb_typeof(p_desired) is distinct from 'array' then
    raise exception 'p_desired must be a JSON array';
  end if;

  for desired in
    select * from jsonb_to_recordset(p_desired) as item(
      symbol text,
      timeframe text,
      enabled boolean,
      priority_rank integer
    )
  loop
    insert into public.price_feed_series_state (
      terminal_id, symbol, timeframe, latest_bar_time, desired_enabled,
      priority_rank, bootstrap_generation, bootstrap_required, status,
      last_received_at, updated_at
    ) values (
      p_terminal_id, desired.symbol, desired.timeframe, null,
      coalesce(desired.enabled, false),
      least(greatest(coalesce(desired.priority_rank, 99), 0), 99),
      1, coalesce(desired.enabled, false),
      case when coalesce(desired.enabled, false) then 'pending' else 'disabled' end,
      now(), now()
    )
    on conflict (terminal_id, symbol, timeframe) do update set
      bootstrap_generation = case
        when not public.price_feed_series_state.desired_enabled
          and coalesce(desired.enabled, false)
        then public.price_feed_series_state.bootstrap_generation + 1
        else public.price_feed_series_state.bootstrap_generation
      end,
      bootstrap_required = case
        when not public.price_feed_series_state.desired_enabled
          and coalesce(desired.enabled, false) then true
        else public.price_feed_series_state.bootstrap_required
      end,
      status = case
        when not coalesce(desired.enabled, false) then 'disabled'
        when not public.price_feed_series_state.desired_enabled then 'pending'
        else public.price_feed_series_state.status
      end,
      desired_enabled = coalesce(desired.enabled, false),
      priority_rank = least(greatest(coalesce(desired.priority_rank, 99), 0), 99),
      updated_at = now()
    where public.price_feed_series_state.desired_enabled is distinct from coalesce(desired.enabled, false)
       or public.price_feed_series_state.priority_rank is distinct from
          least(greatest(coalesce(desired.priority_rank, 99), 0), 99);
  end loop;

  -- A broker mapping can be replaced or removed entirely, so it may no longer
  -- appear in p_desired at all. Disable those orphaned lifecycle rows without
  -- deleting their bounded history; re-pairing the same canonical symbol later
  -- will increment its generation and require a verified clean snapshot.
  update public.price_feed_series_state state set
    desired_enabled = false,
    priority_rank = 99,
    status = 'disabled',
    updated_at = now()
  where state.terminal_id = p_terminal_id
    and state.desired_enabled
    and not exists (
      select 1
      from jsonb_to_recordset(p_desired) as item(
        symbol text,
        timeframe text,
        enabled boolean,
        priority_rank integer
      )
      where item.symbol = state.symbol
        and item.timeframe = state.timeframe
        and coalesce(item.enabled, false)
    );
end;
$$;

revoke all on function public.reconcile_price_feed_manifest(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.reconcile_price_feed_manifest(uuid, jsonb)
  to service_role;

comment on function public.reconcile_price_feed_manifest(uuid, jsonb) is
  'Idempotently reconciles the complete enabled feed manifest, disables orphaned mappings, and requires a new clean bootstrap when a series is re-enabled.';
