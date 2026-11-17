import { apiError, HttpError, requireJiraAccess, requireUser } from "@/lib/auth"
import { fetchLiveJiraOptions } from "@/lib/jira-options"
import { DEFAULT_JIRA_PROJECT_ID } from "@/lib/jira-ticket"

/**
 * MVP demo authorization boundary:
 * Authenticates the Supabase user, verifies active enterprise organization membership
 * or demo Jira opt-in, and delegates to `fetchLiveJiraOptions` which enforces the demo project allowlist.
 */
export async function POST(req: Request) {
  try {
    const { supabase } = await requireUser(req, "enterprise")
    if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw new HttpError(415, "Send Jira options request as JSON.")
    }

    const rawBody = await req.text()
    if (rawBody.length > 10_000) throw new HttpError(413, "Jira options request is too large.")
    const body = JSON.parse(rawBody)
    await requireJiraAccess(supabase, body?.organizationId)

    const projectId = body?.projectId === undefined ? DEFAULT_JIRA_PROJECT_ID : body.projectId
    const options = await fetchLiveJiraOptions(projectId)
    return Response.json(options)
  } catch (error) {
    return apiError(error)
  }
}

