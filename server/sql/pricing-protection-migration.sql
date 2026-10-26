-- Run once. Free follow-ups on trial articles are now capped by the API (TRIAL_FOLLOWUP_LIMIT per account);
-- after the cap, revision/fix/diagnose are billed like any other request.
alter table public.wryte_wallets add column if not exists trial_followups integer not null default 0;

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
revoke all on function public.wryte_reserve_usage(text,text,text,bigint) from public, anon, authenticated;
grant execute on function public.wryte_reserve_usage(text,text,text,bigint) to service_role;
