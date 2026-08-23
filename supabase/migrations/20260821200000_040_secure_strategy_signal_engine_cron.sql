-- v1.0.20 — authenticate the internal strategy signal-engine scheduler.
--
-- The signal engine uses service-role database access and can enqueue automatic
-- orders. Its once-per-minute pg_cron invocation must therefore not be a public
-- Edge Function endpoint. Keep the scheduler credential in Vault: the secret is
-- generated during this migration and never appears in source control or logs.

create extension if not exists supabase_vault with schema vault;

do $$
begin
  if not exists (
    select 1
    from vault.secrets
    where name = 'strategy_engine_scheduler_secret'
  ) then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'strategy_engine_scheduler_secret',
      'Authenticates pg_cron calls to strategy-signal-engine.'
    );
  end if;
end $$;

-- Edge Functions cannot read Vault directly. This narrowly scoped, service-role
-- only verifier lets strategy-signal-engine validate the request header without
-- returning the secret through PostgREST.
create or replace function public.verify_strategy_engine_scheduler_secret(
  supplied_secret text
)
returns boolean
language sql
security definer
set search_path = vault, public, pg_temp
as $$
  select exists (
    select 1
    from vault.decrypted_secrets
    where name = 'strategy_engine_scheduler_secret'
      and decrypted_secret = supplied_secret
  );
$$;

revoke all on function public.verify_strategy_engine_scheduler_secret(text)
  from public, anon, authenticated;
grant execute on function public.verify_strategy_engine_scheduler_secret(text)
  to service_role;

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
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-lucre-scheduler-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'strategy_engine_scheduler_secret'
        )
      ),
      body := '{}'::jsonb
    ) as request_id;
  $cron$
);
