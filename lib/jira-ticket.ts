export const JIRA_SUMMARY_MAX = 255
export const JIRA_DESCRIPTION_MAX = 10_000
export const JIRA_DEMO_PROJECT_KEY = "ECD"
export const JIRA_ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/
export const JIRA_ALLOWED_ISSUE_KEY_PATTERN = /^ECD-[1-9]\d*$/

export interface JiraProjectOption {
  id: string
  key: string
  name: string
}

export interface JiraIssueTypeOption {
  id: string
  name: string
  subtask: boolean
}

export interface JiraAssigneeOption {
  id: string
  name: string
  active: boolean
}

export interface JiraPriorityOption {
  id: string
  name: string
  isDefault: boolean
}

export interface JiraFieldOptionsResponse {
  projects: JiraProjectOption[]
  issueTypes: JiraIssueTypeOption[]
  assignees: JiraAssigneeOption[]
  priorities: JiraPriorityOption[]
}

// Demo authorization allowlist: only these Jira projects may be queried or targeted.
export const ALLOWED_JIRA_PROJECTS: readonly JiraProjectOption[] = [
  { id: "10001", key: "ECD", name: "Employee Copilot Demo" },
  { id: "10000", key: "KAN", name: "Product Team" },
]

export const DEFAULT_JIRA_PROJECT_ID = "10001"

export function getAllowedJiraProject(projectId: unknown): JiraProjectOption | null {
  if (typeof projectId !== "string") return null
  const normalized = projectId.trim()
  return ALLOWED_JIRA_PROJECTS.find((project) => project.id === normalized) ?? null
}

export function draftJiraTicket(query: string) {
  // shortcut: recognizes explicit English requests, expand if employees need other phrasing.
  const command = /^(?:(?:hi|hey)[,!]?\s+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:create|open|file|raise|submit|log)\s+(?:(?:a|an|new|a new)\s+)?(?:jira\s+(?:ticket|issue|bug|task)|(?:ticket|issue|bug|task)\s+in\s+jira)\b/i
  const request = query.trim()
  const match = request.match(command)
  if (!match) return null

  const details = request.slice(match[0].length)
    .replace(/^\s*(?:for\b|about\b|to\b)?\s*[:–—-]?\s*/i, "")
    .replace(/^[.?!]+$/, "")
  return {
    summary: details.split(/\r?\n/, 1)[0].slice(0, JIRA_SUMMARY_MAX).trim(),
    description: details,
  }
}

const JIRA_STATUS_PATTERNS = [
  /^(?:(?:hi|hey)[,!]?\s+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:what(?:'s| is)\s+(?:the\s+)?status\s+(?:of|for)\s+(?:(?:jira\s+)?(?:ticket|issue)\s+)?)([a-z][a-z0-9_]*-[1-9]\d*)[?.!\s]*$/i,
  /^(?:(?:hi|hey)[,!]?\s+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:check|get|fetch|show|find|look\s*up)\s+(?:the\s+)?status\s+(?:of|for)\s+(?:(?:jira\s+)?(?:ticket|issue)\s+)?([a-z][a-z0-9_]*-[1-9]\d*)[?.!\s]*$/i,
  /^(?:(?:hi|hey)[,!]?\s+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?check\s+(?:(?:jira\s+)?(?:ticket|issue)\s+)?([a-z][a-z0-9_]*-[1-9]\d*)(?:\s+status)?[?.!\s]*$/i,
  /^(?:(?:hi|hey)[,!]?\s+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?track\s+(?:(?:jira\s+)?(?:ticket|issue)\s+)?([a-z][a-z0-9_]*-[1-9]\d*)(?:\s+status)?[?.!\s]*$/i,
  /^(?:status\s+(?:of|for)\s+(?:(?:jira\s+)?(?:ticket|issue)\s+)?)([a-z][a-z0-9_]*-[1-9]\d*)[?.!\s]*$/i,
  /^([a-z][a-z0-9_]*-[1-9]\d*)\s+status[?.!\s]*$/i,
]

export function extractJiraStatusIssueKey(query: string): string | null {
  if (draftJiraTicket(query)) return null
  const request = query.trim()
  for (const pattern of JIRA_STATUS_PATTERNS) {
    const match = request.match(pattern)
    if (match?.[1]) {
      return match[1].toUpperCase()
    }
  }
  return null
}
