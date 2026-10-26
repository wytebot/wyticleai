-- Card billing: remember each user's Flutterwave v4 customer id so a customer is created only once.
alter table public.wryte_wallets add column if not exists flw_customer_id text;
