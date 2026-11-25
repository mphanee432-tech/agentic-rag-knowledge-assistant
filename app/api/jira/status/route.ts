import { apiError, HttpError, requireUser } from "@/lib/auth"
import { lookupEnterpriseJiraStatus } from "@/lib/jira-status"

/**
 * MVP demo authorization boundary:
 * Verifies Supabase user session, active enterprise organization membership via
 * `enterprise_copilot_context`, and restricts lookups to `ALLOWED_JIRA_PROJECTS` (`ECD` and `KAN`).
 * Document RLS does not secure external Jira issues.
 */
export async function POST(req: Request) {
  try {
    const { supabase } = await requireUser(req, "enterprise")
    if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw new HttpError(415, "Send status lookup details as JSON.")
    }

    const rawBody = await req.text()
    if (rawBody.length > 10_000) throw new HttpError(413, "Status lookup request is too large.")
    const body = JSON.parse(rawBody)

    const result = await lookupEnterpriseJiraStatus({
      supabase,
      organizationId: body?.organizationId,
      issueKey: body?.issueKey,
    })

    return Response.json(result)
  } catch (error) {
    return apiError(error)
  }
}
