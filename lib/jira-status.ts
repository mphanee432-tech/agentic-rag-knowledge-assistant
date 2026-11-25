import { getEnterpriseCopilotContext, HttpError } from "@/lib/auth"
import {
  ALLOWED_JIRA_PROJECT_KEYS_LABEL,
  JIRA_ALLOWED_ISSUE_KEY_PATTERN,
  JIRA_ISSUE_KEY_PATTERN,
  type JiraStatusResult,
} from "@/lib/jira-ticket"
import type { createClient } from "@/lib/supabase/server"

type SupabaseClient = Awaited<ReturnType<typeof createClient>>

/**
 * Shared read-only Jira issue status lookup enforcing active organization membership,
 * the ALLOWED_JIRA_PROJECTS allowlist, and verified Activepieces webhook response shape.
 */
export async function lookupEnterpriseJiraStatus(params: {
  supabase: SupabaseClient
  organizationId: unknown
  issueKey: unknown
}): Promise<JiraStatusResult> {
  const organizationId = params.organizationId
  const issueKey = typeof params.issueKey === "string" ? params.issueKey.trim().toUpperCase() : ""

  if (typeof organizationId !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(organizationId)) {
    throw new HttpError(400, "A valid organization ID is required.")
  }
  if (!JIRA_ISSUE_KEY_PATTERN.test(issueKey)) {
    throw new HttpError(400, "Enter a valid Jira issue key such as ECD-6.")
  }
  if (!(await getEnterpriseCopilotContext(params.supabase, organizationId))) {
    throw new HttpError(403, "Active membership in this organization is required.")
  }
  if (!JIRA_ALLOWED_ISSUE_KEY_PATTERN.test(issueKey)) {
    throw new HttpError(403, `Only ${ALLOWED_JIRA_PROJECT_KEYS_LABEL} project Jira tickets are accessible in this demo.`)
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

  return {
    ticketKey: returnedKey,
    status,
    summary,
  }
}
