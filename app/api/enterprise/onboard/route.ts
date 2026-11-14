import { apiError, HttpError, requireUser } from "@/lib/auth"
import { isDemoDepartment, PENDING_DEMO_DEPARTMENT_COOKIE } from "@/lib/utils"

export async function POST(req: Request) {
  try {
    const { supabase } = await requireUser(req)
    const body = await req.json()
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "Invalid JSON payload.")
    }

    const payload = body as Record<string, unknown>
    if (
      (payload.role !== undefined && payload.role !== "employee") ||
      payload.is_active !== undefined ||
      payload.can_upload_policy !== undefined ||
      payload.grants !== undefined ||
      payload.project_memberships !== undefined
    ) {
      throw new HttpError(403, "Public signup only assigns the employee role.")
    }

    const department = typeof payload.department === "string" ? payload.department.trim() : ""
    if (!isDemoDepartment(department)) {
      throw new HttpError(400, "Please select a valid department.")
    }

    const { data, error } = await supabase
      .rpc("onboard_demo_employee", { target_department: department })
      .maybeSingle<{ organization_id: string; department_id: string; role: string }>()

    if (error) {
      if (error.code === "22023") {
        throw new HttpError(400, "Please select a valid department.")
      }
      if (error.code === "42501") {
        throw new HttpError(403, "Department assignment is one-time and cannot be modified.")
      }
      throw new HttpError(500, "Unable to complete employee onboarding.")
    }

    if (!data) {
      throw new HttpError(500, "Unable to complete employee onboarding.")
    }

    return Response.json(
      {
        organizationId: data.organization_id,
        departmentId: data.department_id,
        role: data.role,
      },
      {
        headers: {
          "Set-Cookie": `${PENDING_DEMO_DEPARTMENT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`,
        },
      },
    )
  } catch (error) {
    return apiError(error)
  }
}

