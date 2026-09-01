-- Dashboard notification center: generated and policy-blocked signals must
-- arrive live just like deliveries, commands, positions, and closed trades.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'signals'
  ) then
    alter publication supabase_realtime add table public.signals;
  end if;
end
$$;
