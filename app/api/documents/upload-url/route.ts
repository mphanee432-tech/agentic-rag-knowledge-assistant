import { apiError, HttpError, requireProject, requireUser } from "@/lib/auth"
import { createAdminClient } from "@/lib/supabase/admin"

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { projectId, filename, fileSize, classification, accessScope, organizationId, departmentId } = body

    if (typeof filename !== "string" || !/\.(pdf|txt|html)$/i.test(filename) || filename.length > 200 ||
        !Number.isInteger(fileSize) || fileSize <= 0 || fileSize > 25 * 1024 * 1024) {
      throw new HttpError(400, "Upload a PDF, TXT, or HTML file between 1 byte and 25 MB.")
    }

    // Standard personal upload: preserve original behavior & error contract exactly
    if (classification === undefined && organizationId === undefined && departmentId === undefined) {
      const { project, user } = await requireProject(projectId, req)
      const admin = createAdminClient("personal")
      const documentId = crypto.randomUUID()
      const storagePath = `${user.id}/${project.id}/${documentId}/${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`
      const { error } = await admin.from("documents").insert({
        id: documentId,
        project_id: project.id,
        storage_path: storagePath,
        status: "pending_upload",
        expected_size: fileSize,
      })
      if (error) throw error
      const { data, error: uploadError } = await admin.storage.from("documents").createSignedUploadUrl(storagePath)
      if (uploadError || !data) {
        await admin.from("documents").update({ status: "failed" }).eq("id", documentId)
        throw new HttpError(503, "Unable to start upload. Please retry.")
      }
      return Response.json({ documentId, storagePath, token: data.token })
    }

    // Enterprise policy upload flow: verify enterprise uploader authorization in PostgreSQL
    const auth = await requireUser(req, "enterprise")
    const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
    if (typeof organizationId !== "string" || !uuid.test(organizationId) ||
        typeof departmentId !== "string" || !uuid.test(departmentId)) {
      throw new HttpError(400, "A valid organization and department are required.")
    }
    if ((classification !== "standard" && classification !== "restricted") ||
        (accessScope !== "department" && accessScope !== "company")) {
      throw new HttpError(400, "A valid classification and access scope are required.")
    }
    if (classification === "restricted" && accessScope === "company") {
      throw new HttpError(400, "Company-wide access scope is only available for Standard documents.")
    }

    const documentId = crypto.randomUUID()
    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_")
    const { data: reservation, error: reserveErr } = await auth.supabase.rpc("reserve_enterprise_policy", {
      target_organization_id: organizationId,
      target_department_id: departmentId,
      p_document_id: documentId,
      p_filename: safeFilename,
      p_expected_size: fileSize,
      p_classification: classification,
      p_access_scope: accessScope,
    }).single<{ project_id: string; storage_path: string }>()

    if (reserveErr?.code === "42501") throw new HttpError(403, "Enterprise upload authorization denied.")
    if (reserveErr?.code === "22023") throw new HttpError(400, "Invalid department or policy upload.")
    if (reserveErr) {
      throw new HttpError(500, "Failed to reserve enterprise document.")
    }
    const { project_id: reservedProjectId, storage_path: storagePath } = reservation

    const admin = createAdminClient("enterprise")
    const { data, error: uploadError } = await admin.storage.from("documents").createSignedUploadUrl(storagePath)
    if (uploadError || !data) {
      await admin.from("documents").update({ status: "failed" }).eq("id", documentId)
      throw new HttpError(503, "Unable to start upload. Please retry.")
    }

    return Response.json({
      documentId,
      projectId: reservedProjectId,
      storagePath,
      token: data.token,
      enterprise: true,
      classification,
      accessScope,
    })
  } catch (error) {
    return apiError(error)
  }
}
