begin;

create function wp3_private.enterprise_fallback_documents(target_organization_id uuid)
returns table (code text, own_department boolean)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select distinct candidate.code, p.department_id = e.department_id
  from public.organization_employees e
  join public.projects p on p.organization_id = e.organization_id and not p.is_d12
  join public.documents d on d.project_id = p.id
  join (values
    ('D01', 'D01_Revised_Candidate_1_1.pdf'),
    ('D02', 'D02_Leave_and_Attendance_Policy_DeccanBridge_Software_Reconciliation_Candidate_1_1.html'),
    ('D04', 'D04_Engineering_Code_Review_Bug_Reporting_and_Incident_SOP_DeccanBridge_Software_Reconciliation_Candidate_1_1.html'),
    ('D05', 'D05_Product_Feature_Intake_and_Prioritization_DeccanBridge_Software_Reconciliation_Candidate_1_1.txt'),
    ('D06', 'D06_Project_Risk_and_Escalation_DeccanBridge_Software_Reconciliation_Candidate_1_1.pdf'),
    ('D07', 'D07_Design_Handoff_and_Accessibility_DeccanBridge_Software_Reconciliation_Candidate_1_1.html'),
    ('D08', 'D08_Equipment_and_Service_Requests_DeccanBridge_Software_Reconciliation_Candidate_1_1.txt'),
    ('D09', 'D09_Brand_and_Campaign_Approval_DeccanBridge_Software_Reconciliation_Candidate_1_1.pdf'),
    ('D10', 'D10_Travel_and_Expense_Reimbursement_DeccanBridge_Software_Reconciliation_Candidate_1_1.html')
  ) candidate(code, filename) on candidate.filename = regexp_replace(d.storage_path, '^.*/', '')
  where e.organization_id = target_organization_id and e.user_id = (select auth.uid()) and e.is_active
    and (select auth.jwt()->>'is_anonymous') is distinct from 'true'
    and d.classification = 'standard'
    and (
      (candidate.code in ('D01', 'D02', 'D08', 'D10') and d.access_scope = 'company')
      or (candidate.code in ('D04', 'D05', 'D06', 'D07', 'D09')
        and d.access_scope = 'department' and p.department_id = e.department_id)
    )
    and wp3_private.can_read_document(d.id, p.id, true)
    and exists (select 1 from public.document_chunks c where c.document_id = d.id and c.project_id = p.id)
$$;

create function public.enterprise_fallback_documents(target_organization_id uuid)
returns table (code text, own_department boolean)
language sql stable security invoker set search_path = pg_catalog, pg_temp as $$
  select * from wp3_private.enterprise_fallback_documents(target_organization_id)
$$;

revoke all on function wp3_private.enterprise_fallback_documents(uuid),
  public.enterprise_fallback_documents(uuid) from public, anon, authenticated, service_role;
grant execute on function wp3_private.enterprise_fallback_documents(uuid),
  public.enterprise_fallback_documents(uuid) to authenticated;

commit;
