"use client"
import type { AgentTool, EvidenceAction } from "@/lib/agent-loop"
import {
  ENTERPRISE_NO_EVIDENCE,
  readChatStream,
  type AgentStepEventData,
} from "@/lib/chat-contract"
import {
  useChatStore,
  type AgentActivity,
  type Citation,
  type LiveAgentRetrievalStep,
} from "@/lib/store/chat-store"

const VALID_TOOLS = new Set<AgentTool>([
  "deterministic_reply",
  "jira_status",
  "jira_status_clarification",
  "jira_create_draft",
  "rag_retrieval",
])
const VALID_EVIDENCE_ACTIONS = new Set<EvidenceAction>(["answer", "retry_retrieval", "clarify", "abstain"])
const VALID_OUTCOMES = new Set<NonNullable<AgentActivity["finalOutcome"]>>([
  "answer",
  "retry_retrieval",
  "clarify",
  "abstain",
  "tool_executed",
  "confirmation_required",
])

function isNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function extractSafeAgentStep(raw: unknown): AgentStepEventData | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const phase = record.phase
  if (
    phase !== "tool_selected"
    && phase !== "retrieval_attempt_1_started"
    && phase !== "retrieval_attempt_1_completed"
    && phase !== "evidence_decision_1"
    && phase !== "retrieval_attempt_2_started"
    && phase !== "retrieval_attempt_2_completed"
    && phase !== "evidence_decision_2"
    && phase !== "final_decision"
  ) {
    return undefined
  }
  const decisionMode = record.decisionMode === "llm" || record.decisionMode === "deterministic"
    ? record.decisionMode
    : undefined
  const tool = typeof record.tool === "string" && VALID_TOOLS.has(record.tool as AgentTool)
    ? (record.tool as AgentTool)
    : undefined
  const decision = typeof record.decision === "string" && VALID_EVIDENCE_ACTIONS.has(record.decision as EvidenceAction)
    ? (record.decision as EvidenceAction)
    : undefined
  const outcome = typeof record.outcome === "string" && VALID_OUTCOMES.has(record.outcome as NonNullable<AgentActivity["finalOutcome"]>)
    ? (record.outcome as NonNullable<AgentActivity["finalOutcome"]>)
    : undefined

  return {
    phase,
    ...(decisionMode ? { decisionMode } : {}),
    ...(tool ? { tool } : {}),
    ...(isNonNegInt(record.authorizedChunks) ? { authorizedChunks: record.authorizedChunks } : {}),
    ...(isNonNegInt(record.mergedAuthorizedChunks) ? { mergedAuthorizedChunks: record.mergedAuthorizedChunks } : {}),
    ...(decision ? { decision } : {}),
    ...(outcome ? { outcome } : {}),
    ...(isNonNegInt(record.steps) ? { steps: record.steps } : {}),
    ...(isNonNegInt(record.maxSteps) ? { maxSteps: record.maxSteps } : {}),
  }
}

function applyAgentStepEvent(current: AgentActivity, raw: unknown): AgentActivity | undefined {
  const step = extractSafeAgentStep(raw)
  if (!step) return undefined
  const nextSteps: LiveAgentRetrievalStep[] = current.retrievalSteps.map((item) => ({ ...item }))

  switch (step.phase) {
    case "tool_selected":
      return {
        ...current,
        status: "in_progress",
        inProgressPhase: undefined,
        ...(step.decisionMode ? { decisionMode: step.decisionMode } : {}),
        ...(step.tool ? { tool: step.tool } : {}),
      }
    case "retrieval_attempt_1_started":
      return {
        ...current,
        status: "in_progress",
        inProgressPhase: "retrieval_attempt_1",
      }
    case "retrieval_attempt_1_completed": {
      const chunks = step.authorizedChunks ?? 0
      nextSteps[0] = { attempt: 1, authorized_chunks: chunks }
      return {
        ...current,
        status: "in_progress",
        inProgressPhase: "evidence_evaluation_1",
        retrievalAttempts: Math.max(current.retrievalAttempts, 1),
        retrievalSteps: nextSteps,
      }
    }
    case "evidence_decision_1":
      if (nextSteps[0] && step.decision) {
        nextSteps[0] = { ...nextSteps[0], decision: step.decision }
      }
      return {
        ...current,
        status: "in_progress",
        inProgressPhase: undefined,
        ...(step.decisionMode ? { decisionMode: step.decisionMode } : {}),
        retrievalSteps: nextSteps,
      }
    case "retrieval_attempt_2_started":
      return {
        ...current,
        status: "in_progress",
        reformulated: true,
        inProgressPhase: "retrieval_attempt_2",
      }
    case "retrieval_attempt_2_completed": {
      const chunks = step.authorizedChunks ?? 0
      nextSteps[1] = {
        attempt: 2,
        authorized_chunks: chunks,
        ...(typeof step.mergedAuthorizedChunks === "number"
          ? { merged_authorized_chunks: step.mergedAuthorizedChunks }
          : {}),
      }
      return {
        ...current,
        status: "in_progress",
        reformulated: true,
        inProgressPhase: "evidence_evaluation_2",
        retrievalAttempts: Math.max(current.retrievalAttempts, 2),
        retrievalSteps: nextSteps,
      }
    }
    case "evidence_decision_2":
      if (nextSteps[1] && step.decision) {
        nextSteps[1] = { ...nextSteps[1], decision: step.decision }
      }
      return {
        ...current,
        status: "in_progress",
        inProgressPhase: undefined,
        ...(step.decisionMode ? { decisionMode: step.decisionMode } : {}),
        retrievalSteps: nextSteps,
      }
    case "final_decision":
      return {
        ...current,
        status: "in_progress",
        inProgressPhase: "answering",
        ...(step.outcome ? { finalOutcome: step.outcome } : {}),
        ...(typeof step.steps === "number" ? { steps: step.steps } : {}),
        ...(typeof step.maxSteps === "number" ? { maxSteps: step.maxSteps } : {}),
      }
  }
}

function extractSafeAgentActivity(raw: unknown): AgentActivity | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (record.decision_mode !== "llm" && record.decision_mode !== "deterministic") return undefined
  if (typeof record.tool !== "string" || !VALID_TOOLS.has(record.tool as AgentTool)) return undefined
  if (
    !isNonNegInt(record.steps)
    || !isNonNegInt(record.max_steps)
    || !isNonNegInt(record.retrieval_attempts)
    || !isNonNegInt(record.max_retrieval_attempts)
  ) {
    return undefined
  }
  const outcome = record.final_outcome ?? record.next_action
  if (typeof outcome !== "string" || !VALID_OUTCOMES.has(outcome as NonNullable<AgentActivity["finalOutcome"]>)) {
    return undefined
  }

  const retrievalSteps: LiveAgentRetrievalStep[] = []
  if (Array.isArray(record.retrieval_steps)) {
    for (const item of record.retrieval_steps.slice(0, record.max_retrieval_attempts)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue
      const step = item as Record<string, unknown>
      if (
        isNonNegInt(step.attempt)
        && step.attempt >= 1
        && step.attempt <= record.retrieval_attempts
        && isNonNegInt(step.authorized_chunks)
        && typeof step.decision === "string"
        && VALID_EVIDENCE_ACTIONS.has(step.decision as EvidenceAction)
      ) {
        retrievalSteps.push({
          attempt: step.attempt,
          authorized_chunks: step.authorized_chunks,
          decision: step.decision as EvidenceAction,
          ...(isNonNegInt(step.merged_authorized_chunks)
            ? { merged_authorized_chunks: step.merged_authorized_chunks }
            : {}),
        })
      }
    }
  }

  return {
    status: "completed",
    decisionMode: record.decision_mode,
    tool: record.tool as AgentTool,
    steps: record.steps,
    maxSteps: record.max_steps,
    retrievalAttempts: record.retrieval_attempts,
    maxRetrievalAttempts: record.max_retrieval_attempts,
    reformulated: Boolean(record.reformulated),
    finalOutcome: outcome as NonNullable<AgentActivity["finalOutcome"]>,
    retrievalSteps,
  }
}

export async function sendChat(
  query: string,
  projectId: string | null | undefined,
  organizationId?: string,
  lastJiraTicketKey?: string | null,
  onJiraDraft?: (draft: { summary: string; description: string }) => void,
) {
  const store = useChatStore.getState()
  const chatScope = organizationId ? `organization:${organizationId}` : projectId
  if (!chatScope || !query.trim() || store.isLoading || store.activeProjectId !== chatScope) return
  const history = organizationId ? [] : store.messages.slice(-8).map(({ role, content }) => ({ role, content }))
  const messageId = crypto.randomUUID()
  let agentActivity: AgentActivity | undefined = {
    status: "in_progress",
    inProgressPhase: "tool_selection",
    retrievalAttempts: 0,
    maxRetrievalAttempts: 2,
    reformulated: false,
    retrievalSteps: [],
  }
  let hasServerAgentEvent = false
  store.addMessage({ id: crypto.randomUUID(), role: "user", content: query })
  store.addMessage({ id: messageId, role: "assistant", content: "", citations: [], agentActivity })
  store.setIsLoading(true)
  store.setStatusMessage("Searching your documents…")
  const current = () => {
    const state = useChatStore.getState()
    return state.activeProjectId === chatScope && state.messages.some(m => m.id === messageId)
  }
  let text = ""
  let citations: Citation[] = []
  let interactionId: string | undefined
  let fallbackQuestions: string[] | undefined
  const update = () => {
    if (current()) useChatStore.setState(state => ({
      messages: state.messages.map(m => m.id === messageId ? {
        ...m, content: text, citations, interactionId,
        ...(organizationId && text === ENTERPRISE_NO_EVIDENCE && fallbackQuestions?.length ? { fallbackQuestions } : {}),
        agentActivity,
      } : m),
    }))
  }
  try {
    const response = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(organizationId ? { organizationId } : { projectId }),
        query,
        messages: history,
        ...(organizationId && lastJiraTicketKey ? { lastJiraTicketKey } : {}),
        stream: true,
      }),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.error || "Unable to load answer.")
    }
    await readChatStream(response, event => {
      if (event.type === "agent_step" && agentActivity) {
        const updatedActivity = applyAgentStepEvent(agentActivity, event.step)
        if (updatedActivity) {
          hasServerAgentEvent = true
          agentActivity = updatedActivity
          update()
        }
      }
      if (event.type === "metadata") { citations = event.citations; interactionId = event.interactionId }
      if (event.type === "jira_draft") { onJiraDraft?.(event.draft) }
      if (event.type === "text") { text += event.text; update() }
      if (event.type === "finish") {
        fallbackQuestions = event.fallbackQuestions
        const parsed = extractSafeAgentActivity(event.metrics?.agent)
        if (parsed) {
          hasServerAgentEvent = true
          agentActivity = parsed
        } else if (hasServerAgentEvent && agentActivity) {
          agentActivity = { ...agentActivity, status: "completed", inProgressPhase: undefined }
        } else {
          agentActivity = undefined
        }
      }
    })
    if (!text.trim()) {
      throw new Error("The answer could not be completed. Please retry.")
    }
    update()
  } catch (error) {
    text = error instanceof Error ? `Error: ${error.message}` : "Unable to complete the answer."
    citations = []
    interactionId = undefined
    agentActivity = agentActivity
      ? {
          ...agentActivity,
          status: "failed",
          inProgressPhase: undefined,
          finalOutcome: undefined,
        }
      : {
          status: "failed",
          retrievalAttempts: 0,
          maxRetrievalAttempts: 2,
          reformulated: false,
          retrievalSteps: [],
        }
    update()
  } finally {
    if (current()) { store.setIsLoading(false); store.setStatusMessage(null) }
  }
}

