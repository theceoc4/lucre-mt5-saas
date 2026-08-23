-- v1.0.10 — Strategy attribution on ea_commands + stuck-command sweep.
--
-- Closes two gaps identified after the EA (v1.0.9) shipped:
--
--   A. Strategy attribution: ea_commands had no strategy_id column, so the
--      only place strategy_id ever existed for an auto-executed trade was
--      signals.strategy_id (via signal_delivery_id -> signal_deliveries ->
--      signals). ea-sync's pending_commands response never surfaced it, so
--      the EA always reported strategy_id=null on every position, and
--      positions.strategy_id (and by extension trade_history.strategy_id,
--      copied from positions at close time) was permanently null for any
--      position opened through the EA. This adds the column; signal-action
--      populates it at insert time from the originating signal, and
--      position-action carries the position's own strategy_id forward onto
--      its modify/close commands for audit-trail consistency. manual-order
--      and manual dashboard actions with no strategy behind them correctly
--      leave it null. ea-sync's pending_commands query is `select("*")`, so
--      the new column reaches the EA with no edge-function code change.
--
--   B. Stuck-command recovery: ea-sync flips queued -> sent the instant it
--      hands a command to the EA and only ever re-offers rows still in
--      'queued' -- a 'sent' row that never gets a command_result (EA crash,
--      lost connectivity, terminal restart) stays stuck forever. This adds
--      sweep_attempts + public.sweep_stuck_commands(), scheduled via
--      pg_cron every 5 minutes -- the same in-database scheduling pattern
--      already used for throttle_sweep() (migration 025). This is pure
--      backend housekeeping with no external data source, so it is not
--      subject to the "no schedule_cron / no third-party API" restriction
--      that governs calendar ingestion specifically (migration 028) --
--      that restriction was about where calendar *data* comes from, not
--      about which scheduler runs backend maintenance jobs.
--
--      A command stuck in 'sent' for more than 5 minutes is reset back to
--      'queued' (so ea-sync re-offers it) up to 3 times, then marked
--      'expired' ('expired' has been a valid ea_commands.status value since
--      migration 009 but no code path ever used it until now). Re-queuing a
--      command that actually DID execute -- just never got its result
--      reported -- would duplicate the order if the EA blindly re-ran it;
--      EASync.mqh's existing "lucrehub:<command_id>" position-comment
--      convention (already present in EASync_ExecuteOpen since v1.0.9) is
--      now checked before every open/hedge_open execution, so a re-queued
--      command that already has a matching open position is reported
--      executed against that position instead of placed again.

-- ---------------------------------------------------------------------
-- A. strategy_id on ea_commands
-- ---------------------------------------------------------------------
alter table public.ea_commands
  add column strategy_id uuid references public.strategies(id) on delete set null;

create index idx_ea_commands_strategy_id on public.ea_commands(strategy_id)
  where strategy_id is not null;

comment on column public.ea_commands.strategy_id is
  'Strategy this command is attributed to, if any. Populated at insert time '
  'by signal-action (from signals.strategy_id via signal_delivery_id) for '
  'tap-executed signals, and carried forward from positions.strategy_id by '
  'position-action for modify/close commands on an existing position. Null '
  'for manual_order and any command with no strategy behind it. Surfaced to '
  'the EA in ea-sync''s pending_commands (select * already includes it) so '
  'EASync.mqh can tag the resulting position report with it.';

-- ---------------------------------------------------------------------
-- B. Stuck-command sweep
-- ---------------------------------------------------------------------
alter table public.ea_commands
  add column sweep_attempts int not null default 0;

comment on column public.ea_commands.sweep_attempts is
  'Number of times sweep_stuck_commands() has reset this command from '
  '''sent'' back to ''queued'' after finding it stale. Capped at 3 -- once '
  'exceeded, the sweep marks the command ''expired'' instead of retrying '
  'again, rather than resurrecting a permanently-broken command forever.';

create or replace function public.sweep_stuck_commands() returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  -- Rows that have already exhausted their retry budget: give up.
  update public.ea_commands
     set status = 'expired',
         error_message = coalesce(error_message, 'stuck_in_sent_status_expired_after_max_sweep_retries')
   where status = 'sent'
     and requested_at < now() - interval '5 minutes'
     and sweep_attempts >= 3;

  -- Rows still within budget: reset to 'queued' so ea-sync re-offers them
  -- to the EA on its next poll. EASync_ExecuteOpen's idempotency check
  -- (lucrehub:<command_id> position-comment lookup) protects against a
  -- duplicate order if the command actually executed the first time.
  update public.ea_commands
     set status = 'queued',
         sweep_attempts = sweep_attempts + 1
   where status = 'sent'
     and requested_at < now() - interval '5 minutes'
     and sweep_attempts < 3;
end;
$$;

comment on function public.sweep_stuck_commands is
  'Backstop recovery for ea_commands stuck in status=''sent'' (EA received '
  'the command but never reported a result -- crash, disconnect, or '
  'terminal restart). Scheduled every 5 minutes via pg_cron. Resets stale '
  'rows back to ''queued'' up to 3 times, then marks them ''expired''. A '
  'poll interval is 1-2s, so anything still ''sent'' after 5 minutes is '
  'unambiguously stuck, not merely slow.';

create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'sweep-stuck-ea-commands') then
    perform cron.unschedule('sweep-stuck-ea-commands');
  end if;
end $$;

select cron.schedule('sweep-stuck-ea-commands', '*/5 * * * *', $cron$select public.sweep_stuck_commands();$cron$);
;
