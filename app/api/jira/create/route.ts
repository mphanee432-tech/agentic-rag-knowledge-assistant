import { apiError, HttpError, requireJiraAccess, requireUser } from "@/lib/auth"
import { fetchLiveJiraOptions } from "@/lib/jira-options"
import {
  getAllowedJiraProject,
  JIRA_DESCRIPTION_MAX,
  JIRA_SUMMARY_MAX,
} from "@/lib/jira-ticket"

export async function POST(req: Request) {
  try {
    const { supabase } = await requireUser(req, "enterprise")
    if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw new HttpError(415, "Send ticket details as JSON.")
    }

    const rawBody = await req.text()
    if (rawBody.length > 65_000) throw new HttpError(413, "Ticket request is too large.")
    const body = JSON.parse(rawBody)
    const organizationId = body?.organizationId
    const summary = typeof body?.summary === "string" ? body.summary.trim() : ""
    const description = typeof body?.description === "string" ? body.description.trim() : ""
    const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : ""
    const rawIssueTypeId = body?.issueTypeId
    const assigneeId = typeof body?.assigneeId === "string" ? body.assigneeId.trim() : ""
    const priorityId = typeof body?.priorityId === "string" ? body.priorityId.trim() : ""
    if (!summary || summary.length > JIRA_SUMMARY_MAX || /[\r\n]/.test(summary)) {
      throw new HttpError(400, `Enter a single-line summary of up to ${JIRA_SUMMARY_MAX} characters.`)
    }
    if (!description || description.length > JIRA_DESCRIPTION_MAX) {
      throw new HttpError(400, `Enter a description of up to ${JIRA_DESCRIPTION_MAX.toLocaleString("en-US")} characters.`)
    }
    if (!/^\d+$/.test(projectId)) {
      throw new HttpError(400, "Select a supported Jira project.")
    }
    await requireJiraAccess(supabase, organizationId)
    if (!getAllowedJiraProject(projectId)) {
      throw new HttpError(403, "Selected Jira project is not authorized.")
    }

    const liveOptions = await fetchLiveJiraOptions(projectId)
    const issueTypeId = rawIssueTypeId === undefined
      ? liveOptions.issueTypes.find((option) => option.name.toLowerCase() === "task")?.id ??
      liveOptions.issueTypes[0]?.id ??
      ""
      : typeof rawIssueTypeId === "string"
        ? rawIssueTypeId.trim()
        : ""

    if (!issueTypeId || !liveOptions.issueTypes.some((option) => option.id === issueTypeId)) {
      throw new HttpError(400, "Select a supported Jira issue type for this project.")
    }
    if (!assigneeId || !liveOptions.assignees.some((option) => option.id === assigneeId)) {
      throw new HttpError(400, "Select a supported Jira assignee.")
    }
    if (!priorityId || !liveOptions.priorities.some((option) => option.id === priorityId)) {
      throw new HttpError(400, "Select a supported Jira priority.")
    }

    const configuredUrl = process.env.ACTIVEPIECES_JIRA_WEBHOOK_URL?.trim() ?? ""
    const webhook = URL.canParse(configuredUrl) ? new URL(configuredUrl) : null
    if (!webhook || webhook.protocol !== "https:" || webhook.username || webhook.password) {
      throw new HttpError(503, "Jira ticket creation is unavailable. Contact your administrator.")
    }
    webhook.pathname = webhook.pathname.replace(/\/+$/, "").replace(/(?:\/sync)?$/, "/sync")

    try {
      const response = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, issueTypeId, assigneeId, priorityId, summary, description }),
        redirect: "error",
        signal: AbortSignal.timeout(35_000),
      })
      if (!response.ok) throw new Error("Webhook failed")
      const result = await response.json()
      if (result?.success !== true || typeof result.ticketKey !== "string"
        || !/^[A-Z][A-Z0-9_]*-[1-9]\d*$/.test(result.ticketKey)) {
        throw new Error("Invalid webhook response")
      }
      return Response.json({ ticketKey: result.ticketKey })
    } catch {
      throw new HttpError(502, "Activepieces did not confirm ticket creation. Check Jira before trying again.")
    }
  } catch (error) {
    return apiError(error)
  }
}
