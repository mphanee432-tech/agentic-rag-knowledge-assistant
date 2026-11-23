import { getDeterministicIntent, type DeterministicIntent } from "@/lib/chat-input"
import type { AgentStepEventData } from "@/lib/chat-contract"
import {
  draftJiraTicket,
  extractJiraStatusIssueKey,
  isKeylessJiraStatusQuery,
  JIRA_ISSUE_KEY_PATTERN,
} from "@/lib/jira-ticket"
import type { RagChunk } from "@/lib/retrieve-chunks"

export const MAX_AGENT_STEPS = 6
export const MAX_RETRIEVAL_ATTEMPTS = 2

export type AgentTool =
  | "deterministic_reply"
  | "jira_status"
  | "jira_status_clarification"
  | "jira_create_draft"
  | "rag_retrieval"
export type JiraTicketDraft = NonNullable<ReturnType<typeof draftJiraTicket>>

export type AgentToolDecision =
  | { tool: "deterministic_reply"; intent: DeterministicIntent; requiresConfirmation: false }
  | { tool: "jira_status"; issueKey: string; requiresConfirmation: false }
  | { tool: "jira_status_clarification"; requiresConfirmation: false }
  | { tool: "jira_create_draft"; draft: JiraTicketDraft; requiresConfirmation: true }
  | { tool: "rag_retrieval"; searchQuery?: string; requiresConfirmation: false }

export interface TokenCounts {
  prompt: number
  completion: number
  total: number
}

export type EvidenceAction = "answer" | "retry_retrieval" | "clarify" | "abstain"
export type EvidenceQuality = "sufficient" | "partial" | "topical_only" | "insufficient"
export type AbstentionReason =
  | "none"
  | "no_chunks_retrieved"
  | "insufficient_evidence"
  | "topical_only_evidence"
  | "unsupported_evaluator_answer"
  | "no_new_evidence_on_retry"
  | "generator_refusal"
  | "invalid_citations"
  | "answer_length_exceeded"
  | "visibility_recheck_failed"

export interface EvidenceEvaluation {
  sufficient: boolean
  reason: "no_chunks_retrieved" | "requested_policy_missing" | "zero_keyword_overlap" | "sufficient_evidence"
  matchedKeywords: number
  totalKeywords: number
}

export interface EvidenceDecision {
  sufficient: boolean
  evidenceQuality?: EvidenceQuality
  supportingChunkIndices?: number[]
  reason: string
  nextAction: EvidenceAction
  reformulatedQuery: string | null
  clarificationQuestion?: string | null
  clampedFrom?: EvidenceAction | null
  tokens?: TokenCounts
  retries?: number
}

export interface AgentRetrievalStep {
  attempt: number
  authorized_chunks: number
  decision: EvidenceAction
  merged_authorized_chunks?: number
}

export interface AgentTrace {
  tool: AgentTool
  steps: number
  max_steps: number
  retrieval_attempts: number
  max_retrieval_attempts: number
  reformulated: boolean
  evidence_sufficient: boolean
  evidence_quality?: EvidenceQuality
  supporting_chunk_count?: number
  supporting_chunk_indices?: number[]
  evidence_reason: string
  decision_mode?: "llm" | "deterministic"
  evaluator_decision?: EvidenceAction
  decision_clamped_from?: EvidenceAction | null
  next_action?: EvidenceAction | "tool_executed" | "confirmation_required"
  final_outcome?: EvidenceAction | "tool_executed" | "confirmation_required"
  evaluator_generator_disagreement?: boolean
  abstention_reason?: AbstentionReason
  clarification_question?: string | null
  decision_tokens?: TokenCounts
  retrieval_steps?: AgentRetrievalStep[]
}

const STOPWORDS = new Set([
  "about", "after", "all", "also", "and", "any", "are", "because", "been", "before", "being",
  "both", "but", "can", "could", "did", "does", "doing", "each", "far", "for", "from", "had",
  "has", "have", "her", "here", "his", "how", "into", "its", "many", "may", "more", "most",
  "much", "must", "not", "now", "off", "one", "only", "our", "out", "over", "own", "per",
  "please", "say", "says", "she", "should", "some", "such", "tell", "than", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "those", "under", "until",
  "very", "was", "were", "what", "when", "where", "which", "who", "whom", "why", "will",
  "with", "would", "your",
])

const DOMAIN_EXPANSIONS: Record<string, string> = {
  d01: "DOCUMENT CONTROL Employee Handbook",
  d02: "Leave Attendance Policy",
  d04: "Engineering Code Review Incident SOP",
  d08: "Equipment Service Requests",
  d10: "Travel Expense Reimbursement",
  sla: "operational business day service window",
  custodian: "DOCUMENT CONTROL custodian",
  reviewer: "DOCUMENT CONTROL independent reviewer",
  bookshelf: "Bluebird Bookshelf Book Exchange",
  book: "Bluebird Bookshelf Book Exchange",
  books: "Bluebird Bookshelf Book Exchange",
}

/** Single-agent deterministic tool router enforcing Jira human confirmation before writes. */
export function selectAgentTool(
  query: string,
  options: { isEnterprise: boolean; jiraAccessAvailable: boolean; lastJiraTicketKey?: string | null },
): AgentToolDecision {
  const intent = getDeterministicIntent(query)
  if (intent) {
    return { tool: "deterministic_reply", intent, requiresConfirmation: false }
  }
  if (options.isEnterprise) {
    const issueKey = extractJiraStatusIssueKey(query)
    if (issueKey) {
      return { tool: "jira_status", issueKey, requiresConfirmation: false }
    }
    if (isKeylessJiraStatusQuery(query)) {
      const normalizedLastKey = options.lastJiraTicketKey?.trim().toUpperCase() ?? ""
      if (normalizedLastKey && JIRA_ISSUE_KEY_PATTERN.test(normalizedLastKey)) {
        return { tool: "jira_status", issueKey: normalizedLastKey, requiresConfirmation: false }
      }
      return { tool: "jira_status_clarification", requiresConfirmation: false }
    }
  }
  if (options.jiraAccessAvailable) {
    const draft = draftJiraTicket(query)
    if (draft) {
      return { tool: "jira_create_draft", draft, requiresConfirmation: true }
    }
  }
  return { tool: "rag_retrieval", requiresConfirmation: false }
}

export function extractSalientKeywords(query: string): string[] {
  const tokens = query.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []
  const unique: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    if (STOPWORDS.has(token) || seen.has(token)) continue
    seen.add(token)
    unique.push(token)
  }
  return unique
}

/** Evaluate whether retrieved chunks plausibly cover the query's policies and salient keywords. */
export function evaluateRetrievedEvidence(query: string, chunks: RagChunk[]): EvidenceEvaluation {
  const keywords = extractSalientKeywords(query)
  if (chunks.length === 0) {
    return { sufficient: false, reason: "no_chunks_retrieved", matchedKeywords: 0, totalKeywords: keywords.length }
  }
  const combinedText = chunks.map((chunk) => chunk.content).join("\n").toLowerCase()
  const policyCodes = [...new Set((query.match(/\bD(?:0[1-9]|1[0-2])\b/gi) ?? []).map((code) => code.toUpperCase()))]
  if (policyCodes.length > 0) {
    const hasAnyRequestedPolicy = policyCodes.some((code) => new RegExp(`\\b${code}\\b`, "i").test(combinedText))
    if (!hasAnyRequestedPolicy) {
      return {
        sufficient: false,
        reason: "requested_policy_missing",
        matchedKeywords: 0,
        totalKeywords: keywords.length,
      }
    }
  }
  const matchedKeywords = keywords.filter((word) => combinedText.includes(word)).length
  if (keywords.length >= 2 && matchedKeywords === 0) {
    return {
      sufficient: false,
      reason: "zero_keyword_overlap",
      matchedKeywords: 0,
      totalKeywords: keywords.length,
    }
  }
  return {
    sufficient: true,
    reason: "sufficient_evidence",
    matchedKeywords,
    totalKeywords: keywords.length,
  }
}

/**
 * Produce a distinct keyword/alias-expanded query only for multi-word queries that benefit
 * from stopword pruning or domain aliases; returns null for single-token/literal inputs.
 */
export function reformulateRetrievalQuery(query: string): string | null {
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (words.length < 2) return null

  const rawTokens = query.toLowerCase().match(/[a-z0-9_]+/g) ?? []
  const salient = extractSalientKeywords(query)
  if (salient.length < 2) return null

  const expanded: string[] = [...salient]
  let hadExpansion = false
  for (const token of salient) {
    const alias = DOMAIN_EXPANSIONS[token]
    if (alias) {
      expanded.push(alias)
      hadExpansion = true
    }
  }
  const hadStoppedTokens = rawTokens.length > salient.length
  if (!hadStoppedTokens && !hadExpansion) return null

  const candidate = expanded.join(" ").trim()
  const normalizedOriginal = rawTokens.join(" ")
  const normalizedCandidate = (candidate.toLowerCase().match(/[a-z0-9_]+/g) ?? []).join(" ")
  if (!normalizedCandidate || normalizedCandidate === normalizedOriginal) return null
  return candidate.slice(0, 400)
}

export function mergeUniqueChunks(primary: RagChunk[], secondary: RagChunk[], limit = 8): RagChunk[] {
  const merged: RagChunk[] = []
  const seen = new Set<string>()
  for (const chunk of [...primary, ...secondary]) {
    if (seen.has(chunk.id)) continue
    seen.add(chunk.id)
    merged.push(chunk)
    if (merged.length >= limit) break
  }
  return merged
}

function addTokens(acc: TokenCounts, next?: TokenCounts) {
  if (!next) return
  acc.prompt += next.prompt
  acc.completion += next.completion
  acc.total += next.total
}

function normalizeQueryText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim()
}

function normalizeEvidenceQuality(
  raw: EvidenceDecision,
  chunksCount: number,
): EvidenceQuality {
  if (
    raw.evidenceQuality === "sufficient"
    || raw.evidenceQuality === "partial"
    || raw.evidenceQuality === "topical_only"
    || raw.evidenceQuality === "insufficient"
  ) {
    return chunksCount === 0 ? "insufficient" : raw.evidenceQuality
  }
  if (chunksCount === 0) return "insufficient"
  if (raw.nextAction === "clarify") return "partial"
  return raw.sufficient ? "sufficient" : "insufficient"
}

function normalizeSupportingChunkIndices(
  indices: number[] | undefined,
  chunksCount: number,
): number[] | undefined {
  if (!Array.isArray(indices)) return undefined
  const valid = new Set<number>()
  for (const idx of indices) {
    if (typeof idx === "number" && Number.isInteger(idx) && idx >= 1 && idx <= chunksCount) {
      valid.add(idx)
    }
  }
  return [...valid].sort((a, b) => a - b)
}

export function clampEvidenceDecision(
  raw: EvidenceDecision,
  chunksCount: number,
  canRetry: boolean,
  previousQueries: string[],
): EvidenceDecision {
  const seen = new Set(previousQueries.map(normalizeQueryText))
  const candidateReformulation = raw.reformulatedQuery?.trim().slice(0, 400) || null
  const isDistinctReformulation = Boolean(candidateReformulation && !seen.has(normalizeQueryText(candidateReformulation)))
  const candidateClarification = raw.clarificationQuestion?.trim().slice(0, 400) || null
  const quality = normalizeEvidenceQuality(raw, chunksCount)
  const validSupportingIndices = normalizeSupportingChunkIndices(raw.supportingChunkIndices, chunksCount)
  const hasSupportingCheck = validSupportingIndices !== undefined
  const hasSupportingEvidence = !hasSupportingCheck || validSupportingIndices.length > 0
  const supportingIndicesOut = validSupportingIndices ?? []

  if (raw.nextAction === "retry_retrieval") {
    if (canRetry && isDistinctReformulation) {
      return {
        ...raw,
        sufficient: false,
        evidenceQuality: quality === "sufficient" ? "partial" : quality,
        supportingChunkIndices: supportingIndicesOut,
        reformulatedQuery: candidateReformulation,
        clarificationQuestion: null,
        clampedFrom: raw.clampedFrom ?? null,
      }
    }
    return {
      sufficient: false,
      evidenceQuality: chunksCount === 0 ? "insufficient" : (quality === "sufficient" ? "insufficient" : quality),
      supportingChunkIndices: supportingIndicesOut,
      reason: chunksCount === 0 ? "no_chunks_retrieved" : raw.reason || "insufficient_after_retries",
      nextAction: "abstain",
      reformulatedQuery: null,
      clarificationQuestion: null,
      clampedFrom: raw.clampedFrom ?? null,
    }
  }

  if (chunksCount === 0) {
    return {
      sufficient: false,
      evidenceQuality: "insufficient",
      supportingChunkIndices: [],
      reason: raw.reason || "no_chunks_retrieved",
      nextAction: "abstain",
      reformulatedQuery: null,
      clarificationQuestion: null,
      clampedFrom: raw.clampedFrom ?? (raw.nextAction === "answer" || raw.nextAction === "clarify" ? raw.nextAction : null),
    }
  }

  if (raw.nextAction === "answer") {
    const qualityAllowsAnswer = !raw.evidenceQuality || quality === "sufficient"
    const isSupportedAnswer = raw.sufficient === true && qualityAllowsAnswer && hasSupportingEvidence
    if (isSupportedAnswer) {
      return {
        sufficient: true,
        evidenceQuality: "sufficient",
        supportingChunkIndices: supportingIndicesOut,
        reason: raw.reason || "sufficient_evidence",
        nextAction: "answer",
        reformulatedQuery: null,
        clarificationQuestion: null,
        clampedFrom: null,
      }
    }
    const downgradedQuality: EvidenceQuality = quality === "sufficient" ? "insufficient" : quality
    if (canRetry && isDistinctReformulation) {
      return {
        sufficient: false,
        evidenceQuality: downgradedQuality,
        supportingChunkIndices: supportingIndicesOut,
        reason: raw.reason && raw.reason !== "sufficient_evidence" ? raw.reason : "unsupported_answer_decision",
        nextAction: "retry_retrieval",
        reformulatedQuery: candidateReformulation,
        clarificationQuestion: null,
        clampedFrom: "answer",
      }
    }
    if (downgradedQuality === "partial" && candidateClarification && hasSupportingEvidence) {
      return {
        sufficient: false,
        evidenceQuality: "partial",
        supportingChunkIndices: supportingIndicesOut,
        reason: raw.reason && raw.reason !== "sufficient_evidence" ? raw.reason : "partial_evidence_requires_clarification",
        nextAction: "clarify",
        reformulatedQuery: null,
        clarificationQuestion: candidateClarification,
        clampedFrom: "answer",
      }
    }
    return {
      sufficient: false,
      evidenceQuality: downgradedQuality,
      supportingChunkIndices: supportingIndicesOut,
      reason: raw.reason && raw.reason !== "sufficient_evidence" ? raw.reason : "unsupported_answer_decision",
      nextAction: "abstain",
      reformulatedQuery: null,
      clarificationQuestion: null,
      clampedFrom: "answer",
    }
  }

  if (raw.nextAction === "clarify") {
    const qualityAllowsClarify = quality === "partial" || quality === "sufficient"
    const isSupportedClarify = Boolean(candidateClarification) && qualityAllowsClarify && hasSupportingEvidence
    if (isSupportedClarify) {
      return {
        sufficient: false,
        evidenceQuality: "partial",
        supportingChunkIndices: supportingIndicesOut,
        reason: raw.reason || "partial_evidence_clarification",
        nextAction: "clarify",
        reformulatedQuery: null,
        clarificationQuestion: candidateClarification,
        clampedFrom: raw.clampedFrom ?? null,
      }
    }
    const downgradedQuality: EvidenceQuality = quality === "sufficient" ? "insufficient" : quality
    if (canRetry && isDistinctReformulation) {
      return {
        sufficient: false,
        evidenceQuality: downgradedQuality,
        supportingChunkIndices: supportingIndicesOut,
        reason: raw.reason || "ungrounded_clarification",
        nextAction: "retry_retrieval",
        reformulatedQuery: candidateReformulation,
        clarificationQuestion: null,
        clampedFrom: "clarify",
      }
    }
    return {
      sufficient: false,
      evidenceQuality: downgradedQuality,
      supportingChunkIndices: supportingIndicesOut,
      reason: raw.reason || "ungrounded_clarification",
      nextAction: "abstain",
      reformulatedQuery: null,
      clarificationQuestion: null,
      clampedFrom: "clarify",
    }
  }

  return {
    sufficient: false,
    evidenceQuality: quality === "sufficient" ? "insufficient" : quality,
    supportingChunkIndices: supportingIndicesOut,
    reason: raw.reason || "insufficient_evidence",
    nextAction: "abstain",
    reformulatedQuery: null,
    clarificationQuestion: null,
    clampedFrom: raw.clampedFrom ?? null,
  }
}

/**
 * Bounded single-agent retrieval loop:
 * Step 1 tool select -> Step 2 retrieve (1) -> Step 3 evaluate ->
 * [optional Step 4-5 reformulate + retrieve (2) + re-evaluate, max 2 retrieval attempts].
 */
export async function runBoundedRetrievalLoop(params: {
  userQuery: string
  initialQuery?: string
  initialSteps?: number
  retrieveForQuery: (queryText: string) => Promise<RagChunk[]>
  decideAfterRetrieval?: (ctx: {
    userQuery: string
    chunks: RagChunk[]
    attempt: number
    canRetry: boolean
    previousQueries: string[]
  }) => Promise<EvidenceDecision>
  onStep?: (step: AgentStepEventData) => void
  maxAttempts?: number
  maxSteps?: number
}): Promise<{ chunks: RagChunk[]; agent: AgentTrace; finalDecision: EvidenceDecision }> {
  const maxAttempts = Math.min(params.maxAttempts ?? MAX_RETRIEVAL_ATTEMPTS, MAX_RETRIEVAL_ATTEMPTS)
  const maxSteps = Math.min(params.maxSteps ?? MAX_AGENT_STEPS, MAX_AGENT_STEPS)
  let steps = params.initialSteps ?? 0
  if (steps > maxSteps) {
    throw new Error(`Agent step limit exceeded (maxSteps=${maxSteps}).`)
  }
  const advanceStep = () => {
    steps++
    if (steps > maxSteps) {
      throw new Error(`Agent step limit exceeded (maxSteps=${maxSteps}).`)
    }
  }

  const decisionTokens: TokenCounts = { prompt: 0, completion: 0, total: 0 }
  const usingLlmEvaluator = Boolean(params.decideAfterRetrieval)
  const evaluateStep = async (chunks: RagChunk[], attempt: number, previousQueries: string[]): Promise<EvidenceDecision> => {
    const canRetry = attempt < maxAttempts
    if (params.decideAfterRetrieval) {
      const decision = await params.decideAfterRetrieval({
        userQuery: params.userQuery,
        chunks,
        attempt,
        canRetry,
        previousQueries,
      })
      addTokens(decisionTokens, decision.tokens)
      return clampEvidenceDecision(decision, chunks.length, canRetry, previousQueries)
    }
    const heuristic = evaluateRetrievedEvidence(params.userQuery, chunks)
    const rewrite = !heuristic.sufficient && canRetry ? reformulateRetrievalQuery(params.userQuery) : null
    if (!heuristic.sufficient && rewrite) {
      return { sufficient: false, reason: heuristic.reason, nextAction: "retry_retrieval", reformulatedQuery: rewrite }
    }
    return {
      sufficient: heuristic.sufficient,
      reason: heuristic.reason,
      nextAction: heuristic.sufficient ? "answer" : "abstain",
      reformulatedQuery: null,
    }
  }

  if (steps === 0) {
    advanceStep() // Step 1: tool selected (rag_retrieval)
  }
  const firstQuery = params.initialQuery?.trim().slice(0, 400) || params.userQuery
  const previousQueries = [firstQuery]

  const decisionMode: "llm" | "deterministic" = usingLlmEvaluator ? "llm" : "deterministic"

  advanceStep() // Step 2: retrieval attempt 1
  params.onStep?.({ phase: "retrieval_attempt_1_started" })
  let retrievalAttempts = 1
  let chunks = await params.retrieveForQuery(firstQuery)
  params.onStep?.({ phase: "retrieval_attempt_1_completed", authorizedChunks: chunks.length })

  advanceStep() // Step 3: evaluate retrieved evidence
  let decision = await evaluateStep(chunks, retrievalAttempts, previousQueries)
  params.onStep?.({ phase: "evidence_decision_1", decisionMode, decision: decision.nextAction })
  const retrievalSteps: AgentRetrievalStep[] = [
    {
      attempt: 1,
      authorized_chunks: chunks.length,
      decision: decision.nextAction,
    },
  ]
  let reformulated = false

  if (
    decision.nextAction === "retry_retrieval"
    && decision.reformulatedQuery
    && retrievalAttempts < maxAttempts
    && steps + 2 < maxSteps
  ) {
    reformulated = true
    previousQueries.push(decision.reformulatedQuery)
    advanceStep() // Step 4: retrieval attempt 2 with reformulated query
    params.onStep?.({ phase: "retrieval_attempt_2_started" })
    retrievalAttempts++
    const priorChunkIds = new Set(chunks.map((chunk) => chunk.id))
    const secondChunks = await params.retrieveForQuery(decision.reformulatedQuery)
    const newChunkCount = secondChunks.filter((chunk) => !priorChunkIds.has(chunk.id)).length
    chunks = mergeUniqueChunks(secondChunks, chunks, 8)
    params.onStep?.({
      phase: "retrieval_attempt_2_completed",
      authorizedChunks: secondChunks.length,
      mergedAuthorizedChunks: chunks.length,
    })
    advanceStep() // Step 5: re-evaluate merged evidence (short-circuit if retry added zero new chunks)
    if (usingLlmEvaluator && newChunkCount === 0) {
      decision = {
        sufficient: false,
        evidenceQuality: chunks.length === 0
          ? "insufficient"
          : (decision.evidenceQuality === "topical_only" || decision.evidenceQuality === "partial"
            ? decision.evidenceQuality
            : "insufficient"),
        supportingChunkIndices: [],
        reason: chunks.length === 0 ? "no_chunks_retrieved" : "no_new_evidence_on_retry",
        nextAction: "abstain",
        reformulatedQuery: null,
        clarificationQuestion: null,
        clampedFrom: null,
      }
    } else {
      decision = await evaluateStep(chunks, retrievalAttempts, previousQueries)
    }
    params.onStep?.({ phase: "evidence_decision_2", decisionMode, decision: decision.nextAction })
    retrievalSteps.push({
      attempt: 2,
      authorized_chunks: secondChunks.length,
      merged_authorized_chunks: chunks.length,
      decision: decision.nextAction,
    })
  }

  decision = clampEvidenceDecision(decision, chunks.length, false, previousQueries)

  return {
    chunks,
    finalDecision: decision,
    agent: {
      tool: "rag_retrieval",
      steps,
      max_steps: maxSteps,
      retrieval_attempts: retrievalAttempts,
      max_retrieval_attempts: maxAttempts,
      reformulated,
      evidence_sufficient: decision.sufficient,
      evidence_quality: decision.evidenceQuality ?? (decision.sufficient ? "sufficient" : "insufficient"),
      supporting_chunk_count: decision.supportingChunkIndices?.length ?? 0,
      supporting_chunk_indices: decision.supportingChunkIndices ?? [],
      evidence_reason: decision.reason,
      decision_mode: usingLlmEvaluator ? "llm" : "deterministic",
      evaluator_decision: decision.nextAction,
      decision_clamped_from: decision.clampedFrom ?? null,
      next_action: decision.nextAction,
      clarification_question: decision.clarificationQuestion ?? null,
      decision_tokens: decisionTokens,
      retrieval_steps: retrievalSteps,
    },
  }
}
