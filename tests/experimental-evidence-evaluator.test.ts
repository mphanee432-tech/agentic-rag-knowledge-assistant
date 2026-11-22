import assert from "node:assert/strict"
import test from "node:test"
import { ENTERPRISE_NO_EVIDENCE } from "../lib/chat-contract"
import { MAX_AGENT_STEPS } from "../lib/agent-loop"
import {
  CALIBRATION_POLICIES,
  evaluateDraftGroundedness,
  evaluateEvidenceAnswerability,
  evaluateReferenceCorrectness,
  isAnswerabilitySufficient,
  runExperimentalEvidencePipeline,
  sanitizeSuggestedReformulation,
} from "../scripts/experimental-evidence-evaluator"

test("Experimental evaluator: answerability fail-closed JSON, groundedness vs syntax split, and calibration policies", async () => {
  const invalidJsonLlm = async () => ({
    text: "not-json",
    finishReason: "stop",
    usage: { prompt: 10, completion: 2, total: 12 },
  })
  const evBad = await evaluateEvidenceAnswerability({
    query: "What is the D01 document custodian?",
    chunks: [{ id: "c1", content: "Employee Handbook", metadata: {} }],
    callLlm: invalidJsonLlm,
  })
  assert.equal(evBad.verdict, "insufficient")
  assert.ok(evBad.parse_error)

  // Valid citation syntax ([Chunk 1]) does NOT imply claim-level support
  const syntaxValidUnsupported = await evaluateDraftGroundedness({
    query: "What is the D01 custodian and leave days?",
    draftAnswer: "The D01 custodian is HR Manager and annual paid leave is 25 days [Chunk 1].",
    chunks: [{ id: "c1", content: "D01 document custodian: HR Manager.", metadata: {} }],
    callLlm: async () => ({
      text: JSON.stringify({
        claims: [
          { claim: "The D01 custodian is HR Manager", cited_chunks: [1], supported: true, reason: "Explicit in Chunk 1" },
          { claim: "Annual paid leave is 25 days", cited_chunks: [1], supported: false, reason: "Not present in Chunk 1" },
        ],
      }),
      finishReason: "stop",
      usage: { prompt: 50, completion: 20, total: 70 },
    }),
  })
  assert.equal(syntaxValidUnsupported.syntax_valid, true)
  assert.equal(syntaxValidUnsupported.all_claims_supported, false)
  assert.equal(syntaxValidUnsupported.groundedness_rate, 0.5)
  assert.deepEqual(syntaxValidUnsupported.unsupported_claims, ["Annual paid leave is 25 days"])

  // Calibration policies distinguish partial verdicts
  assert.equal(isAnswerabilitySufficient({ verdict: "partial" }, CALIBRATION_POLICIES.strict_both), false)
  assert.equal(
    isAnswerabilitySufficient({ verdict: "partial" }, CALIBRATION_POLICIES.lenient_answerability_strict_grounding),
    true,
  )

  // Security: suggested reformulation must not introduce restricted D03/D11/D12 codes absent in query
  assert.equal(sanitizeSuggestedReformulation("What is leave notice?", "Check D03 compensation"), null)
  assert.equal(sanitizeSuggestedReformulation("What does D01 say about SLA?", "D01 service window operational hours"), "D01 service window operational hours")
})

test("Experimental pipeline: generation/grounding failure does not trigger Attempt 2; Attempt 2 recovery flags >6 steps", async () => {
  // Section 3.5: Evidence sufficient, draft has unsupported claim -> generation_grounding_failure (1 retrieval only!)
  let retrievalCalls = 0
  const groundingFailureRun = await runExperimentalEvidencePipeline({
    query: "Who is the D01 document custodian?",
    enterprise: true,
    policy: CALIBRATION_POLICIES.strict_both,
    retrieveForQuery: async () => {
      retrievalCalls++
      return {
        chunks: [{ id: "c1", content: "D01 custodian is HR Manager.", metadata: {} }],
        embedding_ms: 10,
        retrieval_ms: 15,
      }
    },
    callLlm: async ({ system }) => {
      if (system.includes("Answerability")) {
        return {
          text: JSON.stringify({
            verdict: "sufficient",
            missing_evidence: [],
            unanswered_parts: [],
            suggested_reformulation: null,
            rationale: "Custodian explicitly named.",
          }),
          finishReason: "stop",
          usage: { prompt: 20, completion: 10, total: 30 },
        }
      }
      if (system.includes("Groundedness")) {
        return {
          text: JSON.stringify({
            claims: [
              { claim: "HR Manager is custodian", cited_chunks: [1], supported: true, reason: "Supported" },
              { claim: "And approved 20 paid holidays", cited_chunks: [1], supported: false, reason: "Hallucinated" },
            ],
          }),
          finishReason: "stop",
          usage: { prompt: 30, completion: 15, total: 45 },
        }
      }
      return {
        text: "HR Manager is custodian and approved 20 paid holidays [Chunk 1].",
        finishReason: "stop",
        usage: { prompt: 25, completion: 12, total: 37 },
      }
    },
  })
  assert.equal(retrievalCalls, 1)
  assert.equal(groundingFailureRun.outcome, "generation_grounding_failure")
  assert.equal(groundingFailureRun.final_answer, ENTERPRISE_NO_EVIDENCE)
  assert.equal(groundingFailureRun.released_citations.length, 0)

  // Section 3.4 & 3.6: Attempt 1 insufficient -> Attempt 2 recovers -> flags > 6 step budget
  let attempt = 0
  const recoveryRun = await runExperimentalEvidencePipeline({
    query: "What is the office book borrowing cap?",
    enterprise: true,
    policy: CALIBRATION_POLICIES.strict_both,
    retrieveForQuery: async () => {
      attempt++
      return attempt === 1
        ? { chunks: [{ id: "c-miss", content: "Unrelated handbook intro.", metadata: {} }], embedding_ms: 10, retrieval_ms: 15 }
        : { chunks: [{ id: "c-hit", content: "Bluebird Bookshelf allows up to two books at a time.", metadata: {} }], embedding_ms: 10, retrieval_ms: 15 }
    },
    callLlm: async ({ system, user }) => {
      if (system.includes("Answerability")) {
        const hasHit = user.includes("two books at a time")
        return {
          text: JSON.stringify({
            verdict: hasHit ? "sufficient" : "insufficient",
            missing_evidence: hasHit ? [] : ["borrowing cap"],
            unanswered_parts: hasHit ? [] : ["book count"],
            suggested_reformulation: hasHit ? null : "Bluebird Bookshelf Book Exchange cap",
            rationale: hasHit ? "Cap present" : "Missing",
          }),
          finishReason: "stop",
          usage: { prompt: 20, completion: 10, total: 30 },
        }
      }
      if (system.includes("Groundedness")) {
        return {
          text: JSON.stringify({
            claims: [{ claim: "Up to two books at a time", cited_chunks: [1], supported: true, reason: "In Chunk 1" }],
          }),
          finishReason: "stop",
          usage: { prompt: 20, completion: 10, total: 30 },
        }
      }
      return {
        text: "You may borrow up to two books at a time [Chunk 1].",
        finishReason: "stop",
        usage: { prompt: 25, completion: 12, total: 37 },
      }
    },
  })
  assert.equal(recoveryRun.retrieval_attempts, 2)
  assert.equal(recoveryRun.recovered_on_second_attempt, true)
  assert.equal(recoveryRun.outcome, "supported_answer")
  assert.equal(recoveryRun.experimental_steps, 7)
  assert.equal(MAX_AGENT_STEPS, 6)
  assert.equal(recoveryRun.exceeded_6_step_budget, true)

  // Missing reference marks correctness as UNMEASURED
  const unmeasured = await evaluateReferenceCorrectness({
    query: "Any question",
    answer: "Answer [Chunk 1]",
    expectedBehavior: "answer",
    referenceAnswer: "",
    enterprise: true,
    callLlm: async () => ({ text: "{}", finishReason: "stop", usage: { prompt: 0, completion: 0, total: 0 } }),
  })
  assert.equal(unmeasured.status, "UNMEASURED")
  assert.equal(unmeasured.correct, null)
})
