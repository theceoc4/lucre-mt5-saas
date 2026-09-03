-- v1.0.45 -- Server-side command latency checkpoints.
-- These timestamps distinguish dashboard/API time, terminal pickup time, and
-- result-return time without trusting the MT5 broker clock.

alter table public.ea_commands
  add column if not exists dispatched_at timestamptz,
  add column if not exists result_received_at timestamptz;

comment on column public.ea_commands.dispatched_at is
  'Server time when an active EA first claimed the queued command for execution.';

comment on column public.ea_commands.result_received_at is
  'Server time when the EA returned the terminal or broker execution result.';

