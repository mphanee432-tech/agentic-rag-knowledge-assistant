import { apiError, HttpError, requireProject, requireUser } from "@/lib/auth"
import { createAdminClient } from "@/lib/supabase/admin"
export async function GET(req: Request) {
  try {
    const { supabase, project } = await requireProject(new URL(req.url).searchParams.get("projectId"), req)
    const { data, error } = await supabase.from("documents")
      .select("id, project_id, storage_path, status, created_at, last_ingestion_error").eq("project_id", project.id)
      .order("created_at", { ascending: false })
    if (error) throw error
    return Response.json({ documents: data })
  } catch (error) { return apiError(error) }
}
export async function DELETE(req: Request) {
  try {
    const { supabase } = await requireUser(req, "personal")
    const id = new URL(req.url).searchParams.get("documentId")
    if (!id) throw new HttpError(400, "Document ID is required.")
    const { data: doc, error } = await supabase.from("documents").select("id, project_id, storage_path").eq("id", id).maybeSingle()
    if (error) throw error
    if (!doc) throw new HttpError(404, "Document not found.")
    await requireProject(doc.project_id, req)
    // Delete first: an in-flight ingestion finalizer cannot resurrect this record.
    const { error: deletion } = await supabase.from("documents").delete().eq("id", id).eq("project_id", doc.project_id)
    if (deletion) throw deletion
    const { error: storage } = await createAdminClient("personal").storage.from("documents").remove([doc.storage_path])
    if (storage) throw new HttpError(500, "Document deleted, but storage cleanup failed. Contact your administrator.")
    return Response.json({ success: true })
  } catch (error) { return apiError(error) }
}
