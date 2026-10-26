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
