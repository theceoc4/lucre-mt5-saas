create extension if not exists pg_net;
create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'strategy-signal-engine-1min') then
    perform cron.unschedule('strategy-signal-engine-1min');
  end if;
end $$;

select cron.schedule(
  'strategy-signal-engine-1min',
  '* * * * *',
  $cron$
    select net.http_post(
      url := 'https://qxlfnscmrhwfcpattqxa.supabase.co/functions/v1/strategy-signal-engine',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb
    ) as request_id;
  $cron$
);
;
