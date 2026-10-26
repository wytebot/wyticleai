-- Wyticle AI production schema. Run in Supabase SQL editor using the project owner.
create extension if not exists pgcrypto;

create table if not exists public.wryte_wallets (
  user_id text primary key,
  credits bigint not null default 0 check (credits >= 0),
  free_generations_used integer not null default 0 check (free_generations_used between 0 and 2),
  trial_project_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wryte_usage_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.wryte_wallets(user_id) on delete cascade,
  action text not null,
  project_id text,
  reserved_credits bigint not null default 0,
  is_free boolean not null default false,
  status text not null default 'reserved' check (status in ('reserved','settled','released')),
  actual_credits bigint,
  usage jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index if not exists wryte_usage_user_created on public.wryte_usage_reservations(user_id, created_at desc);

create table if not exists public.wryte_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.wryte_wallets(user_id) on delete cascade,
  delta bigint not null,
  reason text not null,
  reference text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(user_id, reason, reference)
);

create table if not exists public.wryte_connections (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.wryte_wallets(user_id) on delete cascade,
  provider text not null check (provider in ('blogger')),
  site_url text,
  blog_id text,
  blog_name text,
  username text,
  access_token_enc text,
  refresh_token_enc text,
  credential_enc text,
  token_expiry timestamptz,
  created_at timestamptz not null default now(),
  unique(user_id, provider, site_url),
  unique(user_id, provider, blog_id)
);
create index if not exists wryte_connections_user on public.wryte_connections(user_id);

create table if not exists public.wryte_oauth_states (
  state_hash text primary key,
  user_id text not null references public.wryte_wallets(user_id) on delete cascade,
  provider text not null,
  return_url text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.wryte_oauth_states add column if not exists return_url text;

create table if not exists public.wryte_drive_settings (
  user_id text primary key references public.wryte_wallets(user_id) on delete cascade,
  folder_id text,
  access_token_enc text,
  refresh_token_enc text,
  token_expiry timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.wryte_payments (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.wryte_wallets(user_id) on delete cascade,
  provider text not null default 'flutterwave-v4',
  reference text not null unique,
  amount numeric(12,2) not null,
  currency text not null,
  credits bigint not null check (credits > 0),
  status text not null default 'pending' check (status in ('pending','succeeded','failed','refunded')),
  provider_transaction_id text,
  verified_payload jsonb,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

-- All writes below are SECURITY DEFINER functions callable only by service role.
create or replace function public.wryte_reserve_usage(
  p_user_id text, p_action text, p_project_id text, p_estimated_credits bigint
) returns jsonb language plpgsql security definer set search_path=public as $$
declare w public.wryte_wallets%rowtype; rid uuid; is_trial boolean := false; reserved bigint := greatest(0,p_estimated_credits);
begin
  insert into public.wryte_wallets(user_id) values(p_user_id) on conflict(user_id) do nothing;
  select * into w from public.wryte_wallets where user_id=p_user_id for update;
  if p_action='initial' and p_project_id is not null and (w.trial_project_ids @> jsonb_build_array(p_project_id)) then
    -- An initial-generation request against an existing trial project is billable; only the original
    -- initial generation can consume a free entitlement. Revisions/fixes remain free on that project.
    if w.credits < reserved then return jsonb_build_object('ok',false,'error','Not enough credits. Purchase a credit pack to continue.'); end if;
    update public.wryte_wallets set credits=credits-reserved,updated_at=now() where user_id=p_user_id;
    insert into public.wryte_credit_ledger(user_id,delta,reason,reference,metadata) values(p_user_id,-reserved,'reserve',gen_random_uuid()::text,jsonb_build_object('action',p_action,'project_id',p_project_id));
  elsif p_action='initial' and w.free_generations_used < 2 then
    is_trial := true;
    update public.wryte_wallets set free_generations_used=free_generations_used+1,
      trial_project_ids=case when p_project_id is null then trial_project_ids else trial_project_ids || jsonb_build_array(p_project_id) end,
      updated_at=now() where user_id=p_user_id;
    reserved := 0;
  else
    if w.credits < reserved then return jsonb_build_object('ok',false,'error','Not enough credits. Purchase a credit pack to continue.'); end if;
    update public.wryte_wallets set credits=credits-reserved,updated_at=now() where user_id=p_user_id;
    insert into public.wryte_credit_ledger(user_id,delta,reason,reference,metadata) values(p_user_id,-reserved,'reserve',gen_random_uuid()::text,jsonb_build_object('action',p_action,'project_id',p_project_id));
  end if;
  insert into public.wryte_usage_reservations(user_id,action,project_id,reserved_credits,is_free) values(p_user_id,p_action,p_project_id,reserved,is_trial) returning id into rid;
  return jsonb_build_object('ok',true,'reservation_id',rid,'reserved_credits',reserved,'free',is_trial);
end $$;

create or replace function public.wryte_settle_usage(
  p_reservation_id uuid, p_user_id text, p_actual_credits bigint, p_usage jsonb, p_action text, p_project_id text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.wryte_usage_reservations%rowtype; w public.wryte_wallets%rowtype; actual bigint := greatest(0,p_actual_credits); extra bigint;
begin
  select * into r from public.wryte_usage_reservations where id=p_reservation_id and user_id=p_user_id for update;
  if not found then raise exception 'reservation not found'; end if;
  if r.status='settled' then return jsonb_build_object('ok',true,'duplicate',true); end if;
  if r.status <> 'reserved' then raise exception 'reservation is no longer active'; end if;
  if r.is_free then actual := 0; end if;
  select * into w from public.wryte_wallets where user_id=p_user_id for update;
  extra := greatest(0,actual-r.reserved_credits);
  if extra > w.credits then
    -- Never allow negative balance; settle at the reserved amount if a cost estimate was too low.
    actual := r.reserved_credits;
  end if;
  update public.wryte_wallets set credits=credits + greatest(0,r.reserved_credits-actual),updated_at=now() where user_id=p_user_id;
  if r.reserved_credits > actual then insert into public.wryte_credit_ledger(user_id,delta,reason,reference,metadata) values(p_user_id,r.reserved_credits-actual,'usage-refund',p_reservation_id::text,jsonb_build_object('action',p_action)); end if;
  if extra > 0 and actual > r.reserved_credits then
    update public.wryte_wallets set credits=credits-extra,updated_at=now() where user_id=p_user_id;
    insert into public.wryte_credit_ledger(user_id,delta,reason,reference,metadata) values(p_user_id,-extra,'usage-extra',p_reservation_id::text,jsonb_build_object('action',p_action));
  end if;
  update public.wryte_usage_reservations set status='settled',actual_credits=actual,usage=coalesce(p_usage,'{}'::jsonb),settled_at=now() where id=p_reservation_id;
  return jsonb_build_object('ok',true,'actual_credits',actual);
end $$;

create or replace function public.wryte_release_usage(p_reservation_id uuid,p_user_id text) returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.wryte_usage_reservations%rowtype;
begin
  select * into r from public.wryte_usage_reservations where id=p_reservation_id and user_id=p_user_id for update;
  if not found or r.status <> 'reserved' then return jsonb_build_object('ok',true,'released',false); end if;
  if r.reserved_credits > 0 then
    update public.wryte_wallets set credits=credits+r.reserved_credits,updated_at=now() where user_id=p_user_id;
    insert into public.wryte_credit_ledger(user_id,delta,reason,reference,metadata) values(p_user_id,r.reserved_credits,'failed-operation-refund',r.id::text,jsonb_build_object('action',r.action));
  end if;
  if r.is_free and r.action='initial' then
    update public.wryte_wallets set free_generations_used=greatest(0,free_generations_used-1),trial_project_ids=case when r.project_id is null then trial_project_ids else trial_project_ids - r.project_id end,updated_at=now() where user_id=p_user_id;
  end if;
  update public.wryte_usage_reservations set status='released',settled_at=now() where id=r.id;
  return jsonb_build_object('ok',true,'released',true);
end $$;

create or replace function public.wryte_register_trial_project(p_user_id text,p_project_id text) returns jsonb language plpgsql security definer set search_path=public as $$
begin
  update public.wryte_wallets set trial_project_ids=case when trial_project_ids @> jsonb_build_array(p_project_id) then trial_project_ids else trial_project_ids || jsonb_build_array(p_project_id) end,updated_at=now() where user_id=p_user_id;
  return jsonb_build_object('ok',true);
end $$;

alter table public.wryte_wallets enable row level security;
alter table public.wryte_usage_reservations enable row level security;
alter table public.wryte_credit_ledger enable row level security;
alter table public.wryte_connections enable row level security;
alter table public.wryte_oauth_states enable row level security;
alter table public.wryte_drive_settings enable row level security;
alter table public.wryte_payments enable row level security;
-- No client policies: access is server-side only via Supabase service-role key. Never ship that key to the app.

-- Keep service RPCs unavailable to browser roles; only the server service-role key may execute them.
revoke all on function public.wryte_reserve_usage(text,text,text,bigint) from public, anon, authenticated;
revoke all on function public.wryte_settle_usage(uuid,text,bigint,jsonb,text,text) from public, anon, authenticated;
revoke all on function public.wryte_release_usage(uuid,text) from public, anon, authenticated;
revoke all on function public.wryte_register_trial_project(text,text) from public, anon, authenticated;
grant execute on function public.wryte_reserve_usage(text,text,text,bigint) to service_role;
grant execute on function public.wryte_settle_usage(uuid,text,bigint,jsonb,text,text) to service_role;
grant execute on function public.wryte_release_usage(uuid,text) to service_role;
grant execute on function public.wryte_register_trial_project(text,text) to service_role;

create or replace function public.wryte_credit_payment(
  p_user_id text, p_reference text, p_credits bigint, p_transaction_id text, p_verified_payload jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare p public.wryte_payments%rowtype;
begin
  select * into p from public.wryte_payments where user_id=p_user_id and reference=p_reference for update;
  if not found then raise exception 'payment not found'; end if;
  if p.status='succeeded' then return jsonb_build_object('ok',true,'duplicate',true); end if;
  if p.status <> 'pending' then raise exception 'payment is not pending'; end if;
  if p.credits <> p_credits then raise exception 'credit amount mismatch'; end if;
  update public.wryte_wallets set credits=credits+p_credits,updated_at=now() where user_id=p_user_id;
  insert into public.wryte_credit_ledger(user_id,delta,reason,reference,metadata) values(p_user_id,p_credits,'purchase',p_reference,jsonb_build_object('provider_transaction_id',p_transaction_id));
  update public.wryte_payments set status='succeeded',provider_transaction_id=p_transaction_id,verified_payload=coalesce(p_verified_payload,'{}'::jsonb),paid_at=now() where id=p.id;
  return jsonb_build_object('ok',true,'duplicate',false);
end $$;
revoke all on function public.wryte_credit_payment(text,text,bigint,text,jsonb) from public, anon, authenticated;
grant execute on function public.wryte_credit_payment(text,text,bigint,text,jsonb) to service_role;

-- Durable scheduled publishing queue. Only the server service-role key may access this table.
create table if not exists public.wryte_scheduled_posts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.wryte_wallets(user_id) on delete cascade,
  project_id text not null,
  project jsonb,
  destinations jsonb not null,
  site_ids jsonb not null default '{}'::jsonb,
  due_at timestamptz not null,
  content_expires_at timestamptz not null default (now() + interval '7 days'),
  content_purged_at timestamptz,
  status text not null default 'pending' check (status in ('pending','processing','published','failed','cancelled')),
  results jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
-- Migration-safe additions for projects that already created the scheduling table.
alter table public.wryte_scheduled_posts alter column project drop not null;
alter table public.wryte_scheduled_posts add column if not exists content_expires_at timestamptz;
alter table public.wryte_scheduled_posts add column if not exists content_purged_at timestamptz;
update public.wryte_scheduled_posts set content_expires_at=coalesce(completed_at,due_at)+interval '7 days' where content_expires_at is null;
alter table public.wryte_scheduled_posts alter column content_expires_at set default (now() + interval '7 days');
alter table public.wryte_scheduled_posts alter column content_expires_at set not null;
create index if not exists wryte_scheduled_posts_due on public.wryte_scheduled_posts(status, due_at) where status = 'pending';
create index if not exists wryte_scheduled_posts_user_due on public.wryte_scheduled_posts(user_id, due_at desc);
create index if not exists wryte_scheduled_posts_content_expiry on public.wryte_scheduled_posts(content_expires_at) where project is not null;
alter table public.wryte_scheduled_posts enable row level security;
-- Do not add anon/authenticated policies. Access is through the authenticated server using service role.

-- Wyticle AI scheduling admission control. Limits are enforced atomically in PostgreSQL.
create or replace function public.wryte_enqueue_scheduled_post(
  p_user_id text,
  p_project_id text,
  p_project jsonb,
  p_destinations jsonb,
  p_site_ids jsonb,
  p_due_at timestamptz,
  p_content_expires_at timestamptz,
  p_user_limit integer default 10,
  p_global_limit integer default 500
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_count integer;
  v_global_count integer;
  v_row public.wryte_scheduled_posts%rowtype;
  v_user_limit integer := greatest(1, least(coalesce(p_user_limit, 10), 100));
  v_global_limit integer := greatest(1, least(coalesce(p_global_limit, 500), 10000));
begin
  -- Serialize admissions so simultaneous requests cannot exceed the global or per-account cap.
  perform pg_advisory_xact_lock(736210, 1);

  select count(*) into v_user_count
    from public.wryte_scheduled_posts
    where user_id = p_user_id and status in ('pending', 'processing');

  if v_user_count >= v_user_limit then
    return jsonb_build_object(
      'ok', false,
      'code', 'USER_LIMIT',
      'error', format('You can have up to %s active scheduled articles at a time. Publish or cancel an existing schedule before adding another.', v_user_limit)
    );
  end if;

  select count(*) into v_global_count
    from public.wryte_scheduled_posts
    where status in ('pending', 'processing');

  if v_global_count >= v_global_limit then
    return jsonb_build_object(
      'ok', false,
      'code', 'GLOBAL_LIMIT',
      'error', 'Scheduled publishing is temporarily at capacity. Please try again later.'
    );
  end if;

  insert into public.wryte_scheduled_posts
    (user_id, project_id, project, destinations, site_ids, due_at, content_expires_at, status)
  values
    (p_user_id, p_project_id, p_project, p_destinations, coalesce(p_site_ids, '{}'::jsonb), p_due_at, p_content_expires_at, 'pending')
  returning * into v_row;

  return jsonb_build_object('ok', true, 'row', jsonb_build_object('id', v_row.id, 'due_at', v_row.due_at, 'status', v_row.status));
end;
$$;

revoke all on function public.wryte_enqueue_scheduled_post(text,text,jsonb,jsonb,jsonb,timestamptz,timestamptz,integer,integer) from public, anon, authenticated;
grant execute on function public.wryte_enqueue_scheduled_post(text,text,jsonb,jsonb,jsonb,timestamptz,timestamptz,integer,integer) to service_role;
-- Card billing: remember each user's Flutterwave v4 customer id so a customer is created only once.
alter table public.wryte_wallets add column if not exists flw_customer_id text;

alter table public.wryte_wallets add column if not exists trial_followups integer not null default 0;
-- Wyticle AI: harden free follow-up reservations and one-time payment crediting.
-- Run in Supabase SQL Editor after the existing schema/pricing migrations.

alter table public.wryte_wallets
  add column if not exists trial_followups integer not null default 0;

-- Each successful reservation increments the account-level trial follow-up count atomically.
-- The project must be one of this user's registered free-trial projects.
create or replace function public.wryte_reserve_trial_followup(
  p_user_id text, p_project_id text, p_action text, p_limit integer default 4
) returns jsonb language plpgsql security definer set search_path=public as $$
declare w public.wryte_wallets%rowtype; rid uuid; cap integer := greatest(0, least(coalesce(p_limit,4),20));
begin
  if p_action not in ('revision','fix','diagnose') then
    return jsonb_build_object('ok',false,'reason','unsupported_action');
  end if;
  select * into w from public.wryte_wallets where user_id=p_user_id for update;
  if not found or not (coalesce(w.trial_project_ids,'[]'::jsonb) @> jsonb_build_array(p_project_id)) then
    return jsonb_build_object('ok',false,'reason','not_trial_project');
  end if;
  if coalesce(w.trial_followups,0) >= cap then
    return jsonb_build_object('ok',false,'reason','limit_reached');
  end if;
  update public.wryte_wallets set trial_followups=trial_followups+1,updated_at=now() where user_id=p_user_id;
  insert into public.wryte_usage_reservations(user_id,action,project_id,reserved_credits,is_free,status)
    values(p_user_id,'trial_followup',p_project_id,0,true,'reserved') returning id into rid;
  return jsonb_build_object('ok',true,'reservation_id',rid,'reserved_credits',0,'free',true);
end $$;

-- Releasing a failed free follow-up returns its trial slot, allowing a retry.
create or replace function public.wryte_release_usage(p_reservation_id uuid,p_user_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.wryte_usage_reservations%rowtype;
begin
  select * into r from public.wryte_usage_reservations where id=p_reservation_id and user_id=p_user_id for update;
  if not found or r.status <> 'reserved' then return jsonb_build_object('ok',true,'released',false); end if;
  if r.reserved_credits > 0 then
    update public.wryte_wallets set credits=credits+r.reserved_credits,updated_at=now() where user_id=p_user_id;
    insert into public.wryte_credit_ledger(user_id,delta,reason,reference,metadata)
      values(p_user_id,r.reserved_credits,'failed-operation-refund',r.id::text,jsonb_build_object('action',r.action))
      on conflict(user_id,reason,reference) do nothing;
  end if;
  if r.is_free and r.action='initial' then
    update public.wryte_wallets set free_generations_used=greatest(0,free_generations_used-1),
      trial_project_ids=case when r.project_id is null then trial_project_ids else trial_project_ids-r.project_id end,
      updated_at=now() where user_id=p_user_id;
  elsif r.is_free and r.action='trial_followup' then
    update public.wryte_wallets set trial_followups=greatest(0,trial_followups-1),updated_at=now() where user_id=p_user_id;
  end if;
  update public.wryte_usage_reservations set status='released',settled_at=now() where id=r.id;
  return jsonb_build_object('ok',true,'released',true);
end $$;

-- Ensure one provider transaction cannot credit two different payment records.
create unique index if not exists wryte_payments_provider_transaction_unique
  on public.wryte_payments(provider, provider_transaction_id)
  where provider_transaction_id is not null;

-- Validate provider evidence again inside the atomic database transaction before wallet crediting.
create or replace function public.wryte_credit_payment(
  p_user_id text, p_reference text, p_credits bigint, p_transaction_id text, p_verified_payload jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare p public.wryte_payments%rowtype; evidence jsonb := coalesce(p_verified_payload,'{}'::jsonb);
begin
  select * into p from public.wryte_payments where user_id=p_user_id and reference=p_reference for update;
  if not found then raise exception 'payment not found'; end if;
  if p.status='succeeded' then return jsonb_build_object('ok',true,'duplicate',true); end if;
  -- A provider-verified success always wins over a locally recorded 'failed' (e.g. a timeout was misread as a decline).
  -- Evidence is still validated below (status, reference, currency, transaction id, amount) before any credit is added.
  if p.status not in ('pending','failed') then raise exception 'payment cannot be credited from status %', p.status; end if;
  if p.credits <> p_credits then raise exception 'credit amount mismatch'; end if;
  if coalesce(evidence->>'status','') <> 'succeeded'
    or coalesce(evidence->>'reference','') <> p.reference
    or upper(coalesce(evidence->>'currency','')) <> upper(p.currency)
    or coalesce(evidence->>'id','') <> p_transaction_id
    or coalesce(evidence->>'id','') <> coalesce(p.provider_transaction_id,'')
    or coalesce((evidence->>'amount')::numeric,-1) <> p.amount then
    raise exception 'verified provider transaction does not match payment record';
  end if;
  update public.wryte_wallets set credits=credits+p_credits,updated_at=now() where user_id=p_user_id;
  insert into public.wryte_credit_ledger(user_id,delta,reason,reference,metadata)
    values(p_user_id,p_credits,'purchase',p_reference,jsonb_build_object('provider_transaction_id',p_transaction_id));
  update public.wryte_payments set status='succeeded',verified_payload=evidence,paid_at=now()
    where id=p.id;
  return jsonb_build_object('ok',true,'duplicate',false);
end $$;

revoke all on function public.wryte_reserve_trial_followup(text,text,text,integer) from public, anon, authenticated;
grant execute on function public.wryte_reserve_trial_followup(text,text,text,integer) to service_role;
revoke all on function public.wryte_release_usage(uuid,text) from public, anon, authenticated;
grant execute on function public.wryte_release_usage(uuid,text) to service_role;
revoke all on function public.wryte_credit_payment(text,text,bigint,text,jsonb) from public, anon, authenticated;
grant execute on function public.wryte_credit_payment(text,text,bigint,text,jsonb) to service_role;
