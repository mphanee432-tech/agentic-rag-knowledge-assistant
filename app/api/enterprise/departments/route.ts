import { apiError, HttpError, requireUser } from "@/lib/auth"

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const organizationId = searchParams.get("organizationId")
    if (!organizationId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(organizationId)) {
      throw new HttpError(400, "A valid organization ID is required.")
    }

    const { supabase } = await requireUser(req, "enterprise")

    const { data: depts, error: deptsErr } = await supabase.rpc("enterprise_policy_departments", {
      target_organization_id: organizationId,
    })

    if (deptsErr) {
      console.error("Failed to load enterprise departments:", deptsErr)
      throw new HttpError(500, "Unable to load departments.")
    }

    return Response.json({ departments: depts || [] })
  } catch (error) {
    return apiError(error)
  }
}
