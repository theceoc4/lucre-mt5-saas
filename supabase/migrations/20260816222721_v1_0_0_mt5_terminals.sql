create table public.mt5_terminals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  label text not null,
  broker text,
  account_login text,
  server text,
  is_live boolean not null default true,
  api_key_hash text unique,
  api_key_last_four text,
  status text not null default 'disconnected'
    check (status in ('disconnected', 'connected', 'error')),
  last_heartbeat_at timestamptz,
  equity numeric,
  balance numeric,
  margin_level numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_mt5_terminals_user_id on public.mt5_terminals(user_id);

create trigger trg_mt5_terminals_updated_at
  before update on public.mt5_terminals
  for each row execute function public.set_updated_at();
;
