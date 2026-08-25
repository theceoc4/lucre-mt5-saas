-- v1.0.24 — document the expanded terminal-scoped Realtime topic contract.
-- No table writes are added: the EA publishes ephemeral position state
-- directly over Realtime Broadcast while ea-sync remains authoritative.

comment on column public.mt5_terminals.realtime_topic_id is
  'High-entropy terminal-scoped Realtime topic id, readable only through the terminal owner RLS row or terminal API-key configuration endpoint. Carries wake hints and ephemeral mark-to-market state; durable commands and positions remain authoritative.';

comment on function public.broadcast_ea_command_available is
  'Broadcasts a non-durable terminal-scoped command wake-up after an ea_commands insert; ea-sync remains authoritative.';
