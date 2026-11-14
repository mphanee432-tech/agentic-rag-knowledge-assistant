import assert from "node:assert/strict"
import test from "node:test"
import { PDFDocument } from "pdf-lib"
import { POST } from "../app/api/webhooks/storage/route"
import { POST as ingestEnterprise } from "../app/api/enterprise/ingest/route"

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

  await t.test("enterprise ingestion retries 503 and 429 with 1s/2s backoff, fails fast on 400/401/403, and reuses reservations on retry", async st => {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
    st.after(() => { delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY })
    const warnings: Array<Record<string, unknown>> = []
    st.mock.method(console, "warn", (msg?: unknown) => {
      if (typeof msg === "string" && msg.startsWith("{")) {
        warnings.push(JSON.parse(msg))
      }
    })

    const realSetTimeout = globalThis.setTimeout
    const delays: number[] = []
    st.mock.method(globalThis, "setTimeout", ((cb: (...args: unknown[]) => void, ms?: number) => {
      if (ms === 1000 || ms === 2000) {
        delays.push(ms)
        return realSetTimeout(cb, 0)
      }
      return realSetTimeout(cb, ms)
    }) as typeof setTimeout)

    const runEnterpriseIngest = async (options: {
      geminiStatuses: Array<number | "abort" | "client-cancel">
      docStatus?: string
      isPublished?: boolean
      fileBytes?: Uint8Array | string
      filename?: string
    }) => {
      delays.length = 0
      warnings.length = 0
      let geminiAttempts = 0
      let finishCalls = 0
      let publishCalls = 0
      let readyUpdates = 0
      const attemptSignals: AbortSignal[] = []
      const geminiPaths: string[] = []
      const failures: Array<Record<string, unknown>> = []
      const payload = options.fileBytes ?? content
      const payloadBytes = typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength
      const storagePath = `enterprise/project-a/document-a/${options.filename ?? "policy.txt"}`
      const clientController = new AbortController()

      st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.hostname === "ingestion-test.invalid") {
          if (url.pathname === "/auth/v1/user") {
            return Response.json({ id: "uploader-a", role: "authenticated" })
          }
          if (url.pathname === "/rest/v1/rpc/can_upload_enterprise_policy") {
            return Response.json(true)
          }
          if (url.pathname === "/rest/v1/documents") {
            if (init?.method === "PATCH") {
              readyUpdates++
              assert.equal(url.searchParams.get("id"), "eq.document-a")
              assert.equal(url.searchParams.get("status"), "eq.uploaded")
              return new Response(null, { status: 204 })
            }
            return Response.json([{
              id: "document-a",
              project_id: "project-a",
              storage_path: storagePath,
              status: options.docStatus ?? "pending_upload",
              expected_size: payloadBytes,
              classification: "standard",
              access_scope: "company",
              is_published: options.isPublished ?? false,
            }])
          }
          if (url.pathname === "/rest/v1/rpc/claim_document_ingestion") {
            return Response.json(true)
          }
          if (url.pathname.startsWith("/storage/v1/object/")) {
            return new Response(typeof payload === "string" ? payload : Buffer.from(payload))
          }
          if (url.pathname === "/rest/v1/rpc/finish_document_ingestion") {
            finishCalls++
            return Response.json(null)
          }
          if (url.pathname === "/rest/v1/rpc/publish_enterprise_document") {
            publishCalls++
            return Response.json(null)
          }
          if (url.pathname === "/rest/v1/rpc/fail_document_ingestion") {
            failures.push(JSON.parse(String(init?.body)))
            return Response.json(null)
          }
        }
        if (url.hostname === "generativelanguage.googleapis.com") {
          assert.ok(init?.signal instanceof AbortSignal)
          assert.equal(init.signal.aborted, false, "Each Gemini attempt must receive a fresh non-aborted signal")
          attemptSignals.push(init.signal)
          geminiPaths.push(url.pathname)
          const status = options.geminiStatuses[geminiAttempts] ?? 200
          geminiAttempts++
          if (status === "abort") {
            throw new DOMException("This operation was aborted", "AbortError")
          }
          if (status === "client-cancel") {
            clientController.abort()
            throw new DOMException("This operation was aborted", "AbortError")
          }
          if (status !== 200) {
            return Response.json(
              {
                error: {
                  code: status,
                  message: status === 503 ? "This model is currently experiencing high demand." : "Error",
                  status: status === 503 ? "UNAVAILABLE" : status === 429 ? "RESOURCE_EXHAUSTED" : "INVALID_ARGUMENT",
                },
              },
              { status, headers: { "content-type": "application/json" } }
            )
          }
          if (url.pathname.endsWith(":generateContent")) {
            return Response.json({
              candidates: [{ content: { role: "model", parts: [{ text: "# Extracted Policy\n\nContent." }] }, finishReason: "STOP" }],
            })
          }
          return Response.json({ embeddings: [{ values: Array(1536).fill(0.1) }] })
        }
        assert.fail("Unexpected request: " + url.href)
      })

      const response = await ingestEnterprise(new Request("https://app.invalid/api/enterprise/ingest", {
        method: "POST",
        headers: { Authorization: "Bearer uploader-token", "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: "document-a", projectId: "project-a" }),
        signal: clientController.signal,
      }))
      return {
        status: response.status,
        body: await response.json(),
        geminiAttempts,
        attemptSignals,
        geminiPaths,
        delays: [...delays],
        warnings: [...warnings],
        finishCalls,
        publishCalls,
        readyUpdates,
        failures,
      }
    }

    // 1. 503 and 429 transient errors retry with 1s, then 2s backoff and complete ingestion + publication
    const recovered = await runEnterpriseIngest({ geminiStatuses: [503, 429, 200] })
    assert.equal(recovered.status, 200)
    assert.equal(recovered.body.isPublished, true)
    assert.equal(recovered.geminiAttempts, 3)
    assert.deepEqual(recovered.delays, [1000, 2000])
    assert.equal(recovered.finishCalls, 1)
    assert.equal(recovered.publishCalls, 1)
    assert.deepEqual(recovered.failures, [])

    // 2. Sustained 503 unavailability stops after 3 attempts and returns friendly 503 message
    const unavailable = await runEnterpriseIngest({ geminiStatuses: [503, 503, 503] })
    assert.equal(unavailable.status, 503)
    assert.deepEqual(unavailable.body, { error: "Gemini is temporarily busy. Please retry indexing." })
    assert.equal(unavailable.geminiAttempts, 3)
    assert.deepEqual(unavailable.delays, [1000, 2000])
    assert.equal(unavailable.finishCalls, 0)
    assert.equal(unavailable.publishCalls, 0)
    assert.equal(unavailable.failures.length, 1)
    assert.equal(unavailable.failures[0].p_retryable, true)
    assert.equal(unavailable.failures[0].p_error, "Gemini is temporarily busy. Please retry indexing.")

    // 3. Permanent errors (400, 401, 403) fail immediately without retry
    for (const code of [400, 401, 403]) {
      const permanent = await runEnterpriseIngest({ geminiStatuses: [code, 200] })
      assert.equal(permanent.status, 500)
      assert.equal(permanent.geminiAttempts, 1, `Status ${code} must not retry`)
      assert.deepEqual(permanent.delays, [])
      assert.equal(permanent.finishCalls, 0)
      assert.equal(permanent.failures.length, 1)
    }

    // 4. Retry Indexing on an 'uploaded' reservation reuses the uploaded file and completes without duplicates
    const retried = await runEnterpriseIngest({ docStatus: "uploaded", geminiStatuses: [200] })
    assert.equal(retried.status, 200)
    assert.equal(retried.body.isPublished, true)
    assert.equal(retried.readyUpdates, 1)
    assert.equal(retried.geminiAttempts, 1)
    assert.equal(retried.finishCalls, 1)
    assert.equal(retried.publishCalls, 1)

    // 5. Repeated indexing attempt on an already indexed & published reservation returns immediately without re-indexing
    const idempotent = await runEnterpriseIngest({ docStatus: "indexed", isPublished: true, geminiStatuses: [200] })
    assert.equal(idempotent.status, 200)
    assert.deepEqual(idempotent.body, { success: true, alreadyIndexed: true, isPublished: true })
    assert.equal(idempotent.geminiAttempts, 0)
    assert.equal(idempotent.finishCalls, 0)
    assert.equal(idempotent.publishCalls, 0)

    // 6. WP7.1: 503 followed by attempt AbortError/timeout retries with fresh attempt signals and succeeds
    const timeoutRecovered = await runEnterpriseIngest({ geminiStatuses: [503, "abort", 200] })
    assert.equal(timeoutRecovered.status, 200)
    assert.equal(timeoutRecovered.body.isPublished, true)
    assert.equal(timeoutRecovered.geminiAttempts, 3)
    assert.equal(new Set(timeoutRecovered.attemptSignals).size, 3, "Each attempt must receive a distinct signal")
    assert.deepEqual(timeoutRecovered.delays, [1000, 2000])
    assert.equal(timeoutRecovered.warnings.length, 2)
    assert.equal(timeoutRecovered.warnings[0].stage, "embedding")
    assert.equal(timeoutRecovered.warnings[0].model, "gemini-embedding-2")
    assert.equal(timeoutRecovered.warnings[0].failureType, "http_503")
    assert.equal(timeoutRecovered.warnings[1].failureType, "attempt_timeout")
    assert.equal(typeof timeoutRecovered.warnings[1].inputBytes, "number")
    assert.equal(typeof timeoutRecovered.warnings[1].durationMs, "number")
    assert.ok(!JSON.stringify(timeoutRecovered.warnings).includes(env.GOOGLE_GENERATIVE_AI_API_KEY))
    assert.ok(!JSON.stringify(timeoutRecovered.warnings).includes(content.slice(0, 32)))
    assert.equal(timeoutRecovered.finishCalls, 1)
    assert.equal(timeoutRecovered.publishCalls, 1)

    // 7. WP7.1: Sustained Gemini timeout/AbortError across all 3 attempts returns 504 instead of 500
    const timedOut = await runEnterpriseIngest({ geminiStatuses: ["abort", "abort", "abort"] })
    assert.equal(timedOut.status, 504)
    assert.deepEqual(timedOut.body, { error: "Gemini timed out while indexing. Please retry indexing." })
    assert.equal(timedOut.geminiAttempts, 3)
    assert.deepEqual(timedOut.delays, [1000, 2000])
    assert.equal(timedOut.failures.length, 1)
    assert.equal(timedOut.failures[0].p_retryable, true)
    assert.equal(timedOut.failures[0].p_error, "Ingestion timed out.")

    // 8. WP7.1: Genuine client cancellation fails immediately without retrying
    const cancelled = await runEnterpriseIngest({ geminiStatuses: ["client-cancel", 200] })
    assert.equal(cancelled.status, 499)
    assert.deepEqual(cancelled.body, { error: "Indexing request was cancelled." })
    assert.equal(cancelled.geminiAttempts, 1)
    assert.deepEqual(cancelled.delays, [])
    assert.equal(cancelled.failures.length, 1)
    assert.equal(cancelled.failures[0].p_retryable, true)

    // 9. WP7.3: PDF extraction uses gemini-3.5-flash-lite and preserves gemini-embedding-2 for embeddings
    const pdfDoc = await PDFDocument.create()
    pdfDoc.addPage()
    const pdfBytes = await pdfDoc.save()
    const pdfResult = await runEnterpriseIngest({
      geminiStatuses: [200, 200],
      fileBytes: pdfBytes,
      filename: "policy.pdf",
    })
    assert.equal(pdfResult.status, 200)
    assert.equal(pdfResult.body.isPublished, true)
    assert.equal(pdfResult.geminiPaths.length, 2)
    assert.ok(pdfResult.geminiPaths[0].endsWith("/models/gemini-3.5-flash-lite:generateContent"))
    assert.ok(pdfResult.geminiPaths[1].endsWith("/models/gemini-embedding-2:batchEmbedContents"))
    assert.equal(pdfResult.finishCalls, 1)
    assert.equal(pdfResult.publishCalls, 1)
  })
})
