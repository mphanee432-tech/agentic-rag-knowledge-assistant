import assert from "node:assert/strict"
import test from "node:test"
import { runBoundedRetrievalLoop, MAX_AGENT_STEPS, MAX_RETRIEVAL_ATTEMPTS } from "../lib/agent-loop"
import { evaluateEvidenceWithLlm } from "../lib/llm-agent"

const GENERIC_HR_POLICY = {
  id: "public-hr-guidance",
  content: "Employee Handbook: confidential HR files require HR approval and are handled under restricted access procedures. This handbook does not reproduce confidential HR documents.",
  metadata: {},
}
const HR_ACCESS_RULE = {
  id: "hr-access-policy",
  content: "D01 Employee Handbook: Confidential HR files are classified restricted. Employees request access through the HR Manager; access requires an explicit approval.",
  metadata: {},
}

function fakeDecision(
  nextAction: "answer" | "retry_retrieval" | "abstain",
  reformulatedQuery: string | null = null,
) {
  return {
    sufficient: nextAction === "answer",
    reason: nextAction === "answer" ? "direct_policy_answer" : "no_direct_document_evidence",
    nextAction,
    reformulatedQuery,
    clarificationQuestion: null,
  }
}

test("Enterprise restricted-content evaluator distinguishes generic access rules from document contents", async t => {
  const decisions = [
    fakeDecision("retry_retrieval", "HR confidential restricted document contents"),
    fakeDecision("abstain"),
  ]
  let decisionCalls = 0
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.equal(url.hostname, "generativelanguage.googleapis.com")
    assert.ok(url.pathname.endsWith(":generateContent"))
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      systemInstruction?: unknown
      contents?: unknown
      generationConfig?: { responseJsonSchema?: unknown }
    }
    const instruction = JSON.stringify(body.systemInstruction ?? "")
    assert.match(instruction, /CONTENT(S)? of confidential/i)
    assert.match(instruction, /Generic classification rules/)
    assert.match(instruction, /questions ABOUT access rules/)
    assert.match(instruction, /After the final attempt, abstain/)
    assert.ok(body.generationConfig?.responseJsonSchema)
    assert.ok(JSON.stringify(body.contents).includes("UNTRUSTED RETRIEVED EVIDENCE"))
    return Response.json({
      candidates: [{
        content: { role: "model", parts: [{ text: JSON.stringify(decisions[decisionCalls++]) }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, totalTokenCount: 60 },
    })
  })

  let retrievalCalls = 0
  const result = await runBoundedRetrievalLoop({
    userQuery: "Explain about HR confidential documents",
    retrieveForQuery: async () => {
      retrievalCalls++
      return [GENERIC_HR_POLICY]
    },
    decideAfterRetrieval: ({ userQuery, chunks, attempt, canRetry, previousQueries }) =>
      evaluateEvidenceWithLlm({
        modelId: "gemini-3.5-flash-lite",
        userQuery, chunks, attempt, canRetry, previousQueries,
        isEnterprise: true,
        signal: new AbortController().signal,
      }),
  })
  assert.equal(decisionCalls, 2)
  assert.equal(retrievalCalls, 2)
  assert.equal(result.finalDecision.nextAction, "abstain")
  assert.equal(result.agent.evidence_sufficient, false)
  assert.equal(result.agent.retrieval_attempts, MAX_RETRIEVAL_ATTEMPTS)
  assert.ok(result.agent.steps <= MAX_AGENT_STEPS)
  assert.deepEqual(result.agent.retrieval_steps?.map(step => step.decision), [
    "retry_retrieval", "abstain",
  ])
})

test("Enterprise evaluator can still answer an authorized question ABOUT HR access rules", async t => {
  let decisionCalls = 0
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.equal(url.hostname, "generativelanguage.googleapis.com")
    const body = JSON.parse(String(init?.body ?? "{}")) as { systemInstruction?: unknown }
    const instruction = JSON.stringify(body.systemInstruction ?? "")
    assert.match(instruction, /questions ABOUT access rules/)
    decisionCalls++
    return Response.json({
      candidates: [{
        content: { role: "model", parts: [{ text: JSON.stringify(fakeDecision("answer")) }] },
        finishReason: "STOP",
      }],
    })
  })
  let retrievalCalls = 0
  const result = await runBoundedRetrievalLoop({
    userQuery: "What is the documented procedure to request access to confidential HR files?",
    retrieveForQuery: async () => {
      retrievalCalls++
      return [HR_ACCESS_RULE]
    },
    decideAfterRetrieval: ({ userQuery, chunks, attempt, canRetry, previousQueries }) =>
      evaluateEvidenceWithLlm({
        modelId: "gemini-3.5-flash-lite",
        userQuery, chunks, attempt, canRetry, previousQueries,
        isEnterprise: true,
        signal: new AbortController().signal,
      }),
  })
  assert.equal(decisionCalls, 1)
  assert.equal(retrievalCalls, 1)
  assert.equal(result.finalDecision.nextAction, "answer")
  assert.equal(result.agent.retrieval_attempts, 1)
  assert.equal(result.agent.evidence_sufficient, true)
})

test("Enterprise evaluator does not apply Enterprise-specific rules to Personal RAG", async t => {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.equal(url.hostname, "generativelanguage.googleapis.com")
    const body = JSON.parse(String(init?.body ?? "{}")) as { systemInstruction?: unknown }
    const instruction = JSON.stringify(body.systemInstruction ?? "")
    assert.doesNotMatch(instruction, /questions ABOUT access rules/)
    return Response.json({
      candidates: [{
        content: { role: "model", parts: [{ text: JSON.stringify(fakeDecision("abstain")) }] },
        finishReason: "STOP",
      }],
    })
  })
  const decision = await evaluateEvidenceWithLlm({
    modelId: "gemini-3.5-flash-lite",
    userQuery: "Summarize an unavailable document",
    chunks: [GENERIC_HR_POLICY],
    attempt: 2,
    canRetry: false,
    previousQueries: ["unavailable document"],
    isEnterprise: false,
    signal: new AbortController().signal,
  })
  assert.equal(decision.nextAction, "abstain")
})
