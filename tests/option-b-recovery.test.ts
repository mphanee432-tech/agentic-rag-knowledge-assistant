import assert from "node:assert/strict"
import test from "node:test"
import { POST as chatPost } from "../app/api/chat/route"
import {
  evaluateRetrievedEvidence,
  MAX_AGENT_STEPS,
  MAX_RETRIEVAL_ATTEMPTS,
  reformulateRetrievalQuery,
  runBoundedRetrievalLoop,
} from "../lib/agent-loop"
import { ENTERPRISE_NO_EVIDENCE, NO_EVIDENCE } from "../lib/chat-contract"

const ORG_ID = "c0000000-0000-4000-8000-000000000001"
const PROJECT_ID = "3c7605fb-9ab8-4931-854c-9ccb3cc8077a"

function setupEnv(t: test.TestContext) {
  const env = {
    NEXT_PUBLIC_PERSONAL_SUPABASE_URL: "https://personal-recovery.invalid",
    NEXT_PUBLIC_PERSONAL_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_personal_recovery",
    PERSONAL_SUPABASE_SECRET_KEY: "sb_secret_personal_recovery",
    NEXT_PUBLIC_ENTERPRISE_SUPABASE_URL: "https://enterprise-recovery.invalid",
    NEXT_PUBLIC_ENTERPRISE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_enterprise_recovery",
    ENTERPRISE_SUPABASE_SECRET_KEY: "sb_secret_enterprise_recovery",
    GOOGLE_GENERATIVE_AI_API_KEY: "test-google-key",
  }
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

test("Controlled Recovery & Safety: Personal and Enterprise first-miss -> second-hit, exhaustion abstention, and bounds", async (t) => {
  setupEnv(t)

  await t.test("Test 1A (Personal): Attempt 1 non-answer miss -> insufficient -> reformulated Attempt 2 hit -> cited answer <= 6 steps", async (st) => {
    const missId = "11111111-1111-4111-8111-111111111111"
    const hitId = "38a01af9-01da-4e13-a7b3-2d75715422c6"
    let rpcCalls = 0
    let genCalls = 0
    let persistedPayload: Record<string, unknown> | null = null
    const seenQueries: string[] = []

    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const authHeader = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization")
      if (url.hostname === "generativelanguage.googleapis.com") {
        if (url.pathname.endsWith(":batchEmbedContents") || url.pathname.endsWith(":embedContent")) {
          return Response.json({ embeddings: [{ values: Array(1536).fill(0.1) }] })
        }
        if (url.pathname.endsWith(":generateContent")) {
          const reqJson = JSON.parse(String(init?.body)) as {
            tools?: unknown[]
            generationConfig?: { responseJsonSchema?: unknown }
            systemInstruction?: unknown
          }
          if (reqJson.tools) {
            return Response.json({
              candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "rag_retrieval", args: { searchQuery: "avoid Kafka small chunks" } } }] }, finishReason: "STOP" }],
            })
          }
          if (reqJson.generationConfig?.responseJsonSchema) {
            return Response.json({
              candidates: [{
                content: {
                  role: "model",
                  parts: [{
                    text: JSON.stringify(
                      rpcCalls === 1
                        ? { sufficient: false, reason: "zero_keyword_overlap", nextAction: "retry_retrieval", reformulatedQuery: "Kafka Kubernetes fewer than 10000 chunks", clarificationQuestion: null }
                        : { sufficient: true, reason: "sufficient_evidence", nextAction: "answer", reformulatedQuery: null, clarificationQuestion: null },
                    ),
                  }],
                },
                finishReason: "STOP",
              }],
            })
          }
          genCalls++
          const sysText = JSON.stringify(reqJson.systemInstruction ?? "")
          assert.match(sysText, /below 10,000 chunks/)
          return Response.json({
            candidates: [{
              content: { role: "model", parts: [{ text: "Avoid Kafka and Kubernetes below 10,000 chunks [Chunk 1]." }] },
              finishReason: "STOP",
            }],
            usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 15, totalTokenCount: 135 },
          })
        }
      }
      if (url.pathname === "/auth/v1/user") {
        assert.equal(authHeader, "Bearer personal-user-token")
        return Response.json({ id: "personal-owner-1", role: "authenticated" })
      }
      if (url.pathname.startsWith("/rest/v1/projects")) {
        return Response.json([{ id: PROJECT_ID }])
      }
      if (url.pathname === "/rest/v1/rpc/search_rag_chunks") {
        rpcCalls++
        const body = JSON.parse(String(init?.body))
        seenQueries.push(body.query_text)
        assert.equal(authHeader, "Bearer personal-user-token")
        return Response.json(rpcCalls === 1 ? [{ id: missId }] : [{ id: hitId }])
      }
      if (url.pathname === "/rest/v1/document_chunks") {
        return Response.json(
          rpcCalls === 1
            ? [{ id: missId, content: "General hosting deployment guide for Postgres backups.", metadata: {} }]
            : [{ id: hitId, content: "Deliberately avoid Kafka and Kubernetes below 10,000 chunks.", metadata: { filename: "Production_RAG_Architecture_Considerations.pdf" } }],
        )
      }
      if (url.pathname === "/rest/v1/interactions") {
        persistedPayload = JSON.parse(String(init?.body))
        return Response.json([], { status: 201 })
      }
      assert.fail(`Unexpected URL: ${url.href}`)
    })

    const query = "When should we avoid Kafka for small chunks?"
    const preEvMiss = evaluateRetrievedEvidence(query, [{ id: missId, content: "General hosting deployment guide for Postgres backups.", metadata: {} }])
    assert.equal(preEvMiss.sufficient, false)
    assert.equal(preEvMiss.reason, "zero_keyword_overlap")

    const res = await chatPost(new Request("https://app.invalid/api/chat", {
      method: "POST",
      headers: { Authorization: "Bearer personal-user-token", "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: PROJECT_ID, query, stream: false }),
    }))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(rpcCalls, 2)
    assert.equal(genCalls, 1)
    assert.notEqual(seenQueries[0], seenQueries[1])
    assert.equal(body.metrics.agent.retrieval_attempts, 2)
    assert.equal(body.metrics.agent.reformulated, true)
    assert.equal(body.metrics.agent.evidence_sufficient, true)
    assert.ok(body.metrics.agent.steps <= MAX_AGENT_STEPS)
    assert.equal(body.citations[0].id, hitId)
    assert.match(body.text, /\[Chunk 1\]/)
    assert.ok(persistedPayload)
  })

  await t.test("Test 1B (Enterprise): Preserves authenticated user token & RLS across Attempt 1 miss -> Attempt 2 hit recovery", async (st) => {
    const missId = "22222222-2222-4222-8222-222222222222"
    const hitId = "1507d502-a979-4a84-aa9d-08fa31c0d47f"
    let rpcCalls = 0
    let genCalls = 0
    const seenQueries: string[] = []
    const seenAuthHeaders: Array<string | null> = []

    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const authHeader = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization")
      if (url.hostname === "generativelanguage.googleapis.com") {
        if (url.pathname.endsWith(":batchEmbedContents") || url.pathname.endsWith(":embedContent")) {
          return Response.json({ embeddings: [{ values: Array(1536).fill(0.1) }] })
        }
        if (url.pathname.endsWith(":generateContent")) {
          const reqJson = JSON.parse(String(init?.body)) as {
            tools?: unknown[]
            generationConfig?: { responseJsonSchema?: unknown }
            systemInstruction?: unknown
          }
          if (reqJson.tools) {
            return Response.json({
              candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "rag_retrieval", args: { searchQuery: "office bookshelf cap" } } }] }, finishReason: "STOP" }],
            })
          }
          if (reqJson.generationConfig?.responseJsonSchema) {
            return Response.json({
              candidates: [{
                content: {
                  role: "model",
                  parts: [{
                    text: JSON.stringify(
                      rpcCalls === 1
                        ? { sufficient: false, reason: "zero_keyword_overlap", nextAction: "retry_retrieval", reformulatedQuery: "Bluebird Bookshelf Book Exchange borrow limit", clarificationQuestion: null }
                        : { sufficient: true, reason: "sufficient_evidence", nextAction: "answer", reformulatedQuery: null, clarificationQuestion: null },
                    ),
                  }],
                },
                finishReason: "STOP",
              }],
            })
          }
          genCalls++
          const sysText = JSON.stringify(reqJson.systemInstruction ?? "")
          assert.match(sysText, /Bluebird Bookshelf.*two books/i)
          return Response.json({
            candidates: [{
              content: { role: "model", parts: [{ text: "Employees may borrow up to two books at a time from Bluebird Bookshelf [Chunk 1]." }] },
              finishReason: "STOP",
            }],
            usageMetadata: { promptTokenCount: 110, candidatesTokenCount: 16, totalTokenCount: 126 },
          })
        }
      }
      if (url.pathname === "/auth/v1/user") {
        assert.equal(authHeader, "Bearer enterprise-user-token")
        return Response.json({ id: "ent-user-1", role: "authenticated" })
      }
      if (url.pathname === "/rest/v1/rpc/enterprise_copilot_context") {
        assert.equal(authHeader, "Bearer enterprise-user-token")
        return Response.json([{ organization_id: ORG_ID, can_upload_policy: false }])
      }
      if (url.pathname === "/rest/v1/demo_jira_access") return Response.json({ enabled: false })
      if (url.pathname === "/rest/v1/rpc/enterprise_account_status") return Response.json([{ organization_id: ORG_ID, role: "employee", is_active: true }])
      if (url.pathname === "/rest/v1/rpc/search_enterprise_chunks") {
        rpcCalls++
        seenAuthHeaders.push(authHeader)
        const body = JSON.parse(String(init?.body))
        seenQueries.push(body.query_text)
        assert.equal(body.target_organization_id, ORG_ID)
        if (rpcCalls === 1) {
          return Response.json([{ id: missId, content: "Unrelated notice about annual leave windows and holiday calendar." }])
        }
        assert.match(body.query_text, /Bluebird Bookshelf Book Exchange/i)
        return Response.json([{ id: hitId, content: "Bluebird Bookshelf permits borrowing up to two books at a time." }])
      }
      if (url.pathname === "/rest/v1/rpc/enterprise_chunks_still_visible") {
        assert.equal(authHeader, "Bearer enterprise-user-token")
        assert.deepEqual(JSON.parse(String(init?.body)).chunk_ids, [hitId, missId])
        return Response.json(true)
      }
      assert.fail(`Unexpected URL: ${url.href}`)
    })

    const query = "What is the office bookshelf cap?"
    const res = await chatPost(new Request("https://app.invalid/api/chat", {
      method: "POST",
      headers: { Authorization: "Bearer enterprise-user-token", "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: ORG_ID, query, stream: false }),
    }))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(rpcCalls, 2)
    assert.equal(genCalls, 1)
    assert.deepEqual(seenAuthHeaders, ["Bearer enterprise-user-token", "Bearer enterprise-user-token"])
    assert.notEqual(seenQueries[0], seenQueries[1])
    assert.equal(body.metrics.agent.retrieval_attempts, 2)
    assert.equal(body.metrics.agent.reformulated, true)
    assert.equal(body.metrics.agent.evidence_sufficient, true)
    assert.ok(body.metrics.agent.steps <= MAX_AGENT_STEPS)
    assert.equal(body.citations[0].id, hitId)
    assert.match(body.text, /\[Chunk 1\]/)
  })

  await t.test("Test 1C & 3: Exhausting both attempts abstains safely without 3rd retrieval; sufficient Attempt 1 skips retry", async (st) => {
    // 1) Exhaustion abstention in Personal RAG (non-answer chunks on both Attempt 1 and Attempt 2)
    let personalRpcCalls = 0
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname === "generativelanguage.googleapis.com") {
        if (url.pathname.endsWith(":batchEmbedContents") || url.pathname.endsWith(":embedContent")) {
          return Response.json({ embeddings: [{ values: Array(1536).fill(0.1) }] })
        }
        if (url.pathname.endsWith(":generateContent")) {
          const reqJson = JSON.parse(String(init?.body ?? "{}")) as {
            tools?: unknown[]
            generationConfig?: { responseJsonSchema?: unknown }
          }
          if (reqJson.tools) {
            return Response.json({
              candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "rag_retrieval", args: { searchQuery: "unknown quantum limit" } } }] }, finishReason: "STOP" }],
            })
          }
          if (reqJson.generationConfig?.responseJsonSchema) {
            return Response.json({
              candidates: [{
                content: {
                  role: "model",
                  parts: [{
                    text: JSON.stringify(
                      personalRpcCalls === 1
                        ? { sufficient: false, reason: "insufficient_evidence", nextAction: "retry_retrieval", reformulatedQuery: "quantum limit threshold", clarificationQuestion: null }
                        : { sufficient: false, reason: "insufficient_after_retries", nextAction: "abstain", reformulatedQuery: null, clarificationQuestion: null },
                    ),
                  }],
                },
                finishReason: "STOP",
              }],
            })
          }
          assert.fail("Final answer generation must not run when evaluator abstains")
        }
      }
      if (url.pathname === "/auth/v1/user") return Response.json({ id: "personal-owner-1", role: "authenticated" })
      if (url.pathname.startsWith("/rest/v1/projects")) return Response.json([{ id: PROJECT_ID }])
      if (url.pathname === "/rest/v1/rpc/search_rag_chunks") {
        personalRpcCalls++
        assert.ok(personalRpcCalls <= MAX_RETRIEVAL_ATTEMPTS, "Must never execute a 3rd retrieval")
        return Response.json([{ id: `00000000-0000-4000-8000-00000000000${personalRpcCalls}` }])
      }
      if (url.pathname === "/rest/v1/document_chunks") {
        return Response.json([{ id: `00000000-0000-4000-8000-00000000000${personalRpcCalls}`, content: "Unrelated text.", metadata: {} }])
      }
      if (url.pathname === "/rest/v1/interactions") return Response.json([], { status: 201 })
      assert.fail(`Unexpected URL: ${url.href}`)
    })

    const perExhaust = await chatPost(new Request("https://app.invalid/api/chat", {
      method: "POST",
      headers: { Authorization: "Bearer personal-user-token", "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: PROJECT_ID, query: "What is the unknown quantum limit?", stream: false }),
    }))
    assert.equal(perExhaust.status, 200)
    const perBody = await perExhaust.json()
    assert.equal(perBody.text, NO_EVIDENCE)
    assert.equal(personalRpcCalls, 2)
    assert.equal(perBody.metrics.agent.retrieval_attempts, 2)
    assert.equal(perBody.metrics.agent.evidence_sufficient, false)
    assert.ok(perBody.metrics.agent.steps <= MAX_AGENT_STEPS)

    // 2) Enterprise empty-both-attempts & sufficient Attempt 1 skips retry + maxAttempts cap check
    let entCalls = 0
    const suffLoop = await runBoundedRetrievalLoop({
      userQuery: "What is the D01 document custodian?",
      retrieveForQuery: async () => {
        entCalls++
        return [{ id: "c1", content: "D01 document custodian is HR Manager.", metadata: {} }]
      },
      maxAttempts: 10, // Even if caller passes > 2, loop hard-caps at MAX_RETRIEVAL_ATTEMPTS = 2
    })
    assert.equal(entCalls, 1)
    assert.equal(suffLoop.agent.retrieval_attempts, 1)
    assert.equal(suffLoop.agent.reformulated, false)
    assert.equal(suffLoop.agent.max_retrieval_attempts, MAX_RETRIEVAL_ATTEMPTS)
    assert.equal(suffLoop.agent.max_steps, MAX_AGENT_STEPS)

    let capCalls = 0
    const capLoop = await runBoundedRetrievalLoop({
      userQuery: "What does D03 say about executive compensation?",
      retrieveForQuery: async () => {
        capCalls++
        return []
      },
      maxAttempts: 10,
    })
    assert.equal(capCalls, 2)
    assert.equal(capLoop.agent.retrieval_attempts, 2)
    assert.equal(capLoop.agent.steps, 5)
    assert.equal(reformulateRetrievalQuery("What does D03 say?"), null)
    assert.equal(reformulateRetrievalQuery("What does D03 policy say?"), "d03 policy")
    assert.equal(ENTERPRISE_NO_EVIDENCE, "I don't know based on the documents I can access.")
  })
})
