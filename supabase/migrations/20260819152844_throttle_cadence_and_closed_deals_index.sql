select cron.unschedule('throttle-sweep-15min');

select cron.schedule(
  'throttle-sweep-1min',
  '* * * * *',
  $cron$select public.throttle_sweep();$cron$
);

create index if not exists positions_terminal_ticket_status_idx
  on public.positions (terminal_id, mt5_ticket, status);;
