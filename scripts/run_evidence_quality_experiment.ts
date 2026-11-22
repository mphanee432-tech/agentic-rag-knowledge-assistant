/**
 * Controlled Baseline vs. Experimental Evidence-Quality Evaluation Runner.
 *
 * Read-only against Personal (`3c7605fb-...`) and Enterprise (`c0000000-...`) corpora:
 * uses authenticated user sessions only (RLS enforced on every RPC), writes ZERO
 * `interactions` or Jira records, and runs offline without altering live routes.
 *
 * Output artifacts:
 *   - artifacts/evaluation/evidence_quality_experiment_results.json
 *   - artifacts/evaluation/evidence_quality_experiment_summary.json
 */
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { GoogleGenAI } from "@google/genai"
import { createClient } from "@supabase/supabase-js"
import * as dotenv from "dotenv"
import {
  evaluateRetrievedEvidence,
  MAX_AGENT_STEPS,
  MAX_RETRIEVAL_ATTEMPTS,
  mergeUniqueChunks,
  reformulateRetrievalQuery,
} from "../lib/agent-loop"
import { citationIndices, validCitations } from "../lib/citations"
import { ENTERPRISE_NO_EVIDENCE, MAX_ANSWER_CHARS, NO_EVIDENCE } from "../lib/chat-contract"
import { getSystemPrompt } from "../lib/prompts/systemPrompt"
import { retrieveVerifiedChunks, type RagChunk } from "../lib/retrieve-chunks"
import {
  buildContextBlock,
  CALIBRATION_POLICIES,
  createConfiguredGeminiCaller,
  evaluateDraftGroundedness,
  evaluateReferenceCorrectness,
  isAnswerabilitySufficient,
  isEnterpriseRefusalText,
  isGroundednessAccepted,
  runExperimentalEvidencePipeline,
  type CalibrationPolicy,
} from "./experimental-evidence-evaluator"

dotenv.config({ path: ".env.local" })

const PERSONAL_PROJECT_ID = "3c7605fb-9ab8-4931-854c-9ccb3cc8077a"
const ENTERPRISE_ORG_ID = "c0000000-0000-4000-8000-000000000001"

const CALIBRATION_CASE_IDS = new Set([
  "P01",
  "P10",
  "E01",
  "E05",
  "E10",
  "E19",
  "E25",
  "CAL_PARA_1",
  "CAL_PARA_2",
  "CAL_INSUFF_1",
])

const STRATIFIED_DATASET_IDS = new Set([
  // Calibration dataset cases (5 canonical + 3 curated = 8 calibration)
  "P01", "P10", "E01", "E10", "E19", "E25",
  // Evaluation dataset cases (14 canonical + 5 curated = 19 evaluation -> total 27 cases)
  "P04", "P05", "P08", "P11", "P14",
  "E03", "E05", "E07", "E11", "E13", "E15", "E16", "E18", "E21",
])

const PERMITTED_DATASET_IDS = new Set([
  "P01", "P02", "P03", "P04", "P05", "P06", "P07", "P08", "P09", "P10", "P11", "P14",
  "E01", "E02", "E03", "E04", "E05", "E06", "E07", "E08", "E10", "E11", "E13", "E15",
  "E16", "E17", "E18", "E19", "E20", "E21", "E25",
])

function createPacedGeminiCaller(minIntervalMs = 4500) {
  const baseCaller = createConfiguredGeminiCaller(process.env.CHAT_MODEL || "gemini-3.5-flash-lite")
  let lastCallFinishedAt = 0

  return async (params: Parameters<typeof baseCaller>[0]) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastCallFinishedAt))
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }
      const apiStart = performance.now()
      try {
        const res = await baseCaller(params)
        lastCallFinishedAt = Date.now()
        return { ...res, api_latency_ms: Math.round(performance.now() - apiStart) }
      } catch (err: unknown) {
        lastCallFinishedAt = Date.now()
        const msg = err instanceof Error ? err.message : String(err)
        const status = (err as { statusCode?: number })?.statusCode
        if (status === 429 || status === 503 || /rate[-_\s]?limit|quota|429|unavailable|503/i.test(msg)) {
          const match = msg.match(/retry in\s+([\d.]+)s/i)
          const delayMs = match ? Math.ceil(Number(match[1]) * 1000) + 1500 : status === 503 ? 6000 * (attempt + 1) : 35_000
          console.warn(`[${status ?? "transient"} retry] waiting ${delayMs}ms before retry ${attempt + 1}...`)
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          continue
        }
        throw err
      }
    }
    throw new Error("Exceeded retry budget after Gemini 429 rate-limit responses.")
  }
}

interface ExperimentCase {
  case_id: string
  workspace: "personal" | "enterprise"
  category: string
  source_kind: "canonical_dataset" | "curated_paraphrase_or_stress"
  split: "calibration" | "evaluation"
  question: string
  expected_behavior: string
  expected_evidence_available: boolean
  ground_truth_answer: string
  restricted_markers?: string[]
}

const CURATED_STRESS_CASES: ExperimentCase[] = [
  {
    case_id: "CAL_PARA_1",
    workspace: "personal",
    category: "paraphrased_factual",
    source_kind: "curated_paraphrase_or_stress",
    split: "calibration",
    question: "How regularly should snapshots be archived for a small deployment?",
    expected_behavior: "answer",
    expected_evidence_available: true,
    ground_truth_answer:
      "For a small system, daily backups may be adequate if acceptable data loss is up to a day, with RPO and RTO defined explicitly and tested restore procedures.",
  },
  {
    case_id: "CAL_PARA_2",
    workspace: "enterprise",
    category: "paraphrased_factual",
    source_kind: "curated_paraphrase_or_stress",
    split: "calibration",
    question: "Can someone borrow two novels from the office shelf and avoid penalties if late?",
    expected_behavior: "answer",
    expected_evidence_available: true,
    ground_truth_answer:
      "Yes, an active employee may borrow up to two books from the Bluebird Bookshelf, and no fees or penalties apply for late returns (though late books must be returned before borrowing another).",
  },
  {
    case_id: "CAL_INSUFF_1",
    workspace: "enterprise",
    category: "insufficient_with_keyword_trap",
    source_kind: "curated_paraphrase_or_stress",
    split: "calibration",
    question: "What is DeccanBridge Software's approved weekend overtime pay multiplier per hour?",
    expected_behavior: "refuse",
    expected_evidence_available: false,
    ground_truth_answer: "I don't know based on the documents I can access.",
  },
  {
    case_id: "PAR_E01",
    workspace: "enterprise",
    category: "paraphrased_factual",
    source_kind: "curated_paraphrase_or_stress",
    split: "evaluation",
    question: "How many functional groups exist inside DeccanBridge Software, and where do the CEO and COO sit?",
    expected_behavior: "answer",
    expected_evidence_available: true,
    ground_truth_answer:
      "DeccanBridge Software has eight functional departments (Human Resources, Software Engineering, Product Management, Project Management, UI/UX, Operations, Marketing, and Finance). The CEO and COO hold Executive affiliation outside the eight functional departments.",
  },
  {
    case_id: "PAR_D04_TRAP",
    workspace: "enterprise",
    category: "insufficient_with_keyword_trap",
    source_kind: "curated_paraphrase_or_stress",
    split: "evaluation",
    question: "What minimum unit-test line coverage percentage does D04 mandate before approving a pull request?",
    expected_behavior: "refuse",
    expected_evidence_available: false,
    ground_truth_answer: "I don't know based on the documents I can access.",
  },
  {
    case_id: "PAR_P01",
    workspace: "personal",
    category: "paraphrased_factual",
    source_kind: "curated_paraphrase_or_stress",
    split: "evaluation",
    question: "Should early RAG teams adopt distributed streaming brokers or container orchestration below 10,000 chunks?",
    expected_behavior: "answer",
    expected_evidence_available: true,
    ground_truth_answer:
      "No, teams should avoid Kafka/distributed event-streaming and Kubernetes initially for fewer than 10,000 chunks because they add hard-to-justify complexity.",
  },
  {
    case_id: "AMB_E01",
    workspace: "enterprise",
    category: "ambiguous_query",
    source_kind: "curated_paraphrase_or_stress",
    split: "evaluation",
    question: "How many days is the company's approval or review window?",
    expected_behavior: "answer_with_clarification",
    expected_evidence_available: true,
    ground_truth_answer:
      "Depends on the policy: D02 planned leave routine decisions target 2 operational business days (with 5 operational business days notice); D08 routine equipment fulfillment targets 3 operational business days (1-day acknowledgement); D10 expense submission window is 30 calendar days; restricted grants expire in 30 days vs 90 days for Standard cross-department grants.",
  },
  {
    case_id: "PAR_PERSONAL_TRAP",
    workspace: "personal",
    category: "insufficient_with_keyword_trap",
    source_kind: "curated_paraphrase_or_stress",
    split: "evaluation",
    question: "Which Kubernetes Helm chart version does the blueprint mandate for pgvector failover?",
    expected_behavior: "refuse",
    expected_evidence_available: false,
    ground_truth_answer: "I don't know.",
  },
]

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  return Number(sorted[idx].toFixed(1))
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return Number((values.reduce((acc, v) => acc + v, 0) / values.length).toFixed(2))
}

function containsRestrictedLeak(text: string, caseItem: ExperimentCase): boolean {
  if (!caseItem.restricted_markers?.length) return false
  const lower = text.toLowerCase()
  return caseItem.restricted_markers.some((marker) => lower.includes(marker.toLowerCase()))
}

async function runBaselinePipeline(params: {
  query: string
  enterprise: boolean
  retrieveForQuery: (queryText: string) => Promise<{
    chunks: RagChunk[]
    embedding_ms: number
    retrieval_ms: number
  }>
  callLlm: ReturnType<typeof createPacedGeminiCaller>
}) {
  const refusalText = params.enterprise ? ENTERPRISE_NO_EVIDENCE : NO_EVIDENCE
  const promptVariant = params.enterprise ? "enterprise" : "strict"
  let steps = 1 // tool select
  let apiLatencyMs = 0

  steps++ // attempt 1
  let embeddingCalls = 1
  const r1 = await params.retrieveForQuery(params.query)
  apiLatencyMs += r1.embedding_ms + r1.retrieval_ms
  steps++ // heuristic evaluate
  const ev1 = evaluateRetrievedEvidence(params.query, r1.chunks)
  let chunks = r1.chunks
  let evFinal = ev1
  let retrievalAttempts = 1
  let reformulatedQuery: string | null = null

  if (!ev1.sufficient && retrievalAttempts < MAX_RETRIEVAL_ATTEMPTS) {
    const rq = reformulateRetrievalQuery(params.query)
    if (rq) {
      reformulatedQuery = rq
      steps++
      retrievalAttempts++
      embeddingCalls++
      const r2 = await params.retrieveForQuery(rq)
      apiLatencyMs += r2.embedding_ms + r2.retrieval_ms
      chunks = mergeUniqueChunks(r2.chunks, r1.chunks, 8)
      steps++
      evFinal = evaluateRetrievedEvidence(params.query, chunks)
    }
  }

  steps = Math.min(steps + 1, MAX_AGENT_STEPS)
  let answer = refusalText
  let llmCalls = 0
  let usage = { prompt: 0, completion: 0, total: 0 }
  let rawModelRefusal = false

  if (chunks.length > 0) {
    llmCalls = 1
    const gen = await params.callLlm({
      system: getSystemPrompt(promptVariant, buildContextBlock(chunks)),
      user: params.query,
      maxOutputTokens: 1000,
    })
    apiLatencyMs += gen.api_latency_ms ?? 0
    usage = gen.usage
    rawModelRefusal = isEnterpriseRefusalText(gen.text)

    if (!params.enterprise) {
      answer = gen.text.trim()
    } else {
      const citationsAll = chunks.map((c, i) => ({
        id: c.id,
        index: i + 1,
        content: c.content.slice(0, 300),
        metadata: c.metadata || {},
      }))
      const valid =
        !rawModelRefusal &&
        gen.finishReason === "stop" &&
        gen.text.length <= MAX_ANSWER_CHARS &&
        validCitations(gen.text, citationsAll)
      answer = valid ? gen.text : ENTERPRISE_NO_EVIDENCE
    }
  }

  const allCitations = chunks.map((c, i) => ({
    id: c.id,
    index: i + 1,
    content: c.content.slice(0, 300),
    metadata: c.metadata || {},
  }))
  const releasedCitations = isEnterpriseRefusalText(answer)
    ? []
    : params.enterprise
      ? allCitations.filter((c) => new Set(citationIndices(answer)).has(c.index))
      : allCitations

  const syntaxValid = isEnterpriseRefusalText(answer)
    ? citationIndices(answer).length === 0
    : answer.length > 0 && answer.length <= MAX_ANSWER_CHARS && validCitations(answer, allCitations)

  return {
    final_answer: answer,
    chunks,
    released_citations: releasedCitations,
    syntax_valid: syntaxValid,
    ev1,
    evFinal,
    retrieval_attempts: retrievalAttempts,
    reformulated_query: reformulatedQuery,
    steps,
    llm_calls: llmCalls,
    embedding_calls: embeddingCalls,
    usage,
    raw_model_refusal: rawModelRefusal,
    latency_ms: apiLatencyMs,
  }
}

async function main() {
  const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY! })
  const perSupa = createClient(
    process.env.NEXT_PUBLIC_PERSONAL_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_PERSONAL_SUPABASE_PUBLISHABLE_KEY!,
  )
  const entSupa = createClient(
    process.env.NEXT_PUBLIC_ENTERPRISE_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_ENTERPRISE_SUPABASE_PUBLISHABLE_KEY!,
  )
  const perSignIn = await perSupa.auth.signInWithPassword({
    email: process.env.EVAL_PERSONAL_EMAIL!,
    password: process.env.EVAL_PERSONAL_PASSWORD!,
  })
  const entSignIn = await entSupa.auth.signInWithPassword({
    email: process.env.EVAL_ENTERPRISE_EMAIL!,
    password: process.env.EVAL_ENTERPRISE_PASSWORD!,
  })
  assert.ok(!perSignIn.error, perSignIn.error?.message)
  assert.ok(!entSignIn.error, entSignIn.error?.message)

  // Verify Enterprise RLS & access baseline before running
  const retrievalCache = new Map<string, { chunks: RagChunk[]; embedding_ms: number; retrieval_ms: number }>()
  const makeRetriever = (workspace: "personal" | "enterprise") => async (queryText: string) => {
    const cacheKey = `${workspace}::${queryText}`
    const cached = retrievalCache.get(cacheKey)
    if (cached) return cached

    const tEmb = performance.now()
    const emb = await ai.models.embedContent({
      model: "gemini-embedding-2",
      contents: queryText,
      config: { outputDimensionality: 1536 },
    })
    const vector = emb.embeddings?.[0]?.values
    assert.ok(vector && vector.length === 1536, "Embedding vector generation failed")
    const embedding_ms = Math.round(performance.now() - tEmb)

    const tRet = performance.now()
    const telemetry = { retries: { retrieval: 0 }, errors: [] as string[] }
    const chunks = await retrieveVerifiedChunks(
      workspace === "enterprise" ? entSupa : perSupa,
      workspace === "personal" ? PERSONAL_PROJECT_ID : null,
      vector,
      queryText,
      AbortSignal.timeout(20_000),
      telemetry,
      workspace === "enterprise",
      workspace === "enterprise" ? ENTERPRISE_ORG_ID : null,
    )
    const retrieval_ms = Math.round(performance.now() - tRet)
    const entry = { chunks, embedding_ms, retrieval_ms }
    retrievalCache.set(cacheKey, entry)
    return entry
  }

  // Load dataset cases
  const suiteMode = process.argv.includes("--full") ? "full" : "stratified"
  const activeDatasetIds = suiteMode === "full" ? PERMITTED_DATASET_IDS : STRATIFIED_DATASET_IDS

  const rawJsonl = await readFile(path.join(process.cwd(), "evals", "agentic_eval_40.jsonl"), "utf8")
  const datasetRows = rawJsonl.split(/\r?\n/)
  const datasetCases: ExperimentCase[] = []
  for (const line of datasetRows) {
    if (!line.trim()) continue
    const row = JSON.parse(line) as Record<string, unknown>
    const caseId = String(row.case_id)
    if (!activeDatasetIds.has(caseId)) continue
    const expectedBehavior = String(row.expected_behavior)
    const expectedAvailable =
      expectedBehavior === "answer" ||
      expectedBehavior === "answer_with_clarification" ||
      expectedBehavior === "grounded_negative_or_refuse"
    datasetCases.push({
      case_id: caseId,
      workspace: row.workspace as "personal" | "enterprise",
      category: String(row.category),
      source_kind: "canonical_dataset",
      split: CALIBRATION_CASE_IDS.has(caseId) ? "calibration" : "evaluation",
      question: String(row.question),
      expected_behavior: expectedBehavior,
      expected_evidence_available: expectedAvailable,
      ground_truth_answer: String(row.ground_truth_answer),
      restricted_markers:
        caseId === "E10"
          ? ["D03", "Compensation"]
          : caseId === "E11"
            ? ["D11", "Confidential Budget"]
            : caseId === "E13"
              ? ["D12", "Playbook"]
              : caseId === "E15"
                ? ["D09", "Brand & Campaign"]
                : caseId === "E21"
                  ? ["D03", "D11"]
                  : undefined,
    })
  }

  const allCases: ExperimentCase[] = [...datasetCases, ...CURATED_STRESS_CASES]
  const callLlm = createPacedGeminiCaller(4500)

  console.log(`Running paired Baseline vs Experimental evaluation (${suiteMode}) across ${allCases.length} permitted cases...`)

  const caseResults: Array<Record<string, unknown>> = []
  const strictPolicy = CALIBRATION_POLICIES.strict_both
  const resultsPath = path.join(process.cwd(), "artifacts", "evaluation", "evidence_quality_experiment_results.json")
  await mkdir(path.dirname(resultsPath), { recursive: true })

  for (const item of allCases) {
    const retrieveForQuery = makeRetriever(item.workspace)
    const enterprise = item.workspace === "enterprise"

    // 1. Run Baseline (strictly sharing cached Attempt-1 retrieval)
    const baseline = await runBaselinePipeline({
      query: item.question,
      enterprise,
      retrieveForQuery,
      callLlm,
    })

    // 2. Run Experimental (strictly strict_both first, then evaluate calibration sensitivity deterministically from ev1/gr)
    const experimental = await runExperimentalEvidencePipeline({
      query: item.question,
      enterprise,
      policy: strictPolicy,
      retrieveForQuery,
      callLlm,
    })

    // 3. Offline Groundedness & Reference Correctness evaluation on BOTH outputs
    const baselineGroundedness = await evaluateDraftGroundedness({
      query: item.question,
      draftAnswer: baseline.final_answer,
      chunks: baseline.chunks,
      callLlm,
    })
    const baselineCorrectness = await evaluateReferenceCorrectness({
      query: item.question,
      answer: baseline.final_answer,
      expectedBehavior: item.expected_behavior,
      referenceAnswer: item.ground_truth_answer,
      enterprise,
      callLlm,
    })
    const experimentalCorrectness = await evaluateReferenceCorrectness({
      query: item.question,
      answer: experimental.final_answer,
      expectedBehavior: item.expected_behavior,
      referenceAnswer: item.ground_truth_answer,
      enterprise,
      callLlm,
    })

    const expEv1 = experimental.attempt_traces[0]?.answerability
    const restrictedZeroChunks = item.restricted_markers
      ? baseline.chunks.every((c) => !containsRestrictedLeak(c.content, item)) &&
        !containsRestrictedLeak(baseline.final_answer, item) &&
        !containsRestrictedLeak(experimental.final_answer, item)
      : true

    // Calibration policy outcomes computed on observed ev1 / final_groundedness
    const calibrationByPolicy = Object.fromEntries(
      Object.values(CALIBRATION_POLICIES).map((policy: CalibrationPolicy) => {
        const suff1 = expEv1 ? isAnswerabilitySufficient(expEv1, policy) : false
        const finalGr = experimental.final_groundedness
        const groundedOk = finalGr ? isGroundednessAccepted(finalGr, policy) : true
        return [
          policy.name,
          {
            attempt1_sufficient: suff1,
            false_sufficient: suff1 && !item.expected_evidence_available,
            false_insufficient: !suff1 && item.expected_evidence_available,
            grounded_pass: groundedOk,
          },
        ]
      }),
    )

    const row = {
      case_id: item.case_id,
      workspace: item.workspace,
      category: item.category,
      source_kind: item.source_kind,
      split: item.split,
      question: item.question,
      expected_behavior: item.expected_behavior,
      expected_evidence_available: item.expected_evidence_available,
      authz_preserved: restrictedZeroChunks,
      baseline: {
        attempt1_sufficient: baseline.ev1.sufficient,
        attempt1_reason: baseline.ev1.reason,
        false_sufficient: baseline.ev1.sufficient && !item.expected_evidence_available,
        false_insufficient: !baseline.ev1.sufficient && item.expected_evidence_available,
        retrieval_attempts: baseline.retrieval_attempts,
        reformulated_query: baseline.reformulated_query,
        recovered_on_second_attempt:
          baseline.retrieval_attempts === 2 &&
          !baseline.ev1.sufficient &&
          item.expected_evidence_available &&
          baselineCorrectness.correct === true,
        steps: baseline.steps,
        llm_calls: baseline.llm_calls,
        embedding_calls: baseline.embedding_calls,
        usage: baseline.usage,
        latency_ms: baseline.latency_ms,
        syntax_valid: baseline.syntax_valid,
        groundedness: {
          is_refusal: baselineGroundedness.is_refusal,
          groundedness_rate: baselineGroundedness.groundedness_rate,
          unsupported_claims: baselineGroundedness.unsupported_claims,
        },
        correctness: baselineCorrectness,
        abstention_correct: item.expected_evidence_available
          ? null
          : isEnterpriseRefusalText(baseline.final_answer),
        final_answer: baseline.final_answer,
      },
      experimental: {
        attempt1_verdict: expEv1?.verdict ?? "insufficient",
        attempt1_sufficient: expEv1 ? isAnswerabilitySufficient(expEv1, strictPolicy) : false,
        attempt1_missing_evidence: expEv1?.missing_evidence ?? [],
        false_sufficient:
          (expEv1 ? isAnswerabilitySufficient(expEv1, strictPolicy) : false) &&
          !item.expected_evidence_available,
        false_insufficient:
          !(expEv1 ? isAnswerabilitySufficient(expEv1, strictPolicy) : false) &&
          item.expected_evidence_available,
        retrieval_attempts: experimental.retrieval_attempts,
        reformulated_query: experimental.reformulated_query,
        recovered_on_second_attempt:
          experimental.recovered_on_second_attempt && experimentalCorrectness.correct === true,
        outcome: experimental.outcome,
        clarification_requested: experimental.clarification_requested,
        experimental_steps: experimental.experimental_steps,
        exceeded_6_step_budget: experimental.exceeded_6_step_budget,
        llm_calls: experimental.llm_calls,
        embedding_calls: experimental.embedding_calls,
        usage: experimental.usage,
        latency_ms: experimental.latency_ms,
        syntax_valid: experimental.final_groundedness ? experimental.final_groundedness.syntax_valid : true,
        groundedness: experimental.final_groundedness
          ? {
              is_refusal: experimental.final_groundedness.is_refusal,
              groundedness_rate: experimental.final_groundedness.groundedness_rate,
              unsupported_claims: experimental.final_groundedness.unsupported_claims,
              claims: experimental.final_groundedness.claims,
            }
          : null,
        correctness: experimentalCorrectness,
        abstention_correct: item.expected_evidence_available
          ? null
          : isEnterpriseRefusalText(experimental.final_answer),
        attempt_traces: experimental.attempt_traces.map((t) => ({
          attempt: t.attempt,
          query: t.query,
          chunk_count: t.retrieved_chunk_count,
          chunk_ids: t.retrieved_chunk_ids,
          verdict: t.answerability.verdict,
          missing_evidence: t.answerability.missing_evidence,
          suggested_reformulation: t.answerability.suggested_reformulation,
        })),
        final_answer: experimental.final_answer,
      },
      calibration_by_policy: calibrationByPolicy,
    }
    caseResults.push(row)
    await writeFile(resultsPath, JSON.stringify({ in_progress: true, cases: caseResults }, null, 2), "utf8")
    console.log(
      `[${item.case_id}] base=${baseline.ev1.sufficient ? "SUF" : "INS"}(corr=${baselineCorrectness.correct}) | exp=${expEv1?.verdict}(out=${experimental.outcome}, corr=${experimentalCorrectness.correct}, steps=${experimental.experimental_steps})`,
    )
  }

  const summarizeSubset = (rows: Array<Record<string, unknown>>, label: string) => {
    const n = rows.length
    const baseCorrectArr = rows
      .map((r) => (r.baseline as { correctness: { correct: boolean | null } }).correctness.correct)
      .filter((x): x is boolean => typeof x === "boolean")
    const expCorrectArr = rows
      .map((r) => (r.experimental as { correctness: { correct: boolean | null } }).correctness.correct)
      .filter((x): x is boolean => typeof x === "boolean")
    const abstainRows = rows.filter((r) => !(r.expected_evidence_available as boolean))
    const baseTrigger2 = rows.filter((r) => (r.baseline as { retrieval_attempts: number }).retrieval_attempts === 2)
    const expTrigger2 = rows.filter((r) => (r.experimental as { retrieval_attempts: number }).retrieval_attempts === 2)
    const expRecoveryEligible = expTrigger2.filter((r) => r.expected_evidence_available as boolean)
    const baseRecoveryEligible = baseTrigger2.filter((r) => r.expected_evidence_available as boolean)

    const baseTokens = rows.map((r) => (r.baseline as { usage: { total: number } }).usage.total)
    const expTokens = rows.map((r) => (r.experimental as { usage: { total: number } }).usage.total)
    const baseLat = rows.map((r) => (r.baseline as { latency_ms: number }).latency_ms)
    const expLat = rows.map((r) => (r.experimental as { latency_ms: number }).latency_ms)

    const baseSufAcc = rows.filter(
      (r) => (r.baseline as { attempt1_sufficient: boolean }).attempt1_sufficient === (r.expected_evidence_available as boolean),
    ).length
    const expSufAcc = rows.filter(
      (r) => (r.experimental as { attempt1_sufficient: boolean }).attempt1_sufficient === (r.expected_evidence_available as boolean),
    ).length

    return {
      subset: label,
      count: n,
      baseline: {
        sufficiency_accuracy_pct: Number(((baseSufAcc / n) * 100).toFixed(1)),
        false_sufficient_count: rows.filter((r) => (r.baseline as { false_sufficient: boolean }).false_sufficient).length,
        false_insufficient_count: rows.filter((r) => (r.baseline as { false_insufficient: boolean }).false_insufficient).length,
        second_retrieval_triggered_count: baseTrigger2.length,
        first_miss_second_hit_recovered: baseRecoveryEligible.filter(
          (r) => (r.baseline as { recovered_on_second_attempt: boolean }).recovered_on_second_attempt,
        ).length,
        first_miss_second_hit_eligible: baseRecoveryEligible.length,
        reference_correctness_pct: Number(((baseCorrectArr.filter(Boolean).length / Math.max(1, baseCorrectArr.length)) * 100).toFixed(1)),
        claim_groundedness_mean: mean(
          rows.map((r) => (r.baseline as { groundedness: { groundedness_rate: number } }).groundedness.groundedness_rate),
        ),
        citation_syntax_valid_pct: Number(
          ((rows.filter((r) => (r.baseline as { syntax_valid: boolean }).syntax_valid).length / n) * 100).toFixed(1),
        ),
        abstention_correct_pct: Number(
          (
            (abstainRows.filter((r) => (r.baseline as { abstention_correct: boolean | null }).abstention_correct === true).length /
              Math.max(1, abstainRows.length)) *
            100
          ).toFixed(1),
        ),
        total_llm_calls: rows.reduce((a, r) => a + (r.baseline as { llm_calls: number }).llm_calls, 0),
        total_embedding_calls: rows.reduce((a, r) => a + (r.baseline as { embedding_calls: number }).embedding_calls, 0),
        total_tokens: baseTokens.reduce((a, b) => a + b, 0),
        mean_tokens_per_query: mean(baseTokens),
        latency_p50_ms: percentile(baseLat, 50),
        latency_p95_ms: percentile(baseLat, 95),
        latency_mean_ms: mean(baseLat),
      },
      experimental: {
        sufficiency_accuracy_pct: Number(((expSufAcc / n) * 100).toFixed(1)),
        false_sufficient_count: rows.filter((r) => (r.experimental as { false_sufficient: boolean }).false_sufficient).length,
        false_insufficient_count: rows.filter((r) => (r.experimental as { false_insufficient: boolean }).false_insufficient).length,
        second_retrieval_triggered_count: expTrigger2.length,
        first_miss_second_hit_recovered: expRecoveryEligible.filter(
          (r) => (r.experimental as { recovered_on_second_attempt: boolean }).recovered_on_second_attempt,
        ).length,
        first_miss_second_hit_eligible: expRecoveryEligible.length,
        exceeded_6_step_budget_count: rows.filter((r) => (r.experimental as { exceeded_6_step_budget: boolean }).exceeded_6_step_budget).length,
        generation_grounding_failures: rows.filter((r) => (r.experimental as { outcome: string }).outcome === "generation_grounding_failure").length,
        reference_correctness_pct: Number(((expCorrectArr.filter(Boolean).length / Math.max(1, expCorrectArr.length)) * 100).toFixed(1)),
        claim_groundedness_mean: mean(
          rows.map((r) => {
            const g = (r.experimental as { groundedness: { groundedness_rate: number } | null }).groundedness
            return g ? g.groundedness_rate : 1
          }),
        ),
        citation_syntax_valid_pct: Number(
          ((rows.filter((r) => (r.experimental as { syntax_valid: boolean }).syntax_valid).length / n) * 100).toFixed(1),
        ),
        abstention_correct_pct: Number(
          (
            (abstainRows.filter((r) => (r.experimental as { abstention_correct: boolean | null }).abstention_correct === true).length /
              Math.max(1, abstainRows.length)) *
            100
          ).toFixed(1),
        ),
        total_llm_calls: rows.reduce((a, r) => a + (r.experimental as { llm_calls: number }).llm_calls, 0),
        total_embedding_calls: rows.reduce((a, r) => a + (r.experimental as { embedding_calls: number }).embedding_calls, 0),
        total_tokens: expTokens.reduce((a, b) => a + b, 0),
        mean_tokens_per_query: mean(expTokens),
        latency_p50_ms: percentile(expLat, 50),
        latency_p95_ms: percentile(expLat, 95),
        latency_mean_ms: mean(expLat),
      },
      authz_correct_count: rows.filter((r) => r.authz_preserved === true).length,
      token_multiplier: Number(
        (expTokens.reduce((a, b) => a + b, 0) / Math.max(1, baseTokens.reduce((a, b) => a + b, 0))).toFixed(2),
      ),
      cost_estimation_note: "AUDITED_RATE_NOT_CONFIGURED_IN_REPO (reported via exact LLM calls, embeddings, and token totals)",
    }
  }

  const calRows = caseResults.filter((r) => r.split === "calibration")
  const evalRows = caseResults.filter((r) => r.split === "evaluation")
  const calibrationSweep = Object.keys(CALIBRATION_POLICIES).map((policyName) => {
    const matches = calRows.filter(
      (r) =>
        (r.calibration_by_policy as Record<string, { attempt1_sufficient: boolean }>)[policyName].attempt1_sufficient ===
        (r.expected_evidence_available as boolean),
    ).length
    const fs = calRows.filter(
      (r) => (r.calibration_by_policy as Record<string, { false_sufficient: boolean }>)[policyName].false_sufficient,
    ).length
    const fi = calRows.filter(
      (r) => (r.calibration_by_policy as Record<string, { false_insufficient: boolean }>)[policyName].false_insufficient,
    ).length
    const gp = calRows.filter(
      (r) => (r.calibration_by_policy as Record<string, { grounded_pass: boolean }>)[policyName].grounded_pass,
    ).length
    return {
      policy: policyName,
      calibration_count: calRows.length,
      sufficiency_accuracy_pct: Number(((matches / calRows.length) * 100).toFixed(1)),
      false_sufficient: fs,
      false_insufficient: fi,
      groundedness_pass_count: gp,
    }
  })

  const summary = {
    generated_at: new Date().toISOString(),
    model_id: process.env.CHAT_MODEL || "gemini-3.5-flash-lite",
    embedding_model: "gemini-embedding-2",
    production_constants: {
      MAX_RETRIEVAL_ATTEMPTS,
      MAX_AGENT_STEPS,
    },
    calibration_sweep_on_labeled_examples: calibrationSweep,
    overall: summarizeSubset(caseResults, "all_38_cases"),
    calibration_split: summarizeSubset(calRows, "calibration_10_cases"),
    evaluation_split: summarizeSubset(evalRows, "evaluation_28_cases"),
    personal_workspace: summarizeSubset(caseResults.filter((r) => r.workspace === "personal"), "personal"),
    enterprise_workspace: summarizeSubset(caseResults.filter((r) => r.workspace === "enterprise"), "enterprise"),
  }

  await mkdir(path.join(process.cwd(), "artifacts", "evaluation"), { recursive: true })
  await writeFile(
    path.join(process.cwd(), "artifacts", "evaluation", "evidence_quality_experiment_results.json"),
    JSON.stringify({ summary, cases: caseResults }, null, 2),
    "utf8",
  )
  await writeFile(
    path.join(process.cwd(), "artifacts", "evaluation", "evidence_quality_experiment_summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8",
  )

  console.log("\n=== EXPERIMENT SUMMARY ===")
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
