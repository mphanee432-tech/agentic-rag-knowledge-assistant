import test from "node:test"
import assert from "node:assert/strict"
import { eligibleConversation, requestsPermissionChange } from "../lib/chat-input"
import { runBoundedRetrievalLoop } from "../lib/agent-loop"

test("access administration commands and ordinary policy questions remain distinct", () => {
  for (const q of ["Please give my account access to payroll", "Could you promote me to administrator?", "Make me an owner"]) {
    assert.equal(requestsPermissionChange(q), true)
    assert.equal(eligibleConversation(q), null)
  }
  for (const q of ["Who can grant access?", "How do I change my permissions?", "Open a Jira ticket about access"]) {
    assert.equal(requestsPermissionChange(q), false)
    assert.equal(eligibleConversation(q), null)
  }
  assert.equal(eligibleConversation("Who are you?"), "identity")
  assert.equal(eligibleConversation("What can you do?"), "capability")
  assert.equal(eligibleConversation("Who are you and what does the policy say?"), null)
})

test("recoverable partial evidence survives a full retry result set", async () => {
  const chunk = (id: string) => ({ id, content: id, metadata: {} })
  const result = await runBoundedRetrievalLoop({
    userQuery: "Compare retention and notice",
    retrieveForQuery: async q => q === "notice period" ? Array.from({ length: 8 }, (_, i) => chunk("notice" + i)) : [chunk("retention")],
    decideAfterRetrieval: async ({ attempt, chunks }) => {
      if (attempt === 1) return { nextAction: "abstain", sufficient: false, evidenceQuality: "partial", supportingChunkIndices: [1], reason: "missing_notice", reformulatedQuery: "notice period" }
      assert.equal(chunks.length, 8)
      assert.ok(chunks.some(c => c.id === "retention"))
      assert.ok(chunks.some(c => c.id === "notice0"))
      return { nextAction: "answer", sufficient: true, evidenceQuality: "sufficient", supportingChunkIndices: [1,2], reason: "complete", reformulatedQuery: null }
    },
  })
  assert.equal(result.finalDecision.nextAction, "answer")
  assert.equal(result.agent.retrieval_attempts, 2)
})

test("an ineligible LLM capability shortcut falls back to the original policy question", async t => {
  const { selectAgentToolWithLlm } = await import("../lib/llm-agent")
  const previous = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "unit-test"
  t.after(() => {
    if (previous === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = previous
  })
  t.mock.method(globalThis, "fetch", async () => Response.json({
    candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "deterministic_reply", args: { intent: "capability" } } }] }, finishReason: "STOP" }],
  }))
  const userQuery = "What can you do under the access review policy?"
  const { decision } = await selectAgentToolWithLlm({
    modelId: "test", userQuery, isEnterprise: false, jiraAccessAvailable: false, signal: new AbortController().signal,
  })
  assert.deepEqual(decision, { tool: "rag_retrieval", searchQuery: userQuery, requiresConfirmation: false })
})
