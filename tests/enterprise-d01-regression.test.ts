import assert from "node:assert/strict"
import fs from "node:fs/promises"
import test from "node:test"
import { POST } from "../app/api/chat/route"
import { ENTERPRISE_NO_EVIDENCE } from "../lib/chat-contract"

const D01_OPENING_CHUNK = {
  id: "64ae9a95-cdac-49b1-8310-0a4218cd15a5",
  content: [
    "DECCANBRIDGE / EMPLOYEE KNOWLEDGE POLICY D01 • STANDARD",
    "# Employee Handbook",
    "| DOCUMENT CONTROL | APPROVED SCENARIO DETAILS |",
    "| :--- | :--- |",
    "| Document ID / version | D01 / Candidate 1.1 for independent review |",
    "| Classification / audience | Company-wide / Standard | All active employees |",
    "| Document custodian | HR Manager |",
    "| Independent reviewer | Operations Manager |",
    "| Scenario effective / next review | 1 November 2026 / 1 November 2027 |",
    "## 1. Purpose, applicability and how to use this handbook",
    "The handbook is a high-level entry point, not a substitute for a dedicated procedure. For detailed leave, equipment and travel/expense processing, employees should consult the corresponding company-wide Standard companion policies identified in Section 21.",
  ].join("\n"),
}

const UNRELATED_CHUNKS = [
  {
    id: "c4834229-e0b3-47eb-b930-28d589b56d42",
    content: "D04 — Engineering Code Review, Bug Reporting & Incident SOP",
  },
  {
    id: "76ae8610-6415-4071-b0c0-8af281e1c08d",
    content: "## 4. New-employee orientation\n\n## 5. Leave and attendance",
  },
]

function setTestEnv(t: test.TestContext) {
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: "https://chat-test.invalid",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon",
    SUPABASE_SERVICE_ROLE_KEY: "test-service",
    GOOGLE_GENERATIVE_AI_API_KEY: "test-google",
    CHAT_MODEL: "gemini-3.5-flash-lite",
  }
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test("WP9.43: E005, E006, and E008 succeed with cited D01 opening evidence and fail closed when absent or unauthorized", async (t) => {
  setTestEnv(t)
  const orgId = "c0000000-0000-4000-8000-000000000001"
  const engUserId = "efbba2a0-0987-49fc-8929-0189776ce477"

  const groundedCases = [
    {
      id: "E005",
      query: "When does D01 schedule its next review?",
      modelAnswer: "D01 schedules its next review on 1 November 2027 [Chunk 1].",
      expectedSubstring: "1 November 2027",
    },
    {
      id: "E006",
      query: "Is D01 intended to replace detailed leave, equipment, or expense policies?",
      modelAnswer:
        "No. D01 is a high-level entry point and not a substitute for dedicated procedures; employees should consult the corresponding companion policies for detailed leave, equipment, and travel/expense processing [Chunk 1].",
      expectedSubstring: "not a substitute",
    },
    {
      id: "E008",
      query: "Who is listed as custodian and independent reviewer for D01?",
      modelAnswer:
        "For D01, the document custodian is the HR Manager and the independent reviewer is the Operations Manager [Chunk 1].",
      expectedSubstring: "HR Manager",
    },
  ]

  for (const scenario of groundedCases) {
    await t.test(`${scenario.id}: returns grounded cited answer when D01 opening chunk is retrieved`, async (st) => {
      let visibilityChecked = false
      st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.hostname === "chat-test.invalid") {
          if (url.pathname === "/auth/v1/user") {
            return Response.json({ id: engUserId, aud: "authenticated", role: "authenticated" })
          }
          if (url.pathname === "/rest/v1/rpc/enterprise_copilot_context") {
            return Response.json({ organization_id: orgId, can_upload_policy: false })
          }
          if (url.pathname === "/rest/v1/rpc/search_enterprise_chunks") {
            return Response.json([D01_OPENING_CHUNK, ...UNRELATED_CHUNKS])
          }
          if (url.pathname === "/rest/v1/rpc/enterprise_chunks_still_visible") {
            visibilityChecked = true
            const body = JSON.parse(String(init?.body))
            assert.equal(body.chunk_ids[0], D01_OPENING_CHUNK.id)
            return Response.json(true)
          }
        }
        if (url.hostname === "generativelanguage.googleapis.com") {
          if (url.pathname.endsWith(":batchEmbedContents") || url.pathname.endsWith(":embedContent")) {
            return Response.json({ embeddings: [{ values: Array(1536).fill(0.1) }] })
          }
          if (url.pathname.endsWith(":generateContent")) {
            const reqBody = JSON.parse(String(init?.body)) as {
              tools?: unknown[]
              generationConfig?: { responseJsonSchema?: unknown }
              systemInstruction?: unknown
            }
            if (reqBody.tools) {
              return Response.json({
                candidates: [{
                  content: { role: "model", parts: [{ functionCall: { name: "rag_retrieval", args: { searchQuery: scenario.query } } }] },
                  finishReason: "STOP",
                }],
              })
            }
            if (reqBody.generationConfig?.responseJsonSchema) {
              return Response.json({
                candidates: [{
                  content: { role: "model", parts: [{ text: JSON.stringify({ sufficient: true, reason: "sufficient_evidence", nextAction: "answer", reformulatedQuery: null, clarificationQuestion: null }) }] },
                  finishReason: "STOP",
                }],
              })
            }
            const systemText = JSON.stringify(reqBody.systemInstruction ?? "")
            assert.ok(systemText.includes("1 November 2027"))
            assert.ok(systemText.includes("HR Manager"))
            return Response.json({
              candidates: [
                {
                  content: { role: "model", parts: [{ text: scenario.modelAnswer }] },
                  finishReason: "STOP",
                },
              ],
            })
          }
        }
        throw new Error(`Unexpected fetch: ${url.toString()}`)
      })

      const res = await POST(
        new Request("https://app.invalid/api/chat", {
          method: "POST",
          headers: { Authorization: "Bearer eng-token", "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId: orgId, query: scenario.query, stream: false }),
        }),
      )
      assert.equal(res.status, 200)
      const data = await res.json()
      assert.equal(visibilityChecked, true)
      assert.ok(data.text.includes(scenario.expectedSubstring))
      assert.equal(data.citations.length, 1)
      assert.equal(data.citations[0].id, D01_OPENING_CHUNK.id)
      assert.ok(data.context.includes(D01_OPENING_CHUNK.content))
    })
  }

  await t.test("missing D01 opening chunk triggers model refusal and clears context cleanly", async (st) => {
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname === "chat-test.invalid") {
        if (url.pathname === "/auth/v1/user") return Response.json({ id: engUserId, aud: "authenticated", role: "authenticated" })
        if (url.pathname === "/rest/v1/rpc/enterprise_copilot_context") return Response.json({ organization_id: orgId, can_upload_policy: false })
        if (url.pathname === "/rest/v1/rpc/search_enterprise_chunks") return Response.json(UNRELATED_CHUNKS)
      }
      if (url.hostname === "generativelanguage.googleapis.com") {
        if (url.pathname.endsWith(":batchEmbedContents") || url.pathname.endsWith(":embedContent")) {
          return Response.json({ embeddings: [{ values: Array(1536).fill(0.1) }] })
        }
        if (url.pathname.endsWith(":generateContent")) {
          const reqBody = JSON.parse(String(init?.body ?? "{}")) as {
            tools?: unknown[]
            generationConfig?: { responseJsonSchema?: unknown }
          }
          if (reqBody.tools) {
            return Response.json({
              candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "rag_retrieval", args: { searchQuery: "D01 next review" } } }] }, finishReason: "STOP" }],
            })
          }
          if (reqBody.generationConfig?.responseJsonSchema) {
            return Response.json({
              candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify({ sufficient: true, reason: "evaluate_answer", nextAction: "answer", reformulatedQuery: null, clarificationQuestion: null }) }] }, finishReason: "STOP" }],
            })
          }
          return Response.json({
            candidates: [{ content: { role: "model", parts: [{ text: ENTERPRISE_NO_EVIDENCE }] }, finishReason: "STOP" }],
          })
        }
      }
      throw new Error(`Unexpected fetch: ${url.toString()}`)
    })

    const res = await POST(
      new Request("https://app.invalid/api/chat", {
        method: "POST",
        headers: { Authorization: "Bearer eng-token", "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: orgId, query: "When does D01 schedule its next review?", stream: false }),
      }),
    )
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.text, ENTERPRISE_NO_EVIDENCE)
    assert.equal(data.context, "")
    assert.deepEqual(data.citations, [])
  })

  await t.test("inaccessible source (e.g. D07 under Engineering) returns empty retrieval and safe refusal without calling final answer LLM", async (st) => {
    let answerLlmCalled = false
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname === "chat-test.invalid") {
        if (url.pathname === "/auth/v1/user") return Response.json({ id: engUserId, aud: "authenticated", role: "authenticated" })
        if (url.pathname === "/rest/v1/rpc/enterprise_copilot_context") return Response.json({ organization_id: orgId, can_upload_policy: false })
        if (url.pathname === "/rest/v1/rpc/search_enterprise_chunks") return Response.json([])
        if (url.pathname === "/rest/v1/rpc/enterprise_fallback_documents") return Response.json([])
      }
      if (url.hostname === "generativelanguage.googleapis.com") {
        if (url.pathname.endsWith(":batchEmbedContents") || url.pathname.endsWith(":embedContent")) {
          return Response.json({ embeddings: [{ values: Array(1536).fill(0.1) }] })
        }
        if (url.pathname.endsWith(":generateContent")) {
          const reqBody = JSON.parse(String(init?.body ?? "{}")) as {
            tools?: unknown[]
            generationConfig?: { responseJsonSchema?: unknown }
          }
          if (reqBody.tools) {
            return Response.json({
              candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "rag_retrieval", args: { searchQuery: "D07 accessibility checks" } } }] }, finishReason: "STOP" }],
            })
          }
          if (reqBody.generationConfig?.responseJsonSchema) {
            return Response.json({
              candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify({ sufficient: false, reason: "no_chunks_retrieved", nextAction: "abstain", reformulatedQuery: null, clarificationQuestion: null }) }] }, finishReason: "STOP" }],
            })
          }
        }
        answerLlmCalled = true
      }
      throw new Error(`Unexpected fetch: ${url.toString()}`)
    })

    const res = await POST(
      new Request("https://app.invalid/api/chat", {
        method: "POST",
        headers: { Authorization: "Bearer eng-token", "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: orgId, query: "What accessibility checks does D07 discuss?", stream: false }),
      }),
    )
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(answerLlmCalled, false)
    assert.equal(data.text, ENTERPRISE_NO_EVIDENCE)
    assert.equal(data.context, "")
    assert.deepEqual(data.citations, [])
  })
})

test("WP9.43 proposed SQL migration preserves RLS, policy-ID opening boost, and Personal RAG OR-keyword compatibility", async () => {
  const sql = await fs.readFile(
    new URL("../supabase/migrations/20261117133000_wp9_43_restore_enterprise_policy_id_and_keyword_search.sql", import.meta.url),
    "utf8",
  )
  assert.match(sql, /^begin;/i)
  assert.match(sql, /commit;\s*$/i)
  assert.match(sql, /grant create on schema wp3_private to wp3_retrieval/i)
  assert.match(sql, /create or replace function wp3_private\.search_chunks\(\s*query_embedding extensions\.vector,\s*query_text text,\s*target_project_id uuid,\s*target_organization_id uuid\s*\)\s*returns table \(id uuid, content text\)\s*language sql stable security definer\s*set search_path = pg_catalog, pg_temp\s*set row_security = on\s*as \$\$/i)
  assert.equal(sql.match(/\$\$/g)?.length, 2, "Function body must have matching dollar quotes")
  assert.match(sql, /as \$\$\s*with raw_eligible as materialized \(\s*select/i)
  assert.match(sql, /case\s*when target_organization_id is not null\s*and left\(c\.content, 800\)/i)
  assert.match(sql, /end as opening_policy_id\s*from public\.document_chunks c/i)
  assert.match(sql, /set row_security = on/i)
  assert.match(sql, /row_security_active\('public\.document_chunks'\)/i)
  assert.match(sql, /requested_policies as \(/i)
  assert.match(sql, /is_opening_chunk/i)
  assert.match(sql, /coalesce\(o\.bonus, 0\) desc/i)
  assert.match(sql, /target_organization_id is null/i)
  assert.match(sql, /to_tsquery\('simple', string_agg\(quote_literal\(word\), ' \| '/i)
  assert.match(sql, /alter function wp3_private\.search_chunks.*owner to wp3_retrieval/i)
  assert.match(sql, /revoke create on schema wp3_private from wp3_retrieval/i)
  assert.match(sql, /revoke all on function wp3_private\.search_chunks\(extensions\.vector, text, uuid, uuid\)\s*from public, anon, authenticated, service_role/i)
  assert.match(sql, /grant execute on function wp3_private\.search_chunks\(extensions\.vector, text, uuid, uuid\) to session_user/i)
})

