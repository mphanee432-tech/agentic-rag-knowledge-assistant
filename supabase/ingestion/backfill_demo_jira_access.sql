-- One-time, idempotent backfill restricted to the two verified, confirmed Jira test accounts
-- with active Enterprise membership that explicitly opted in during signup.
-- Preserves existing public.demo_jira_access records (`ON CONFLICT DO NOTHING`),
-- excludes unconfirmed accounts (`email_confirmed_at IS NULL`), and leaves other accounts untouched.

begin;
set local lock_timeout = '5s';

insert into public.demo_jira_access (user_id, enabled)
select u.id, true
from auth.users u
where u.id in (
    'd42e40d5-e1f5-4261-b002-a02b10c7c4dd'::uuid,
    '12ff1269-30f0-48b0-ad9b-76a93d8e90b1'::uuid
  )
  and u.email_confirmed_at is not null
  and coalesce(nullif(btrim(u.email), ''), '') <> ''
  and (u.raw_user_meta_data ->> 'demo_jira_access') = 'true'
  and exists (
    select 1
    from public.organization_employees e
    where e.user_id = u.id
      and e.is_active = true
  )
on conflict (user_id) do nothing;

commit;
