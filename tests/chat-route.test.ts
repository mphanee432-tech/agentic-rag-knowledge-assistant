import assert from "node:assert/strict"
import test from "node:test"
import { POST } from "../app/api/chat/route"
import { ENTERPRISE_NO_EVIDENCE, MAX_ANSWER_CHARS, NO_EVIDENCE, readChatStream, type ChatEvent } from "../lib/chat-contract"

test("chat only persists and completes verified answers in JSON and SSE modes", async t => {
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: "https://chat-test.invalid",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon",
    SUPABASE_SERVICE_ROLE_KEY: "test-service",
    GOOGLE_GENERATIVE_AI_API_KEY: "test-google",
    CHAT_MODEL: "gemini-3.1-flash-lite",
  }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  t.mock.method(console, "error", () => {})
  const projectId = "11111111-1111-4111-8111-111111111111"
  const userId = "22222222-2222-4222-8222-222222222222"
  const valid = "Supported answer [Chunk 1, Chunk 2]."
  const cases = [
    { name: "valid grouped references", text: valid, ok: true },
    { name: "unknown reference", text: "Answer [Chunk 1, Chunk 99].", ok: false },
    { name: "missing reference", text: "Uncited answer.", ok: false },
    { name: "malformed reference", text: "Answer [Chunk 1] [Chunk banana]", ok: false },
    { name: "cut-off reference", text: "Answer [Chunk 1] [Chunk 2", ok: false },
    { name: "empty generation", text: "", ok: false },
    { name: "character limit", text: valid + "x".repeat(MAX_ANSWER_CHARS), ok: false },
    { name: "provider token limit", text: valid, finishReason: "MAX_TOKENS", ok: false },
    { name: "exact refusal", text: NO_EVIDENCE, ok: true },
    { name: "empty retrieval", text: NO_EVIDENCE, emptyRetrieval: true, ok: true },
    { name: "persistence failure", text: valid, persistError: true, ok: false },
    { name: "evaluation context uses a finish event", text: valid, evalStream: true, ok: true },
  ]
  for (const stream of [false, true]) {
    for (const scenario of cases) {
      if (scenario.evalStream && !stream) continue
      await t.test(`${stream ? "SSE" : "JSON"}: ${scenario.name}`, async st => {
        const saved: Array<{ response_markdown: string }> = []
        const unexpected: string[] = []
        let generations = 0
        let authCalls = 0
        let projectChecks = 0
        st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : String(input))
          if (url.hostname === "chat-test.invalid") {
            switch (url.pathname) {
              case "/auth/v1/user":
                authCalls++
                assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token")
                return Response.json({ id: userId, aud: "authenticated", role: "authenticated" })
              case "/rest/v1/projects":
                projectChecks++
                assert.equal(url.searchParams.get("id"), `eq.${projectId}`)
                assert.equal(url.searchParams.get("user_id"), `eq.${userId}`)
                return Response.json([{ id: projectId, user_id: userId, name: "Owned" }])
              case "/rest/v1/rpc/search_rag_chunks":
                assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token")
                assert.equal(url.searchParams.get("select"), "id")
                return Response.json(scenario.emptyRetrieval ? [] : [{ id: "chunk-a" }, { id: "chunk-b" }])
              case "/rest/v1/document_chunks":
                assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token")
                assert.equal(url.searchParams.get("project_id"), `eq.${projectId}`)
                assert.equal(url.searchParams.get("documents.status"), "eq.indexed")
                return Response.json(["chunk-a", "chunk-b"].map(id => ({ id, content: "Evidence", metadata: {} })))
              case "/rest/v1/interactions": {
                const row = JSON.parse(String(init?.body))
                assert.equal(init?.method, "POST")
                assert.deepEqual(row, {
                  id: row.id, project_id: projectId, user_id: userId, query_text: "Question",
                  retrieved_chunk_ids: scenario.emptyRetrieval ? [] : ["chunk-a", "chunk-b"],
                  response_markdown: scenario.text, latency_ms: row.latency_ms,
                })
                assert.match(row.id, /^[0-9a-f-]{36}$/i)
                assert.ok(Number.isInteger(row.latency_ms) && row.latency_ms >= 0)
                if (scenario.persistError) return Response.json({ message: "Persistence failed" }, { status: 400 })
                saved.push(row)
                return new Response(null, { status: 201 })
              }
            }
          }
          if (url.hostname === "generativelanguage.googleapis.com") {
            if (url.pathname.endsWith(":batchEmbedContents")) {
              return Response.json({ embeddings: [{ values: Array(1536).fill(0.1) }] })
            }
            if (url.pathname.endsWith(":generateContent") || url.pathname.endsWith(":streamGenerateContent")) {
              generations++
              const parts = stream ? [scenario.text.slice(0, -3), scenario.text.slice(-3)] : [scenario.text]
              const responses = parts.map((text, i) => ({
                candidates: [{ index: 0, content: { role: "model", parts: [{ text }] },
                  ...(i === parts.length - 1 ? { finishReason: scenario.finishReason || "STOP" } : {}) }],
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 },
              }))
              return stream
                ? new Response(responses.map(body => `data: ${JSON.stringify(body)}\n\n`).join(""), {
                    headers: { "Content-Type": "text/event-stream" },
                  })
                : Response.json(responses[0])
            }
          }
          unexpected.push(url.href)
          throw new Error("Unexpected request: " + url.href)
        })
        const response = await POST(new Request("https://app.invalid/api/chat", {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test-token",
            ...(scenario.evalStream ? { "x-eval-mode": "true" } : {}) },
          body: JSON.stringify({ projectId, query: "Question", stream, user_id: "33333333-3333-4333-8333-333333333333" }),
        }))
        if (stream) {
          assert.equal(response.status, 200)
          assert.equal(response.headers.get("content-type"), "text/event-stream")
          const wire = response.clone().text()
          const events: ChatEvent[] = []
          const reading = readChatStream(response, event => events.push(event))
          if (scenario.ok) await reading
          else await assert.rejects(reading, /could not be completed/)
          assert.equal(events[0]?.type, "metadata")
          assert.equal(events.some(event => event.type === "finish"), scenario.ok)
          if (scenario.ok) {
            assert.equal(events.filter(event => event.type === "text").map(event => event.text).join(""), scenario.text)
            const finish = events.find(event => event.type === "finish")
            assert.ok(finish?.type === "finish")
            assert.equal(typeof finish.metrics, "object")
            assert.equal(typeof finish.context, scenario.evalStream ? "string" : "undefined")
            if (scenario.evalStream) assert.match(finish.context!, /Evidence/)
          }
          const frames = (await wire).split("\n\n")
          assert.equal(frames.pop(), "")
          const wireEvents = frames.map(frame => {
            assert.ok(frame.startsWith("data: "))
            return JSON.parse(frame.slice(6)) as ChatEvent
          })
          assert.ok(!wireEvents.some(event => event.type === "text" && /Chunk (?:99|banana)/.test(event.text)))
          assert.equal(wireEvents.at(-1)?.type, scenario.ok ? "finish" : "error")
          assert.ok(!JSON.stringify(wireEvents).includes("rag-telemetry"))
        } else {
          assert.equal(response.status, scenario.ok ? 200 : 500)
          const body = await response.json()
          if (scenario.ok) assert.equal(body.text, scenario.text)
          else assert.equal(body.text, undefined)
        }
        assert.deepEqual(unexpected, [])
        assert.equal(authCalls, 1)
        assert.equal(projectChecks, 1)
        assert.equal(generations, scenario.emptyRetrieval ? 0 : 1)
        assert.deepEqual(saved.map(row => row.response_markdown), scenario.ok ? [scenario.text] : [])
      })
    }
  }
})

test("organization chat releases only freshly authorized, cited evidence", async t => {
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: "https://enterprise-test.invalid",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon",
    GOOGLE_GENERATIVE_AI_API_KEY: "test-google",
  }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const organizationId = "11111111-1111-4111-8111-111111111111"
  const userId = "22222222-2222-4222-8222-222222222222"
  const chunkId = "33333333-3333-4333-8333-333333333333"
  const cases = [
    { name: "authorized SSE", stream: true, answer: "Use the documented setting [Chunk 1]." },
    { name: "authorized JSON", stream: false, answer: "Use the documented setting [Chunk 1]." },
    { name: "revoked before SSE release", stream: true, revoked: true },
    { name: "revoked before JSON release", stream: false, revoked: true },
    { name: "invalid citation", stream: true, invalid: true },
    { name: "model refuses without citation", stream: true, refusal: ENTERPRISE_NO_EVIDENCE },
    { name: "model refuses with citation", stream: true, refusal: `${ENTERPRISE_NO_EVIDENCE} [Chunk 1]` },
    { name: "no authorized evidence", stream: true, empty: true },
    { name: "suggestion authorization unavailable", stream: false, empty: true, unavailable: true },
    { name: "unauthorized organization", stream: true, denied: true },
  ]
  for (const scenario of cases) await t.test(scenario.name, async st => {
    const calls: string[] = []
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      calls.push(url.pathname)
      if (url.hostname === "enterprise-test.invalid") {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer employee-token")
        switch (url.pathname) {
          case "/auth/v1/user":
            return Response.json({ id: userId, aud: "authenticated", role: "authenticated" })
          case "/rest/v1/rpc/enterprise_copilot_context":
            assert.deepEqual(JSON.parse(String(init?.body)), { target_organization_id: organizationId })
            return Response.json(scenario.denied ? [] : [{ organization_id: organizationId, can_upload_policy: false }])
          case "/rest/v1/rpc/search_enterprise_chunks":
            assert.equal(url.searchParams.get("select"), "id,content")
            assert.equal(JSON.parse(String(init?.body)).target_organization_id, organizationId)
            return Response.json(scenario.empty ? [] : [{ id: chunkId, content: "Authorized evidence", metadata: { filename: "private.pdf" } }])
          case "/rest/v1/rpc/enterprise_chunks_still_visible":
            assert.deepEqual(JSON.parse(String(init?.body)), { target_organization_id: organizationId, chunk_ids: [chunkId] })
            return Response.json(!scenario.revoked)
          case "/rest/v1/rpc/enterprise_fallback_documents":
            assert.deepEqual(JSON.parse(String(init?.body)), { target_organization_id: organizationId })
            if (scenario.unavailable) return Response.json({ code: "PGRST202" }, { status: 404 })
            return Response.json([
              { code: "D07", own_department: true },
              { code: "D01", own_department: false },
              { code: "D02", own_department: false },
              { code: "D08", own_department: false },
              { code: "D03", own_department: true },
              { code: "D11", own_department: true },
              { code: "D12", own_department: true },
            ])
        }
      }
      if (url.pathname.endsWith(":batchEmbedContents")) {
        return Response.json({ embeddings: [{ values: Array(1536).fill(0.1) }] })
      }
      if (/:streamGenerateContent$|:generateContent$/.test(url.pathname)) {
        assert.ok(url.pathname.includes("/models/gemini-3.5-flash-lite:"))
        assert.match(String(init?.body), /Authorized evidence/)
        assert.match(String(init?.body), /I don't know based on the documents I can access\./)
        assert.doesNotMatch(String(init?.body), /Old revoked answer|private\.pdf/)
        const text = scenario.refusal ?? (scenario.invalid ? "Unverified output [Chunk 99]." : "Use the documented setting [Chunk 1].")
        const data = { candidates: [{ index: 0, content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 } }
        return scenario.stream
          ? new Response("data: " + JSON.stringify(data) + "\n\n", { headers: { "Content-Type": "text/event-stream" } })
          : Response.json(data)
      }
      throw new Error("Unexpected request: " + url.pathname)
    })
    const response = await POST(new Request("https://app.invalid/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer employee-token", "x-eval-mode": "true" },
      body: JSON.stringify({ organizationId, query: "Question", stream: scenario.stream,
        messages: [{ role: "assistant", content: "Old revoked answer" }] }),
    }))
    if (scenario.denied) {
      assert.equal(response.status, 404)
      assert.deepEqual(calls, ["/auth/v1/user", "/rest/v1/rpc/enterprise_copilot_context"])
      return
    }
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("x-interaction-id"), null)
    const expected = scenario.answer ?? ENTERPRISE_NO_EVIDENCE
    const expectedQuestions = scenario.answer || scenario.unavailable ? undefined : [
      "What does the Design Handoff and Accessibility Standard require for handoff to Engineering?",
      "What are the general employee responsibilities in the Employee Handbook?",
      "How do I request leave under the Leave and Attendance Policy?",
      "How do I submit an equipment or service request?",
    ]
    if (scenario.stream) {
      const events: ChatEvent[] = []
      const wire = response.clone().text()
      await readChatStream(response, event => events.push(event))
      const metadata = events[0]
      assert.ok(metadata.type === "metadata")
      assert.equal(metadata.interactionId, undefined)
      assert.deepEqual(metadata.citations.map(c => c.id), scenario.answer ? [chunkId] : [])
      assert.equal(events.filter(event => event.type === "text").map(event => event.text).join(""), expected)
      assert.deepEqual(events.find(event => event.type === "finish")?.fallbackQuestions, expectedQuestions)
      assert.doesNotMatch(await wire, /Old revoked answer|private\.pdf|Chunk 99/)
      if (!scenario.answer) assert.doesNotMatch(await wire, /Authorized evidence/)
    } else {
      const body = await response.json()
      assert.equal(body.text, expected)
      assert.deepEqual(body.fallbackQuestions, expectedQuestions)
      assert.deepEqual(body.citations.map((c: { id: string }) => c.id), scenario.answer ? [chunkId] : [])
      if (!scenario.answer) assert.equal(body.context, "")
    }
    assert.equal(calls.some(path => path.endsWith("/interactions")), false)
    assert.equal(calls.some(path => path.endsWith("/enterprise_fallback_documents")), !scenario.answer)
    assert.equal(calls.some(path => path.endsWith("/enterprise_chunks_still_visible")), !scenario.invalid && !scenario.empty && !scenario.refusal)
    if (scenario.empty) assert.ok(!calls.some(path => /:streamGenerateContent$|:generateContent$/.test(path)))
  })
})
