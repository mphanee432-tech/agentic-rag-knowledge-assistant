import { apiError, HttpError, requireUser } from "@/lib/auth"

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const projectId = searchParams.get("projectId")
    if (!projectId || !/^[0-9a-f-]{36}$/i.test(projectId)) {
      throw new HttpError(400, "A valid project ID is required.")
    }

    const auth = await requireUser(req, "enterprise")
    const { data: canUpload, error } = await auth.supabase.rpc("can_upload_enterprise_policy", {
      p_project_id: projectId,
    })

    if (error) {
      console.error("can_upload_enterprise_policy check error:", error)
      return Response.json({ canUpload: false })
    }

    return Response.json({ canUpload: Boolean(canUpload) })
  } catch (error) {
    return apiError(error)
  }
}

