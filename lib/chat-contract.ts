import { validCitations } from "./citations"
export { citationIndices, validCitations } from "./citations"

export const NO_EVIDENCE = "I don't know."
export const ENTERPRISE_NO_EVIDENCE = "I don't know based on the documents I can access."
export const MAX_ANSWER_CHARS = 4000

export function isNoEvidenceAnswer(text: string): boolean {
  const normalized = text.trim()
  return normalized === NO_EVIDENCE || normalized === ENTERPRISE_NO_EVIDENCE
}
export interface StreamCitation {
  id: string
  index: number
  content: string
  metadata?: Record<string, unknown>
}
export type AgentStepPhase =
  | "tool_selected"
  | "retrieval_attempt_1_started"
  | "retrieval_attempt_1_completed"
  | "evidence_decision_1"
  | "retrieval_attempt_2_started"
  | "retrieval_attempt_2_completed"
  | "evidence_decision_2"
  | "final_decision"

export interface AgentStepEventData {
  phase: AgentStepPhase
  decisionMode?: "llm" | "deterministic"
  tool?: "deterministic_reply" | "jira_status" | "jira_status_clarification" | "jira_create_draft" | "jira_create_denied" | "rag_retrieval"
  authorizedChunks?: number
  mergedAuthorizedChunks?: number
  decision?: "answer" | "retry_retrieval" | "clarify" | "abstain"
  outcome?: "answer" | "retry_retrieval" | "clarify" | "abstain" | "tool_executed" | "confirmation_required"
  steps?: number
  maxSteps?: number
}

export type ChatEvent =
  | { type: "agent_step"; step: AgentStepEventData }
  | { type: "metadata"; interactionId?: string; citations: StreamCitation[] }
  | { type: "jira_draft"; draft: { summary: string; description: string } }
  | { type: "text"; text: string }
  | { type: "finish"; metrics: Record<string, unknown>; context?: string; fallbackQuestions?: string[] }
  | { type: "error"; message: string }

export function encodeEvent(event: ChatEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
}

// Both chat entry points use the same parser. Metadata never enters answer text.
export async function readChatStream(response: Response, onEvent: (event: ChatEvent) => void) {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Unsupported chat response.")
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Response body is not readable.")
  const decoder = new TextDecoder()
  let buffer = ""
  let finished = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let boundary: number
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        if (!frame.startsWith("data: ")) continue
        if (finished) throw new Error("The answer stream continued after completion.")
        const event = JSON.parse(frame.slice(6)) as ChatEvent
        if (event.type === "error") throw new Error(event.message)
        if (event.type === "finish") finished = true
        onEvent(event)
      }
      if (done) break
    }
    if (!finished || buffer.trim()) throw new Error("The answer stream ended unexpectedly. Please retry.")
  } finally { reader.releaseLock() }
}
export function assertValidAnswer(text: string, citations: StreamCitation[], finishReason: string) {
  if (finishReason !== "stop") throw new Error("Generation did not complete.")
  if (!text.trim() || text.length > MAX_ANSWER_CHARS) throw new Error("Answer is empty or exceeds the length limit.")
  if (!isNoEvidenceAnswer(text) && !validCitations(text, citations)) {
    throw new Error("Answer contains missing or invalid citations.")
  }
}

