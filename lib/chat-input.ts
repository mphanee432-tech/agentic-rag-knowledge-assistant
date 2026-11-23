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

export const AMBIGUOUS_CONFIDENTIAL_HR_CLARIFICATION =
  "Which specific confidential HR document or policy ID do you mean? I can explain only information in documents you are authorized to access."

/**
 * Ask for a document identity before searching for the CONTENTS of an unnamed
 * confidential HR document. This is a narrow ambiguity guard, not an access
 * decision: named documents and questions about access rules must still go
 * through normal user-scoped RAG and PostgreSQL RLS.
 */
export function isAmbiguousConfidentialHrDocumentRequest(query: string): boolean {
  const q = query.toLowerCase().replace(/\s+/g, " ").trim()
  if (!/\b(?:confidential|restricted|private|sensitive)\b/.test(q)) return false
  if (!/\b(?:hr|human resources)\b/.test(q)) return false
  if (!/\b(?:documents?|files?|records?)\b/.test(q)) return false
  if (/\bd\d{2}\b/i.test(q) || /\b(?:compensation|payroll|recruitment|onboarding|leave|attendance|benefits|employee handbook)\b/.test(q)) return false
  if (/\b(?:access|permission|authorization|authorisation|approval|approved|classification|classified|rules|procedure|request|handling|how to|who can)\b/.test(q)) return false
  return /\b(?:tell me about|explain(?: to me)?(?: about)?|describe|summari[sz]e|overview of|what(?:'s| is) in)\b/.test(q)
}

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

export type DeterministicIntent = "greeting" | "identity" | "capability" | "sensitive_document_clarification"

export function getDeterministicIntent(query: string, isEnterprise = false): DeterministicIntent | null {
  if (isEnterprise && isAmbiguousConfidentialHrDocumentRequest(query)) return "sensitive_document_clarification"
  if (STANDALONE_GREETING_PATTERN.test(query)) return "greeting"
  if (STANDALONE_IDENTITY_PATTERN.test(query)) return "identity"
  if (STANDALONE_CAPABILITY_PATTERN.test(query)) return "capability"
  return null
}

export function getDeterministicResponse(intent: DeterministicIntent, canCreateJira: boolean): string {
  switch (intent) {
    case "greeting":
      return GREETING_RESPONSE
    case "sensitive_document_clarification":
      return AMBIGUOUS_CONFIDENTIAL_HR_CLARIFICATION
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

