import { getDeterministicIntent, type DeterministicIntent } from "@/lib/chat-input"
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
  | { tool: "rag_retrieval"; requiresConfirmation: false }

export interface EvidenceEvaluation {
  sufficient: boolean
  reason: "no_chunks_retrieved" | "requested_policy_missing" | "zero_keyword_overlap" | "sufficient_evidence"
  matchedKeywords: number
  totalKeywords: number
}

export interface AgentTrace {
  tool: AgentTool
  steps: number
  max_steps: number
  retrieval_attempts: number
  max_retrieval_attempts: number
  reformulated: boolean
  evidence_sufficient: boolean
  evidence_reason: EvidenceEvaluation["reason"] | "deterministic_short_circuit" | "tool_executed"
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

/**
 * Bounded single-agent retrieval loop:
 * Step 1 tool select -> Step 2 retrieve (1) -> Step 3 evaluate ->
 * [optional Step 4-5 reformulate + retrieve (2) + re-evaluate, max 2 retrieval attempts].
 */
export async function runBoundedRetrievalLoop(params: {
  userQuery: string
  retrieveForQuery: (queryText: string) => Promise<RagChunk[]>
  maxAttempts?: number
  maxSteps?: number
}): Promise<{ chunks: RagChunk[]; agent: AgentTrace }> {
  const maxAttempts = Math.min(params.maxAttempts ?? MAX_RETRIEVAL_ATTEMPTS, MAX_RETRIEVAL_ATTEMPTS)
  const maxSteps = Math.min(params.maxSteps ?? MAX_AGENT_STEPS, MAX_AGENT_STEPS)
  let steps = 0
  const advanceStep = () => {
    steps++
    if (steps > maxSteps) {
      throw new Error(`Agent step limit exceeded (maxSteps=${maxSteps}).`)
    }
  }

  advanceStep() // Step 1: tool selected (rag_retrieval)
  advanceStep() // Step 2: retrieval attempt 1
  let retrievalAttempts = 1
  let chunks = await params.retrieveForQuery(params.userQuery)

  advanceStep() // Step 3: evaluate retrieved evidence
  let evaluation = evaluateRetrievedEvidence(params.userQuery, chunks)
  let reformulated = false

  if (!evaluation.sufficient && retrievalAttempts < maxAttempts) {
    const rewrittenQuery = reformulateRetrievalQuery(params.userQuery)
    if (rewrittenQuery) {
      reformulated = true
      advanceStep() // Step 4: reformulate + retrieval attempt 2
      retrievalAttempts++
      const secondChunks = await params.retrieveForQuery(rewrittenQuery)
      chunks = mergeUniqueChunks(secondChunks, chunks, 8)
      advanceStep() // Step 5: re-evaluate merged evidence
      evaluation = evaluateRetrievedEvidence(params.userQuery, chunks)
    }
  }

  return {
    chunks,
    agent: {
      tool: "rag_retrieval",
      steps,
      max_steps: maxSteps,
      retrieval_attempts: retrievalAttempts,
      max_retrieval_attempts: maxAttempts,
      reformulated,
      evidence_sufficient: evaluation.sufficient,
      evidence_reason: evaluation.reason,
    },
  }
}
