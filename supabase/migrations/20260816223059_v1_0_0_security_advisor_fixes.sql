-- Fix 1: pin search_path on the updated_at trigger helper (function_search_path_mutable)
alter function public.set_updated_at() set search_path = public, pg_temp;

-- Fix 2: handle_new_user is SECURITY DEFINER and only meant to run via the
-- auth.users insert trigger, not as a callable RPC endpoint for anon/authenticated.
alter function public.handle_new_user() set search_path = public, pg_temp;
revoke execute on function public.handle_new_user() from public;
revoke execute on function public.handle_new_user() from anon;
revoke execute on function public.handle_new_user() from authenticated;
;
