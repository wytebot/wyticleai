-- Native push notification device registry for Wyticle AI.
-- Run once in the Supabase SQL editor using the project service owner account.
create table if not exists public.wryte_push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.wryte_wallets(user_id) on delete cascade,
  token text not null unique,
  platform text not null check (platform in ('android','ios')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wryte_push_devices_user_active on public.wryte_push_devices(user_id, active);
alter table public.wryte_push_devices enable row level security;
-- No client policies: the API uses the Supabase service-role key after verifying Firebase ID tokens.
