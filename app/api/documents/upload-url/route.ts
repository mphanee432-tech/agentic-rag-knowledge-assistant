import { apiError, HttpError, requireProject } from "@/lib/auth"
import { createAdminClient } from "@/lib/supabase/admin"
export async function POST(req: Request) {
  try {
    const { projectId, filename, fileSize } = await req.json()
    const { project, user } = await requireProject(projectId, req)
    if (typeof filename !== "string" || !/\.(pdf|txt|html)$/i.test(filename) || filename.length > 200 ||
        !Number.isInteger(fileSize) || fileSize <= 0 || fileSize > 25 * 1024 * 1024) {
      throw new HttpError(400, "Upload a PDF, TXT, or HTML file between 1 byte and 25 MB.")
    }
    const admin = createAdminClient()
    const documentId = crypto.randomUUID()
    const storagePath = `${user.id}/${project.id}/${documentId}/${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`
    const { error } = await admin.from("documents").insert({ id: documentId, project_id: project.id,
      storage_path: storagePath, status: "pending_upload", expected_size: fileSize })
    if (error) {
      if (error.message.includes("document limit")) throw new HttpError(409, "Project document limit reached (10).")
      throw error
    }
    const { data, error: uploadError } = await admin.storage.from("documents").createSignedUploadUrl(storagePath)
    if (uploadError || !data) {
      await admin.from("documents").update({ status: "failed" }).eq("id", documentId)
      throw new HttpError(503, "Unable to start upload. Please retry.")
    }
    return Response.json({ documentId, storagePath, token: data.token })
  } catch (error) { return apiError(error) }
}
