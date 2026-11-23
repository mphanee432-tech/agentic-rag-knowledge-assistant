import assert from "node:assert/strict"
import test from "node:test"
import { POST as chatPost } from "../app/api/chat/route"
import { AMBIGUOUS_CONFIDENTIAL_HR_CLARIFICATION, getDeterministicIntent, isAmbiguousConfidentialHrDocumentRequest } from "../lib/chat-input"
import { readChatStream, type ChatEvent } from "../lib/chat-contract"

const ORG_ID = "c0000000-0000-4000-8000-000000000001"

function stubAuth(t: test.TestContext) {
  const env = {
    NEXT_PUBLIC_ENTERPRISE_SUPABASE_URL: "https://enterprise-confidential-clarification.invalid",
    NEXT_PUBLIC_ENTERPRISE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_enterprise_clarification",
    ENTERPRISE_SUPABASE_SECRET_KEY: "sb_secret_enterprise_clarification",
  }
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [k, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[k]
      else process.env[k] = value
    }
  })
  let lookups = 0
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/auth/v1/user") {
      lookups++
      return Response.json({ id: "engineering-employee", role: "authenticated" })
    }
    if (url.pathname === "/rest/v1/rpc/enterprise_copilot_context") {
      return Response.json([{ organization_id: ORG_ID, can_upload_policy: false }])
    }
    assert.fail("Ambiguous-document clarification must not call LLM, retrieval, or Jira: " + url.toString())
  })
  return { authorizedLookups: () => lookups }
}

test("Confidential HR document ambiguity guard is narrow and Enterprise-scoped", () => {
  for (const query of [
    "explain about hr confidential document",
    "tell me about confidential hr documents",
    "Summarize the restricted human resources files",
  ]) {
    assert.equal(isAmbiguousConfidentialHrDocumentRequest(query), true, query)
    assert.equal(getDeterministicIntent(query, true), "sensitive_document_clarification", query)
    assert.equal(getDeterministicIntent(query), null, "Personal RAG must not be intercepted")
  }
  for (const query of [
    "What are the rules for accessing confidential HR documents?",
    "How can I request access to confidential HR files?",
    "Explain the confidential HR payroll document",
    "Explain confidential HR document D03",
    "Summarize D11 confidential budget approval",
    "What does the HR confidential document say about leave?",
    "Describe the HR policy for handling confidential records",
  ]) {
    assert.equal(isAmbiguousConfidentialHrDocumentRequest(query), false, query)
    assert.equal(getDeterministicIntent(query, true), null, query)
  }
})

test("Enterprise ambiguous HR document JSON asks for identification without retrieval", async t => {
  const mock = stubAuth(t)
  const res = await chatPost(new Request("https://app.invalid/api/chat", {
    method: "POST",
    headers: { Authorization: "Bearer ent-token", "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId: ORG_ID, query: "explain about hr confidential document", stream: false }),
  }))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.text, AMBIGUOUS_CONFIDENTIAL_HR_CLARIFICATION)
  assert.equal(body.metrics.agent.next_action, "clarify")
  assert.equal(body.metrics.agent.final_outcome, "clarify")
  assert.equal(body.metrics.agent.evidence_sufficient, false)
  assert.equal(body.metrics.agent.retrieval_attempts, 0)
  assert.equal(body.metrics.retrieved_chunk_count, 0)
  assert.deepEqual(body.citations, [])
  assert.ok(mock.authorizedLookups() > 0)
})

test("Enterprise ambiguous HR document SSE shows clarification, not answer or abstention", async t => {
  const mock = stubAuth(t)
  const res = await chatPost(new Request("https://app.invalid/api/chat", {
    method: "POST",
    headers: { Authorization: "Bearer ent-token", "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId: ORG_ID, query: "tell me about confidential hr documents", stream: true }),
  }))
  assert.equal(res.status, 200)
  const events: ChatEvent[] = []
  await readChatStream(res, event => events.push(event))
  assert.equal(events.filter(e => e.type === "text").map(e => e.type === "text" ? e.text : "").join(""), AMBIGUOUS_CONFIDENTIAL_HR_CLARIFICATION)
  const final = events.find(e => e.type === "agent_step" && e.step.phase === "final_decision")
  assert.ok(final && final.type === "agent_step")
  assert.equal(final.step.outcome, "clarify")
  const finished = events.find(e => e.type === "finish")
  assert.ok(finished && finished.type === "finish")
  assert.equal((finished.metrics.agent as { final_outcome: string }).final_outcome, "clarify")
  assert.ok(mock.authorizedLookups() > 0)
})
