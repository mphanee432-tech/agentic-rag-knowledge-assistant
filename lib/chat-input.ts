export interface ChatMessageInput { role: "user" | "assistant"; content: string }
export const GREETING_RESPONSE = "Hello! How can I help you?"
export const IDENTITY_RESPONSE_WITH_JIRA =
  "I'm your Employee Knowledge Copilot. I help you find answers from company documents you're authorized to access, provide source citations, and help you create Jira tickets with your confirmation."
export const IDENTITY_RESPONSE_WITHOUT_JIRA =
  "I'm your Employee Knowledge Copilot. I help you find answers from company documents you're authorized to access, and provide source citations."
export const CAPABILITY_RESPONSE_WITH_JIRA =
  "I can answer questions and summarize company documents you have permission to access, provide source citations, and help you create Jira tickets with your confirmation. I won't disclose documents you're not authorized to view."
export const CAPABILITY_RESPONSE_WITHOUT_JIRA =
  "I can answer questions and summarize company documents you have permission to access, and provide source citations. I won't disclose documents you're not authorized to view."

const STANDALONE_GREETING_PATTERN = /^\s*[!.?,;:\s]*(?:hi|hello|hey|good\s+(?:morning|afternoon|evening))[!.?,;:\s]*$/i
const STANDALONE_IDENTITY_PATTERN = /^\s*[!.?,;:\s]*(?:who|what)\s+are\s+you[!.?,;:\s]*$/i
const STANDALONE_CAPABILITY_PATTERN = /^\s*[!.?,;:\s]*(?:what\s+can\s+you\s+do|how\s+can\s+you\s+help\s+me)[!.?,;:\s]*$/i

export function isStandaloneGreeting(query: string): boolean {
  return STANDALONE_GREETING_PATTERN.test(query)
}

export function isStandaloneIdentityQuestion(query: string): boolean {
  return STANDALONE_IDENTITY_PATTERN.test(query)
}

export function isStandaloneCapabilityQuestion(query: string): boolean {
  return STANDALONE_CAPABILITY_PATTERN.test(query)
}

// Match requests to exercise access administration, including polite imperatives.
export function requestsPermissionChange(query: string): boolean {
  const commands = query.toLowerCase().split(/[.!?;:\n]+|\b(?:and then|then)\s+/)
  const prefix = /^\s*(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+you\s+|i (?:want|need) you to\s+)*/
  const access = /^(?:grant|give|assign|enable|revoke|remove|set|change|modify|upgrade|elevate|escalate)\s+(?:(?:me|my account|the user|us)\s+)?(?:(?:my|our|the|read|write|full|administrative|admin|elevated|account|user)\s+)*(?:access|permissions?|privileges?|role)\b/
  const role = /^(?:make|promote|elevate|add|assign)\s+(?:me|my account|us)\s+(?:(?:to|as|the|an?|role|of|security)\s+)*(?:admin(?:istrator)?|owner|manager)\b/
  return commands.some(clause => {
    const command = clause.replace(prefix, "")
    return access.test(command) || role.test(command)
  })
}

export function eligibleConversation(query: string): DeterministicIntent | null {
  return getDeterministicIntent(query) ?? (
    /^(?:hi|hey|hello)(?: there)?(?:[,! ]+(?:nice|good) to (?:meet|see) you(?: today)?)?[.!?\s]*$/i.test(query.trim()) ? "greeting" : null
  )
}

export type DeterministicIntent = "greeting" | "identity" | "capability"

export function getDeterministicIntent(query: string): DeterministicIntent | null {
  if (STANDALONE_GREETING_PATTERN.test(query)) return "greeting"
  if (STANDALONE_IDENTITY_PATTERN.test(query)) return "identity"
  if (STANDALONE_CAPABILITY_PATTERN.test(query)) return "capability"
  return null
}

export function getDeterministicResponse(intent: DeterministicIntent, canCreateJira: boolean): string {
  switch (intent) {
    case "greeting":
      return GREETING_RESPONSE
    case "identity":
      return canCreateJira ? IDENTITY_RESPONSE_WITH_JIRA : IDENTITY_RESPONSE_WITHOUT_JIRA
    case "capability":
      return canCreateJira ? CAPABILITY_RESPONSE_WITH_JIRA : CAPABILITY_RESPONSE_WITHOUT_JIRA
  }
}
export function parseChatInput(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Invalid request.")
  const body = value as Record<string, unknown>
  const vars = body.vars && typeof body.vars === "object" ? body.vars as Record<string, unknown> : {}
  const projectId = body.projectId || vars.projectId || body.project_id || vars.project_id
  const organizationId = body.organizationId
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
  let scope: { projectId: string; organizationId: null } | { projectId: null; organizationId: string }
  if (organizationId === undefined) {
    if (typeof projectId !== "string" || !uuid.test(projectId)) throw new Error("A valid project ID is required.")
    scope = { projectId, organizationId: null }
  } else {
    if (projectId != null || typeof organizationId !== "string" || !uuid.test(organizationId)) {
      throw new Error("A valid organization ID without a project ID is required.")
    }
    scope = { projectId: null, organizationId }
  }
  const messages: ChatMessageInput[] = []
  for (const item of (Array.isArray(body.messages) ? body.messages.slice(-9) : [])) {
    if (!item || typeof item !== "object") continue
    const message = item as Record<string, unknown>
    if ((message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") continue
    if (message.content.trim()) messages.push({ role: message.role, content: message.content.trim().slice(0, 3000) })
  }
  const last = messages.at(-1)
  const query = body.query || vars.query || body.prompt || vars.prompt || body.message || (last?.role === "user" ? last.content : "")
  if (typeof query !== "string" || !query.trim() || query.trim().length > 2500) throw new Error("Query must contain 1–2,500 characters.")
  const userQuery = query.trim()
  if (last?.role !== "user" || last.content !== userQuery) messages.push({ role: "user", content: userQuery })
  const variant = body.promptVariant || vars.promptVariant
  const rawLastJiraKey = typeof body.lastJiraTicketKey === "string" ? body.lastJiraTicketKey.trim().toUpperCase() : ""
  const lastJiraTicketKey = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/.test(rawLastJiraKey) ? rawLastJiraKey : null
  return { ...scope, userQuery, boundedHistory: messages.slice(-10),
    lastJiraTicketKey,
    promptVariant: typeof variant === "string" ? variant : "strict",
    isEvalMode: body.stream === false || body.stream === "false",
    wantsStream: body.stream === true || body.stream === "true" }
}

