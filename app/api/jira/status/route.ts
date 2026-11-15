import { apiError, getEnterpriseCopilotContext, HttpError, requireUser } from "@/lib/auth"
import {
  JIRA_ALLOWED_ISSUE_KEY_PATTERN,
  JIRA_DEMO_PROJECT_KEY,
  JIRA_ISSUE_KEY_PATTERN,
} from "@/lib/jira-ticket"

/**
 * MVP demo authorization boundary:
 * Verifies Supabase user session, active enterprise organization membership via
 * `enterprise_copilot_context`, and restricts lookups to the `ECD` demo Jira project.
 * Document RLS does not secure external Jira issues.
 */
export async function POST(req: Request) {
  try {
    const { supabase } = await requireUser(req)
    if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw new HttpError(415, "Send status lookup details as JSON.")
    }

    const rawBody = await req.text()
    if (rawBody.length > 10_000) throw new HttpError(413, "Status lookup request is too large.")
    const body = JSON.parse(rawBody)
    const organizationId = body?.organizationId
    const issueKey = typeof body?.issueKey === "string" ? body.issueKey.trim().toUpperCase() : ""

    if (typeof organizationId !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(organizationId)) {
      throw new HttpError(400, "A valid organization ID is required.")
    }
    if (!JIRA_ISSUE_KEY_PATTERN.test(issueKey)) {
      throw new HttpError(400, "Enter a valid Jira issue key such as ECD-6.")
    }
    if (!(await getEnterpriseCopilotContext(supabase, organizationId))) {
      throw new HttpError(403, "Active membership in this organization is required.")
    }
    if (!JIRA_ALLOWED_ISSUE_KEY_PATTERN.test(issueKey)) {
      throw new HttpError(403, `Only ${JIRA_DEMO_PROJECT_KEY} project Jira tickets are accessible in this demo.`)
    }

    const configuredUrl = process.env.ACTIVEPIECES_JIRA_STATUS_WEBHOOK_URL?.trim() ?? ""
    const webhook = URL.canParse(configuredUrl) ? new URL(configuredUrl) : null
    if (!webhook || webhook.protocol !== "https:" || webhook.username || webhook.password) {
      throw new HttpError(503, "Jira ticket status lookup is unavailable. Contact your administrator.")
    }
    webhook.pathname = webhook.pathname.replace(/\/+$/, "").replace(/(?:\/sync)?$/, "/sync")

    let response: Response
    try {
      response = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueKey }),
        redirect: "error",
        signal: AbortSignal.timeout(35_000),
      })
    } catch {
      throw new HttpError(502, "Unable to reach Jira status service. Please try again.")
    }

    if (response.status === 404) {
      throw new HttpError(404, `Jira ticket ${issueKey} was not found or is inaccessible.`)
    }
    if (!response.ok) {
      throw new HttpError(502, "Unable to retrieve Jira ticket status right now. Please try again.")
    }

    let result: unknown
    try {
      result = await response.json()
    } catch {
      throw new HttpError(502, "Received an invalid response from Jira status service.")
    }

    const record = result && typeof result === "object" ? (result as Record<string, unknown>) : null
    const returnedKey = typeof record?.ticketKey === "string" ? record.ticketKey.trim().toUpperCase() : ""
    const status = typeof record?.status === "string" ? record.status.trim() : ""
    const summary = typeof record?.summary === "string" ? record.summary.trim() : ""

    if (record?.success !== true || returnedKey !== issueKey || !status || !summary) {
      throw new HttpError(502, "Unable to verify Jira ticket status. Please try again.")
    }

    return Response.json({
      ticketKey: returnedKey,
      status,
      summary,
    })
  } catch (error) {
    return apiError(error)
  }
}

