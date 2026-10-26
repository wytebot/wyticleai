-- Wyticle AI Google Drive TXT archive configuration.
-- Run in Supabase SQL Editor on an existing installation.
create table if not exists public.wryte_drive_settings (
  user_id text primary key references public.wryte_wallets(user_id) on delete cascade,
  folder_id text,
  access_token_enc text,
  refresh_token_enc text,
  token_expiry timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.wryte_drive_settings enable row level security;
-- No browser policies: only the backend service-role key may read or write these encrypted credentials.
