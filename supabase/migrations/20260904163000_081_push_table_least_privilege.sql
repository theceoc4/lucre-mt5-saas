-- v1.0.57 -- close default structural grants on push-notification tables.
-- Migration 075 scoped authenticated DML but did not revoke the platform's
-- default anon/public table grants first. Keep browser access narrow and let
-- RLS continue to enforce per-user rows.

revoke all on table public.push_notification_preferences from public, anon, authenticated;
revoke all on table public.push_subscriptions from public, anon, authenticated;
revoke all on table public.push_notification_events from public, anon, authenticated;
revoke all on table public.push_position_cluster_state from public, anon, authenticated;

grant select, insert, update, delete on table public.push_notification_preferences to authenticated;
grant select, insert, update, delete on table public.push_subscriptions to authenticated;

grant all on table public.push_notification_preferences to service_role;
grant all on table public.push_subscriptions to service_role;
grant all on table public.push_notification_events to service_role;
grant all on table public.push_position_cluster_state to service_role;
