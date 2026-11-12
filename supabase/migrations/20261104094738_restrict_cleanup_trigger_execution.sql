-- Trigger invocation does not require callers to have direct function execution grants.
revoke all on function public.delete_document_children() from public, anon, authenticated;
revoke all on function public.delete_project_children() from public, anon, authenticated;
