-- S1-P3: reviewed locally only; hosted execution requires separate approval.
begin;

do $$
begin
  if not (select relrowsecurity from pg_class where oid='public.interactions'::regclass)
    or (select count(*) from pg_policies where schemaname='public' and tablename='interactions') <> 4
    or not exists (select 1 from pg_policies where schemaname='public' and tablename='interactions'
      and policyname='owner_boundary' and permissive='RESTRICTIVE' and cmd='ALL'
      and roles=array['public']::name[] and qual is not null and with_check is not null)
    or not exists (select 1 from pg_policies where schemaname='public' and tablename='interactions'
      and policyname='Interactions tenant isolation policy' and permissive='PERMISSIVE' and cmd='ALL'
      and roles=array['public']::name[])
    or not exists (select 1 from pg_policies where schemaname='public' and tablename='interactions'
      and policyname='owner_read' and permissive='PERMISSIVE' and cmd='SELECT'
      and roles=array['authenticated']::name[] and qual='true' and with_check is null)
    or not exists (select 1 from pg_policies where schemaname='public' and tablename='interactions'
      and policyname='owner_feedback_update' and permissive='PERMISSIVE' and cmd='UPDATE'
      and roles=array['authenticated']::name[] and qual='true' and with_check='true') then
    raise exception 'Unexpected interaction RLS baseline; review before applying S1-P3';
  end if;
  if has_table_privilege('anon','public.interactions','SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated','public.interactions','INSERT,UPDATE,DELETE')
    or not has_table_privilege('authenticated','public.interactions','SELECT')
    or not has_column_privilege('authenticated','public.interactions','feedback','UPDATE')
    or exists (select 1 from pg_attribute where attrelid='public.interactions'::regclass
      and attnum>0 and not attisdropped and attname<>'feedback'
      and has_column_privilege('authenticated','public.interactions',attname,'UPDATE')) then
    raise exception 'Unexpected interaction client privileges; S1-P3 does not change grants';
  end if;
end $$;

-- Keep owner_boundary intact; remove every legacy permissive interaction policy.
drop policy "Interactions tenant isolation policy" on public.interactions;
drop policy owner_read on public.interactions;
drop policy owner_feedback_update on public.interactions;

create policy owner_read on public.interactions as permissive for select to authenticated
  using (user_id=auth.uid() and exists (
    select 1 from public.projects p where p.id=interactions.project_id and p.user_id=auth.uid()
  ));

create policy owner_feedback_update on public.interactions as permissive for update to authenticated
  using (user_id=auth.uid() and exists (
    select 1 from public.projects p where p.id=interactions.project_id and p.user_id=auth.uid()
  ))
  with check (user_id=auth.uid() and exists (
    select 1 from public.projects p where p.id=interactions.project_id and p.user_id=auth.uid()
  ));

commit;
