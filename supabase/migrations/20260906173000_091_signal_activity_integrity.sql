-- v1.0.73 -- keep the external ingress audit long enough for the dashboard's
-- Year view and support the terminal-scoped incremental activity queries.

create index if not exists idx_signals_terminal_generated_id
  on public.signals (terminal_id, generated_at desc, id desc);

create index if not exists idx_signal_deliveries_terminal_created_id
  on public.signal_deliveries (terminal_id, created_at desc, id desc);

create index if not exists idx_external_signal_events_terminal_processed
  on public.external_signal_events (terminal_id, processed_at desc)
  where processed_at is not null;

create or replace function public.prune_external_signal_events()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed integer;
begin
  -- The product exposes a rolling Year activity view. Keep slightly more than
  -- one year so late timezone changes and week buckets do not lose edge rows.
  delete from public.external_signal_events
  where received_at < now() - interval '400 days';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.prune_external_signal_events() from public, anon, authenticated;
grant execute on function public.prune_external_signal_events() to service_role;

comment on function public.prune_external_signal_events() is
  'Prunes terminal-private external signal ingress audit rows after 400 days, preserving the dashboard Year view.';
