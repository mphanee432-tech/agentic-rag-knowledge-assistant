-- LOCAL TEST RESTORATION ONLY: restores broad pre-S1 policies; never deploy.
begin;
do $$ begin
  if current_setting('s1p3.local_target',true) is distinct from 'rag-baseline-20261107-01a1b3be' then
    raise exception 'Guarded local connection required';
  end if;
  if (select count(*) from pg_policies where schemaname='public' and tablename='interactions')<>3 then
    raise exception 'Unexpected S1-P3 policy inventory';
  end if;
end $$;
drop policy owner_read on public.interactions;
drop policy owner_feedback_update on public.interactions;
create policy "Interactions tenant isolation policy" on public.interactions as PERMISSIVE for ALL to public using ((user_id = auth.uid())) with check ((user_id = auth.uid()));
create policy owner_feedback_update on public.interactions as PERMISSIVE for UPDATE to authenticated using (true) with check (true);
create policy owner_read on public.interactions as PERMISSIVE for SELECT to authenticated using (true);
commit;

