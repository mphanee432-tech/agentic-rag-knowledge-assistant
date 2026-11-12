import assert from "node:assert/strict"
import test from "node:test"
import { POST } from "../app/api/webhooks/storage/route"

test("ingestion uses fenced recovery for transient failures and stops on invalid uploads", async t => {
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: "https://ingestion-test.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "test-service",
    GOOGLE_GENERATIVE_AI_API_KEY: "test-google",
    SUPABASE_WEBHOOK_SECRET: "test-webhook",
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
  const content = "# Test document\n\nThis is evidence for an ingestion test."
  const cases = [
    { name: "successful ingestion", status: 200 },
    { name: "large text paragraph", largeProse: true, status: 200 },
    { name: "indexed replay", documentStatus: "indexed", status: 200, noClaim: true },
    { name: "terminal failure replay", documentStatus: "failed", status: 422, noClaim: true },
    { name: "active lease or backoff", acquired: false, status: 409 },
    { name: "download failure", downloadError: true, status: 500, retryable: true },
    { name: "invalid embedding", invalidEmbedding: true, status: 500, retryable: true },
    { name: "finalization failure", finishError: true, status: 500, retryable: true },
    { name: "size mismatch", sizeMismatch: true, status: 422, retryable: false },
    { name: "empty text", empty: true, status: 422, retryable: false },
    { name: "invalid PDF", pdf: true, status: 422, retryable: false },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async st => {
      const text = scenario.empty ? "   " : scenario.largeProse ? "word ".repeat(6000) : content
      const storagePath = "user-a/project-a/document-a/source." + (scenario.pdf ? "pdf" : "txt")
      const calls: string[] = []
      const failures: Array<Record<string, unknown>> = []
      const completions: Array<Record<string, unknown>> = []
      let lease: unknown
      st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        calls.push(url.pathname)
        if (url.hostname === "ingestion-test.invalid") {
          if (url.pathname === "/rest/v1/documents") {
            assert.equal(init?.method, "GET")
            return Response.json([{ id: "document-a", project_id: "project-a", storage_path: storagePath,
              status: scenario.documentStatus || "uploaded",
              expected_size: Buffer.byteLength(text) + (scenario.sizeMismatch ? 1 : 0) }])
          }
          if (url.pathname === "/rest/v1/rpc/claim_document_ingestion") {
            const body = JSON.parse(String(init?.body))
            assert.equal(body.p_document_id, "document-a")
            lease = body.p_lease
            assert.equal(typeof lease, "string")
            return Response.json(scenario.acquired !== false)
          }
          if (url.pathname.startsWith("/storage/v1/object/")) {
            return scenario.downloadError ? Response.json({ message: "Unavailable" }, { status: 503 }) : new Response(text)
          }
          if (url.pathname === "/rest/v1/rpc/finish_document_ingestion") {
            const body = JSON.parse(String(init?.body))
            assert.equal(body.p_lease, lease)
            assert.equal(body.p_document_id, "document-a")
            assert.ok(body.p_chunks.length > 0)
            assert.equal(body.p_chunks[0].embedding.length, 1536)
        if (scenario.largeProse) assert.ok(body.p_chunks.every((chunk: { content: string }) => chunk.content.length <= 3200))
            completions.push(body)
            return scenario.finishError ? Response.json({ message: "Lease lost" }, { status: 400 }) : Response.json(null)
          }
          if (url.pathname === "/rest/v1/rpc/fail_document_ingestion") {
            failures.push(JSON.parse(String(init?.body)))
            return Response.json(null)
          }
          if (url.pathname === "/rest/v1/projects") return new Response(null, { status: 204 })
        }
        if (url.hostname === "generativelanguage.googleapis.com") {
          if (url.pathname.endsWith(":batchEmbedContents")) {
            return Response.json({ embeddings: [{ values: scenario.invalidEmbedding ? [] : Array(1536).fill(0.1) }] })
          }
          if (url.pathname.endsWith(":generateContent")) {
            return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "[]" }] }, finishReason: "STOP" }] })
          }
        }
        assert.fail("Unexpected request: " + url.href)
      })
      const response = await POST(new Request("https://app.invalid/api/webhooks/storage", {
        method: "POST", headers: { "x-webhook-secret": env.SUPABASE_WEBHOOK_SECRET },
        body: JSON.stringify(scenario.name === "successful ingestion"
          ? { type: "INSERT", table: "objects", schema: "storage", record: { bucket_id: "documents", name: storagePath } }
          : { storagePath }),
      }))
      assert.equal(response.status, scenario.status, JSON.stringify(await response.json()))
      if (scenario.retryable !== undefined) {
        assert.equal(failures.length, 1)
        assert.equal(failures[0].p_document_id, "document-a")
        assert.equal(failures[0].p_lease, lease)
        assert.equal(failures[0].p_retryable, scenario.retryable)
        assert.equal(typeof failures[0].p_error, "string")
      } else assert.deepEqual(failures, [])
      if (scenario.noClaim) assert.equal(calls.length, 1)
      if (scenario.acquired === false) assert.equal(calls.length, 2)
      assert.equal(completions.length, scenario.name === "successful ingestion" || scenario.largeProse || scenario.finishError ? 1 : 0)
    })
  }
  await t.test("both secret headers authenticate ignored events without dispatching", async st => {
    const fetchMock = st.mock.method(globalThis, "fetch", async () => { throw new Error("No network expected") })
    for (const headers of [new Headers({ "x-webhook-secret": env.SUPABASE_WEBHOOK_SECRET }),
                           new Headers({ Authorization: `Bearer ${env.SUPABASE_WEBHOOK_SECRET}` })]) {
      const response = await POST(new Request("https://app.invalid/api/webhooks/storage", {
        method: "POST", headers, body: JSON.stringify({ type: "UPDATE" }),
      }))
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ignored: true })
    }
    assert.equal(fetchMock.mock.callCount(), 0)
  })
  await t.test("unauthorized requests cannot dispatch or claim work", async st => {
    const fetchMock = st.mock.method(globalThis, "fetch", async () => { throw new Error("No network expected") })
    const request = (headers?: HeadersInit) => new Request("https://app.invalid/api/webhooks/storage", {
      method: "POST", headers, body: JSON.stringify({ storagePath: "some-file.txt" }),
    })
    assert.equal((await POST(request())).status, 401)
    assert.equal((await POST(request({ "x-webhook-secret": "wrong-secret" }))).status, 401)
    assert.equal((await POST(request({ Authorization: "Bearer wrong-secret" }))).status, 401)
    delete process.env.SUPABASE_WEBHOOK_SECRET
    assert.equal((await POST(request({ "x-webhook-secret": env.SUPABASE_WEBHOOK_SECRET }))).status, 503)
    assert.equal(fetchMock.mock.callCount(), 0)
    process.env.SUPABASE_WEBHOOK_SECRET = env.SUPABASE_WEBHOOK_SECRET
  })
  await t.test("an authenticated webhook cannot ingest a file without a reservation", async st => {
    const fetchMock = st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      assert.equal(url.pathname, "/rest/v1/documents")
      assert.equal(init?.method, "GET")
      assert.equal(url.searchParams.get("storage_path"), "eq.unreserved.txt")
      return Response.json([])
    })
    const response = await POST(new Request("https://app.invalid/api/webhooks/storage", {
      method: "POST", headers: { "x-webhook-secret": env.SUPABASE_WEBHOOK_SECRET },
      body: JSON.stringify({ storagePath: "unreserved.txt" }),
    }))
    assert.equal(response.status, 404)
    assert.equal(fetchMock.mock.callCount(), 1)
  })
})
