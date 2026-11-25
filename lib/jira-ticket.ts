export const JIRA_SUMMARY_MAX = 255
export const JIRA_DESCRIPTION_MAX = 10_000
export const JIRA_DEMO_PROJECT_KEY = "ECD"
export const JIRA_ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/
const JIRA_LAST_TICKET_STORAGE_PREFIX = "jira:last-ticket:"

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

export interface JiraStatusResult {
  ticketKey: string
  status: string
  summary: string
}

// Demo authorization allowlist: only these Jira projects may be queried or targeted.
export const ALLOWED_JIRA_PROJECTS: readonly JiraProjectOption[] = [
  { id: "10001", key: "ECD", name: "Employee Copilot Demo" },
  { id: "10000", key: "KAN", name: "Product Team" },
]

export const DEFAULT_JIRA_PROJECT_ID = "10001"

const JIRA_EXAMPLE_ISSUE_NUMBERS: Readonly<Record<string, number>> = { ECD: 6 }

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function formatKeyList(items: readonly string[], conjunction: "and" | "or"): string {
  if (items.length === 0) return ""
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`
  return `${items.slice(0, -1).join(", ")}, ${conjunction} ${items[items.length - 1]}`
}

export const ALLOWED_JIRA_PROJECT_KEYS: readonly string[] = ALLOWED_JIRA_PROJECTS.map((project) => project.key)

export const ALLOWED_JIRA_PROJECT_KEYS_LABEL = formatKeyList(ALLOWED_JIRA_PROJECT_KEYS, "and")

export const JIRA_ALLOWED_ISSUE_KEY_PATTERN = new RegExp(
  `^(?:${ALLOWED_JIRA_PROJECT_KEYS.map(escapeRegex).join("|")})-[1-9]\\d*$`,
)

export const JIRA_STATUS_CLARIFICATION_PROMPT = `Please share the Jira ticket ID (for example, ${formatKeyList(
  ALLOWED_JIRA_PROJECT_KEYS.map((key) => `${key}-${JIRA_EXAMPLE_ISSUE_NUMBERS[key] ?? 1}`),
  "or",
)}) so I can check its status.`

export function getAllowedJiraProject(projectId: unknown): JiraProjectOption | null {
  if (typeof projectId !== "string") return null
  const normalized = projectId.trim()
  return ALLOWED_JIRA_PROJECTS.find((project) => project.id === normalized) ?? null
}

export function formatJiraStatusMessage(result: JiraStatusResult): string {
  return `**${result.ticketKey} — ${result.status}**\n\nSummary: ${result.summary}`
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

const STATUS_GREETING_PREFIX =
  "(?:(?:hi|hello|hey)[,!]?\\s+)?(?:(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?)?(?:please\\s+)?"
const TELL_ME_PREFIX = "(?:(?:tell\\s+me|let\\s+me\\s+know)\\s+)?"
const STATUS_ADJECTIVE_PHRASE = "(?:the\\s+)?(?:(?:current|latest|updated)\\s+)?status"
const TICKET_REF_PREFIX = "(?:(?:the|my|this|that)\\s+)?(?:(?:jira\\s+)?(?:ticket|issue)\\s+)?"
const JIRA_KEY_CAPTURE = "([a-z][a-z0-9_]*-[1-9]\\d*)"
const STATUS_TRAILING_MODIFIER = "(?:\\s+(?:right\\s+now|now|currently|today|please))*"

const JIRA_STATUS_PATTERNS = [
  new RegExp(
    `^${STATUS_GREETING_PREFIX}${TELL_ME_PREFIX}(?:what(?:'s| is)\\s+${STATUS_ADJECTIVE_PHRASE}\\s+(?:of|for)\\s+${TICKET_REF_PREFIX}|what\\s+${STATUS_ADJECTIVE_PHRASE}\\s+is\\s+${TICKET_REF_PREFIX})${JIRA_KEY_CAPTURE}${STATUS_TRAILING_MODIFIER}[?.!\\s]*$`,
    "i",
  ),
  new RegExp(
    `^${STATUS_GREETING_PREFIX}${TELL_ME_PREFIX}(?:what(?:'s| is)\\s+)${TICKET_REF_PREFIX}${JIRA_KEY_CAPTURE}(?:'s)?\\s+${STATUS_ADJECTIVE_PHRASE}${STATUS_TRAILING_MODIFIER}[?.!\\s]*$`,
    "i",
  ),
  new RegExp(
    `^${STATUS_GREETING_PREFIX}(?:check|get|fetch|show(?:\\s+me)?|give\\s+me|tell\\s+me|find|look\\s*up|track)\\s+${STATUS_ADJECTIVE_PHRASE}\\s+(?:of|for)\\s+${TICKET_REF_PREFIX}${JIRA_KEY_CAPTURE}${STATUS_TRAILING_MODIFIER}[?.!\\s]*$`,
    "i",
  ),
  new RegExp(
    `^${STATUS_GREETING_PREFIX}(?:check|track)\\s+${TICKET_REF_PREFIX}${JIRA_KEY_CAPTURE}(?:\\s+(?:(?:current|latest|updated)\\s+)?status)?${STATUS_TRAILING_MODIFIER}[?.!\\s]*$`,
    "i",
  ),
  new RegExp(
    `^${STATUS_GREETING_PREFIX}(?:get|fetch|show(?:\\s+me)?|look\\s*up)\\s+${TICKET_REF_PREFIX}${JIRA_KEY_CAPTURE}(?:'s)?\\s+(?:(?:current|latest|updated)\\s+)?status${STATUS_TRAILING_MODIFIER}[?.!\\s]*$`,
    "i",
  ),
  new RegExp(
    `^${STATUS_ADJECTIVE_PHRASE}\\s+(?:of|for)\\s+${TICKET_REF_PREFIX}${JIRA_KEY_CAPTURE}${STATUS_TRAILING_MODIFIER}[?.!\\s]*$`,
    "i",
  ),
  new RegExp(
    `^${TICKET_REF_PREFIX}${JIRA_KEY_CAPTURE}(?:'s)?\\s+(?:(?:current|latest|updated)\\s+)?status${STATUS_TRAILING_MODIFIER}[?.!\\s]*$`,
    "i",
  ),
]

const IMPLICIT_TICKET_NOUN =
  "(?:(?:this|that|the|my)\\s+(?:(?:newly\\s+)?created\\s+|last\\s+|recent\\s+)?(?:jira\\s+)?(?:ticket|issue)(?:\\s+(?:i\\s+(?:just\\s+)?created|we\\s+(?:just\\s+)?created|just\\s+created))?|it)"

const KEYLESS_JIRA_STATUS_PATTERNS = [
  new RegExp(
    `^${STATUS_GREETING_PREFIX}${TELL_ME_PREFIX}what(?:'s| is)\\s+(?:(?:the|its)\\s+)?(?:(?:current|latest|updated)\\s+)?status(?:\\s+(?:of|for)\\s+${IMPLICIT_TICKET_NOUN})?${STATUS_TRAILING_MODIFIER}[?.!\\s]*$`,
    "i",
  ),
  new RegExp(
    `^${STATUS_GREETING_PREFIX}(?:check|get|fetch|show(?:\\s+me)?|give\\s+me|tell\\s+me|find|look\\s*up|track)\\s+(?:(?:the|its)\\s+)?(?:(?:current|latest|updated)\\s+)?status(?:\\s+(?:of|for)\\s+${IMPLICIT_TICKET_NOUN})?${STATUS_TRAILING_MODIFIER}[?.!\\s]*$`,
    "i",
  ),
  new RegExp(
    `^${STATUS_GREETING_PREFIX}(?:check|track)\\s+${IMPLICIT_TICKET_NOUN}(?:\\s+(?:(?:current|latest|updated)\\s+)?status)?${STATUS_TRAILING_MODIFIER}[?.!\\s]*$`,
    "i",
  ),
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

export function isKeylessJiraStatusQuery(query: string): boolean {
  if (draftJiraTicket(query)) return false
  const request = query.trim()
  if (!request) return false
  if (/\b(?:how\s+(?:do|to|can|should)|policy|policies|workflow|guideline|sop|handbook)\b/i.test(request)) {
    return false
  }
  return KEYLESS_JIRA_STATUS_PATTERNS.some((pattern) => pattern.test(request))
}

export function extractLatestJiraTicketKeyFromMessages(
  messages: ReadonlyArray<{ role: string; content: string }>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    const createdMatch = msg.content.match(/Created Jira ticket \*\*([A-Z][A-Z0-9_]*-[1-9]\d*)\*\*\./)
    if (createdMatch?.[1]) return createdMatch[1]
    const statusMatch = msg.content.match(/^\*\*([A-Z][A-Z0-9_]*-[1-9]\d*) — /)
    if (statusMatch?.[1]) return statusMatch[1]
  }
  return null
}

function lastJiraTicketStorageKey(accountId: string | null | undefined, organizationId: string | null | undefined): string | null {
  if (!accountId || !organizationId) return null
  return `${JIRA_LAST_TICKET_STORAGE_PREFIX}${accountId}:${organizationId}`
}

export function readLastJiraTicketKey(
  accountId: string | null | undefined,
  organizationId: string | null | undefined,
): string | null {
  if (typeof window === "undefined") return null
  const key = lastJiraTicketStorageKey(accountId, organizationId)
  if (!key) return null
  try {
    const value = window.sessionStorage.getItem(key)?.trim().toUpperCase() ?? ""
    return JIRA_ISSUE_KEY_PATTERN.test(value) ? value : null
  } catch {
    return null
  }
}

export function writeLastJiraTicketKey(
  accountId: string | null | undefined,
  organizationId: string | null | undefined,
  ticketKey: string | null,
): void {
  if (typeof window === "undefined") return
  const key = lastJiraTicketStorageKey(accountId, organizationId)
  if (!key) return
  try {
    if (!ticketKey) {
      window.sessionStorage.removeItem(key)
      return
    }
    const normalized = ticketKey.trim().toUpperCase()
    if (JIRA_ISSUE_KEY_PATTERN.test(normalized)) {
      window.sessionStorage.setItem(key, normalized)
    }
  } catch {
    // Ignore storage unavailability
  }
}

export function clearAllLastJiraTicketKeys(): void {
  if (typeof window === "undefined") return
  try {
    const keys: string[] = []
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const storageKey = window.sessionStorage.key(i)
      if (storageKey?.startsWith(JIRA_LAST_TICKET_STORAGE_PREFIX)) {
        keys.push(storageKey)
      }
    }
    for (const storageKey of keys) {
      window.sessionStorage.removeItem(storageKey)
    }
  } catch {
    // Ignore storage unavailability
  }
}
