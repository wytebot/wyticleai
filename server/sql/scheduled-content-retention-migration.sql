-- Wyticle AI: temporary scheduled-article content retention
-- Run this once in Supabase SQL Editor after the original Wyticle AI schema.
-- Scheduled article content is kept in the database only until delivery succeeds,
-- or until 7 days after the scheduled time if delivery fails.

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

alter table public.wryte_scheduled_posts alter column project drop not null;
alter table public.wryte_scheduled_posts add column if not exists content_expires_at timestamptz;
alter table public.wryte_scheduled_posts add column if not exists content_purged_at timestamptz;
update public.wryte_scheduled_posts
set content_expires_at = coalesce(completed_at, due_at) + interval '7 days'
where content_expires_at is null;
alter table public.wryte_scheduled_posts alter column content_expires_at set default (now() + interval '7 days');
alter table public.wryte_scheduled_posts alter column content_expires_at set not null;
create index if not exists wryte_scheduled_posts_due on public.wryte_scheduled_posts(status, due_at) where status = 'pending';
create index if not exists wryte_scheduled_posts_user_due on public.wryte_scheduled_posts(user_id, due_at desc);
create index if not exists wryte_scheduled_posts_content_expiry on public.wryte_scheduled_posts(content_expires_at) where project is not null;
alter table public.wryte_scheduled_posts enable row level security;
-- Do not add anon/authenticated policies. The API accesses this table using the service role.

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
