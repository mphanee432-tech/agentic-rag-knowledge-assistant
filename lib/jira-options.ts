import { HttpError } from "@/lib/auth"
import {
  ALLOWED_JIRA_PROJECTS,
  getAllowedJiraProject,
  type JiraAssigneeOption,
  type JiraFieldOptionsResponse,
  type JiraIssueTypeOption,
  type JiraPriorityOption,
  type JiraProjectOption,
} from "@/lib/jira-ticket"

const SUPPORTED_ISSUE_TYPE_NAMES = new Set(["task", "bug", "story", "feature"])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeProjects(rawProjects: unknown[]): JiraProjectOption[] {
  const allowedById = new Map(ALLOWED_JIRA_PROJECTS.map((project) => [project.id, project]))
  const seen = new Set<string>()
  const result: JiraProjectOption[] = []

  for (const item of rawProjects) {
    const record = asRecord(item)
    if (!record) continue
    const id = asNonEmptyString(record.id)
    const allowed = allowedById.get(id)
    if (!allowed || seen.has(id)) continue
    const key = asNonEmptyString(record.key).toUpperCase()
    if (key && key !== allowed.key) continue
    const name = asNonEmptyString(record.name) || allowed.name
    seen.add(id)
    result.push({ id: allowed.id, key: allowed.key, name })
  }

  return result
}

function normalizeIssueTypes(rawIssueTypes: unknown[]): JiraIssueTypeOption[] {
  const seen = new Set<string>()
  const result: JiraIssueTypeOption[] = []

  for (const item of rawIssueTypes) {
    const record = asRecord(item)
    if (!record) continue
    const id = asNonEmptyString(record.id)
    const name = asNonEmptyString(record.name)
    const subtask = Boolean(record.subtask)
    const hierarchyLevel = typeof record.hierarchyLevel === "number" ? record.hierarchyLevel : 0
    if (!id || !name || seen.has(id)) continue
    // Exclude Subtasks and Epics until parent-issue / Epic-required fields are supported.
    if (subtask || hierarchyLevel === 1 || !SUPPORTED_ISSUE_TYPE_NAMES.has(name.toLowerCase())) {
      continue
    }
    seen.add(id)
    result.push({ id, name, subtask: false })
  }

  return result
}

function normalizeAssignees(rawAssignees: unknown[]): JiraAssigneeOption[] {
  const seen = new Set<string>()
  const result: JiraAssigneeOption[] = []

  for (const item of rawAssignees) {
    const record = asRecord(item)
    if (!record) continue
    const active = record.active !== false
    if (!active) continue
    const id = asNonEmptyString(record.accountId) || asNonEmptyString(record.id)
    const name = asNonEmptyString(record.displayName) || asNonEmptyString(record.name)
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    result.push({ id, name, active: true })
  }

  return result
}

function normalizePriorities(rawPriorities: unknown[]): JiraPriorityOption[] {
  const seen = new Set<string>()
  const result: JiraPriorityOption[] = []

  for (const item of rawPriorities) {
    const record = asRecord(item)
    if (!record) continue
    const id = asNonEmptyString(record.id)
    const name = asNonEmptyString(record.name)
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    result.push({ id, name, isDefault: Boolean(record.isDefault) })
  }

  return result
}

/**
 * Fetches and normalizes live Jira field options for an allowlisted demo project.
 * The project allowlist is an MVP authorization boundary; newly discovered Jira
 * projects are never automatically authorized.
 */
export async function fetchLiveJiraOptions(projectId: unknown): Promise<JiraFieldOptionsResponse> {
  if (typeof projectId !== "string" || !/^\d+$/.test(projectId.trim())) {
    throw new HttpError(400, "A valid Jira project ID is required.")
  }

  const project = getAllowedJiraProject(projectId)
  if (!project) {
    throw new HttpError(403, "Selected Jira project is not authorized.")
  }

  const configuredUrl = process.env.ACTIVEPIECES_JIRA_OPTIONS_WEBHOOK_URL?.trim() ?? ""
  const webhook = URL.canParse(configuredUrl) ? new URL(configuredUrl) : null
  if (!webhook || webhook.protocol !== "https:" || webhook.username || webhook.password) {
    throw new HttpError(503, "Jira field options are unavailable. Contact your administrator.")
  }
  webhook.pathname = webhook.pathname.replace(/\/+$/, "").replace(/(?:\/sync)?$/, "/sync")

  let response: Response
  try {
    response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id, projectKey: project.key }),
      redirect: "error",
      signal: AbortSignal.timeout(35_000),
    })
  } catch {
    throw new HttpError(502, "Unable to reach Jira field options service. Please try again.")
  }

  if (!response.ok) {
    throw new HttpError(502, "Unable to load Jira field options right now. Please try again.")
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new HttpError(502, "Received an invalid response from Jira field options service.")
  }

  const record = asRecord(payload)
  if (
    !record ||
    !Array.isArray(record.projects) ||
    !Array.isArray(record.issueTypes) ||
    !Array.isArray(record.assignees) ||
    !Array.isArray(record.priorities)
  ) {
    throw new HttpError(502, "Received an incomplete response from Jira field options service.")
  }

  return {
    projects: normalizeProjects(record.projects),
    issueTypes: normalizeIssueTypes(record.issueTypes),
    assignees: normalizeAssignees(record.assignees),
    priorities: normalizePriorities(record.priorities),
  }
}

