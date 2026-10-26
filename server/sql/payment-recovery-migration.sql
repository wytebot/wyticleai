-- Wyticle AI: payment recovery. Run once in the Supabase SQL Editor on databases that already ran
-- credit-payment-hardening-migration.sql. Fresh installs get this from schema.sql.
--
-- Allows wryte_credit_payment to credit a payment that was locally marked 'failed' when Flutterwave later
-- confirms it succeeded. All provider-evidence checks (status, reference, currency, transaction id, amount)
-- still run inside the same transaction, and a transaction id can still only credit one payment.

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

revoke all on function public.wryte_credit_payment(text,text,bigint,text,jsonb) from public, anon, authenticated;
grant execute on function public.wryte_credit_payment(text,text,bigint,text,jsonb) to service_role;
