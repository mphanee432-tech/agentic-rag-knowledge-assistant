import assert from "node:assert/strict"
import test from "node:test"
import { POST } from "../app/api/chat/route"
import { MAX_ANSWER_CHARS, NO_EVIDENCE, readChatStream, type ChatEvent } from "../lib/chat-contract"
import { createClient } from "@supabase/supabase-js"
import { retrieveVerifiedChunks } from "../lib/retrieve-chunks"

test("TTFT instrumentation preserves the request, retrieval, citation and stream contracts", async t => {
  const project = "11111111-1111-4111-8111-111111111111"
  const user = "22222222-2222-4222-8222-222222222222"
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: "https://ttft-test.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service-secret", GOOGLE_GENERATIVE_AI_API_KEY: "fixture-google-secret",
    CHAT_MODEL: "gemini-3.1-flash-lite", NODE_ENV: "development",
  }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  t.mock.method(console, "error", () => { })

  for (const scenario of [
    { name: "single citation", answer: "Answer [Chunk 1]." },
    { name: "multiple citations", answer: "Answer [Chunk 1, Chunk 2].", retry: true },
    { name: "no evidence", answer: NO_EVIDENCE, empty: true },
    { name: "JSON", answer: "Answer [Chunk 1].", json: true },
    { name: "invalid citation", answer: "Answer [Chunk 99].", failure: true, stage: "answer_validation", category: "invalid_citations" },
    { name: "empty answer", answer: "", failure: true, stage: "answer_validation", category: "answer_empty" },
    { name: "oversized answer", answer: "x".repeat(MAX_ANSWER_CHARS + 1), failure: true, stage: "answer_validation", category: "answer_too_long" },
    { name: "non-stop finish", answer: "Answer [Chunk 1].", finishReason: "MAX_TOKENS", failure: true, stage: "answer_validation", category: "generation_incomplete" },
    { name: "persistence failure", answer: "Answer [Chunk 1].", persistError: true, failure: true, stage: "interaction_persistence", category: "interaction_write_failed" },
    { name: "deadline after generation does not relabel a failed write", answer: "Answer [Chunk 1].", persistError: true, lateDeadline: true, failure: true, stage: "interaction_persistence", category: "interaction_write_failed" },
    { name: "persistence succeeds before five seconds", answer: "Answer [Chunk 1].", persistence: "success" },
    { name: "unresolved persistence stops at five seconds", answer: "Answer [Chunk 1].", persistence: "timeout", failure: true, stage: "interaction_persistence", category: "interaction_write_failed" },
    { name: "late persistence success cannot complete the stream", answer: "Answer [Chunk 1].", persistence: "late success", failure: true, stage: "interaction_persistence", category: "interaction_write_failed" },
    { name: "late persistence rejection is handled", answer: "Answer [Chunk 1].", persistence: "late rejection", failure: true, stage: "interaction_persistence", category: "interaction_write_failed" },
    { name: "persistence transport rejection fails without retry", answer: "Answer [Chunk 1].", persistence: "rejection", failure: true, stage: "interaction_persistence", category: "interaction_write_failed" },
    { name: "request cancellation bounds stalled persistence", answer: "Answer [Chunk 1].", persistence: "request cancellation", failure: true, stage: "interaction_persistence", category: "request_cancelled" },
    { name: "stream cancellation bounds stalled persistence", answer: "Answer [Chunk 1].", persistence: "stream cancellation", stage: "interaction_persistence", category: "request_cancelled" },
    { name: "initialization failure", answer: "", initializationError: true, failure: true, stage: "stream_initialization", category: "unknown_error" },
    { name: "SSE emission failure", answer: "Answer [Chunk 1].", emissionError: true, failure: true, stage: "sse_emission", category: "unknown_error" },
    { name: "provider failure", answer: "", providerError: true, failure: true, stage: "model_stream_iteration", category: "provider_error" },
    { name: "stream throws after text", answer: "private-answer-fragment", interrupted: true, failure: true, stage: "model_stream_iteration", category: "provider_error" },
    { name: "generation deadline", answer: "", deadline: true, failure: true, stage: "model_stream_finalization", category: "provider_timeout" },
    { name: "cancelled", answer: "Answer [Chunk 1].", cancel: true, stage: "model_stream_finalization", category: "request_cancelled" },
    { name: "request aborted", answer: "Answer [Chunk 1].", requestAbort: true, stage: "model_stream_finalization", category: "request_cancelled" },
    { name: "production logging", answer: "Answer [Chunk 1].", production: true },
  ]) {
    await t.test(scenario.name, async st => {
      Object.assign(process.env, { NODE_ENV: scenario.production ? "production" : "development" })
      let now = 0
      st.mock.method(performance, "now", () => now)
      const logs: Array<Record<string, unknown>> = []
      const rawLogs: unknown[][] = []
      st.mock.method(console, "error", (...values: unknown[]) => { rawLogs.push(values) })
      let logged!: () => void
      const logDone = new Promise<void>(resolve => { logged = resolve })
      st.mock.method(console, "info", (value: string) => { logs.push(JSON.parse(value)); logged() })
      const calls: string[] = []
      let embeds = 0
      let persistedLatency: number | undefined
      let releaseModel!: () => void
      const modelGate = new Promise<void>(resolve => { releaseModel = resolve })
      let releaseText!: () => void
      const textGate = new Promise<void>(resolve => { releaseText = resolve })
      const clientAbort = new AbortController()
      const deadline = new AbortController()
      let writeSignal: AbortSignal | undefined
      let startedPersistence!: () => void
      const persistenceStarted = new Promise<void>(resolve => { startedPersistence = resolve })
      let resolvePersistence!: (response: Response) => void
      let rejectPersistence!: (reason: unknown) => void
      const persistence = new Promise<Response>((resolve, reject) => {
        resolvePersistence = resolve
        rejectPersistence = reject
      })
      const persistenceMs = !scenario.persistence ? 31 : scenario.persistence === "success" ? 4999
        : scenario.persistence.includes("cancellation") || scenario.persistence === "rejection" ? 7 : 5000
      const unhandled: unknown[] = []
      if (scenario.persistence) {
        st.mock.timers.enable({ apis: ["setTimeout"] })
        const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
        process.on("unhandledRejection", onUnhandled)
        st.after(() => process.off("unhandledRejection", onUnhandled))
        if (scenario.persistence === "late rejection") {
          const query = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
            auth: { persistSession: false, autoRefreshToken: false },
          }).from("interactions").insert({})
          const abortSignal = query.abortSignal
          // Exercise a rejecting SDK promise, not only its default error-as-data response.
          st.mock.method(Object.getPrototypeOf(query), "abortSignal", function (this: typeof query, signal: AbortSignal) {
            return abortSignal.call(this, signal).throwOnError()
          })
        }
      }
      // Keep every timeout deterministic; only the generation deadline is triggered below.
      st.mock.method(AbortSignal, "timeout", (ms: number) => {
        if (scenario.initializationError && ms === 35000) throw new Error("fixture-error-secret")
        return ms === 35000 ? deadline.signal : new AbortController().signal
      })
      const encoder = new TextEncoder()
      if (scenario.emissionError) {
        const enqueue = ReadableStreamDefaultController.prototype.enqueue
        st.mock.method(ReadableStreamDefaultController.prototype, "enqueue", function (this: ReadableStreamDefaultController, chunk: unknown) {
          if (chunk instanceof Uint8Array && new TextDecoder().decode(chunk).startsWith('data: {"type":"text"')) {
            throw new Error("fixture-error-secret")
          }
          return enqueue.call(this, chunk)
        })
      }
      const providerFrame = (text: string, final = false) => encoder.encode(`data: ${JSON.stringify({
        candidates: [{ index: 0, content: { role: "model", parts: [{ text }] }, ...(final ? { finishReason: scenario.finishReason || "STOP" } : {}) }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
      })}\n\n`)
      st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        calls.push(url.pathname)
        if (url.hostname === "ttft-test.invalid") {
          switch (url.pathname) {
            case "/auth/v1/user":
              now += 3
              assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-user-token")
              return Response.json({ id: user, aud: "authenticated", role: "authenticated" })
            case "/rest/v1/projects":
              now += 5
              assert.equal(url.searchParams.get("user_id"), `eq.${user}`)
              assert.equal(url.searchParams.get("id"), `eq.${project}`)
              return Response.json([{ id: project, user_id: user }])
            case "/rest/v1/rpc/search_rag_chunks": {
              now += 17
              assert.equal(url.searchParams.get("select"), "id")
              const body = JSON.parse(String(init?.body))
              assert.equal(body.target_project_id, project)
              assert.equal(body.query_embedding.length, 1536)
              return Response.json(scenario.empty ? [] : [{ id: "a" }, { id: "b" }])
            }
            case "/rest/v1/document_chunks":
              now += 19
              assert.equal(url.searchParams.get("project_id"), `eq.${project}`)
              assert.equal(url.searchParams.get("documents.status"), "eq.indexed")
              return Response.json(["a", "b"].map(id => ({ id, content: "private-document", metadata: { secret: "private-metadata" } })))
            case "/rest/v1/interactions":
              persistedLatency = JSON.parse(String(init?.body)).latency_ms
              assert.equal(init?.method, "POST")
              assert.ok(init?.signal)
              if (scenario.persistence) {
                writeSignal = init.signal
                startedPersistence()
                // Deliberately ignore abort: application waiting must still be bounded.
                return persistence
              }
              now += 31
              if (scenario.lateDeadline) deadline.abort(new DOMException("fixture-error-secret", "TimeoutError"))
              if (scenario.persistError) return Response.json({ message: "fixture-error-secret" }, { status: 400 })
              return new Response(null, { status: 201 })
          }
        }
        assert.equal(url.hostname, "generativelanguage.googleapis.com", "No live requests are permitted")
        if (url.pathname.endsWith(":batchEmbedContents")) {
          embeds++
          now += 11
          const body = JSON.parse(String(init?.body))
          assert.match(JSON.stringify(body), /gemini-embedding-2/)
          assert.match(JSON.stringify(body), /1536/)
          if (scenario.retry && embeds === 1) return Response.json({ error: { message: "fixture-error-secret", code: 400 } }, { status: 400 })
          return Response.json({ embeddings: [{ values: Array(1536).fill(0.1) }] })
        }
        assert.match(url.pathname, /:streamGenerateContent$|:generateContent$/)
        const body = JSON.parse(String(init?.body))
        if (body.tools) {
          return Response.json({
            candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "rag_retrieval", args: { searchQuery: "private-query" } } }] }, finishReason: "STOP" }],
          })
        }
        if (body.generationConfig?.responseJsonSchema) {
          return Response.json({
            candidates: [{
              content: {
                role: "model",
                parts: [{
                  text: JSON.stringify(
                    scenario.empty
                      ? { sufficient: false, reason: "no_chunks_retrieved", nextAction: "abstain", reformulatedQuery: null, clarificationQuestion: null }
                      : { sufficient: true, reason: "sufficient_evidence", nextAction: "answer", reformulatedQuery: null, clarificationQuestion: null },
                  ),
                }],
              },
              finishReason: "STOP",
            }],
          })
        }
        calls.pop()
        calls.push("/__final_generation__")
        assert.equal(body.generationConfig.maxOutputTokens, 1000)
        assert.ok(init?.signal)
        if (scenario.deadline || scenario.requestAbort) {
          await modelGate
          now += scenario.deadline ? 35000 : 7
          if (scenario.deadline) deadline.abort(new DOMException("fixture-error-secret", "TimeoutError"))
          else clientAbort.abort(new DOMException("fixture-error-secret", "AbortError"))
          assert.equal(init.signal.aborted, true)
          throw init.signal.reason
        }
        if (scenario.cancel) {
          await modelGate
          assert.equal(init.signal.aborted, true)
          throw new Error("fixture-error-secret")
        }
        now += 23
        if (scenario.providerError) return Response.json({ error: { code: 400, message: "fixture-error-secret" } }, { status: 400 })
        if (scenario.json) return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: scenario.answer }] }, finishReason: "STOP" }] })
        if (scenario.interrupted) {
          let sentText = false
          return new Response(new ReadableStream({
            async pull(controller) {
              if (!sentText) { sentText = true; controller.enqueue(providerFrame(scenario.answer)) }
              else { await textGate; controller.error(new Error("fixture-error-secret")) }
            }
          }), { headers: { "Content-Type": "text/event-stream" } })
        }
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(providerFrame(""))
            controller.enqueue(providerFrame(scenario.answer, true))
            controller.close()
          }
        }), { headers: { "Content-Type": "text/event-stream" } })
      })
      const req = new Request("https://app.invalid/api/chat", {
        method: "POST", headers: { Authorization: "Bearer fixture-user-token" },
        signal: clientAbort.signal,
        body: JSON.stringify({ projectId: project, query: "private-query", stream: !scenario.json }),
      })
      const originalText = req.text.bind(req)
      st.mock.method(req, "text", async () => { now += 2; return originalText() })
      const response = await POST(req)
      const checkDiagnostics = () => {
        assert.deepEqual(rawLogs, [], "SDK errors must not produce unsanitized logs")
        assert.equal(calls.filter(path => path === "/auth/v1/user").length, 1)
        assert.equal(calls.filter(path => path.endsWith("/projects")).length, 1)
        assert.equal(embeds, scenario.retry ? 2 : 1)
        assert.equal(calls.filter(path => path.includes("/rpc/")).length, 1)
        assert.equal(calls.filter(path => path.endsWith("document_chunks")).length, scenario.empty ? 0 : 1)
        assert.equal(calls.filter(path => path === "/__final_generation__").length, scenario.empty || scenario.initializationError ? 0 : 1)
        assert.equal(calls.filter(path => path.endsWith("/interactions")).length, scenario.failure && !scenario.persistError && !scenario.persistence || scenario.cancel || scenario.requestAbort ? 0 : 1)
        assert.equal(logs.length, scenario.production ? 0 : 1)
        if (!scenario.production) {
          const log = logs[0]
          assert.equal(log.interaction_id, response.headers.get("x-interaction-id"))
          assert.equal(log.failure_stage, scenario.stage ?? null)
          assert.equal(log.failure_category, scenario.category ?? null)
          if (scenario.providerError) {
            assert.equal(log.provider_error_status, 400)
            assert.equal(log.provider_error_code, "400")
            assert.equal(log.provider_error_message, "Provider returned HTTP 400.")
          } else if (scenario.interrupted) {
            assert.equal(log.provider_error_status, 200)
            assert.equal(log.provider_error_code, "200")
            assert.equal(log.provider_error_message, "Provider returned HTTP 200.")
          } else {
            assert.equal(log.provider_error_status, null)
            assert.equal(log.provider_error_code, null)
            assert.equal(log.provider_error_message, null)
          }
          assert.equal(log.had_first_text, !scenario.empty && !scenario.json && !scenario.providerError && !scenario.deadline &&
            !scenario.cancel && !scenario.requestAbort && scenario.answer.length > 0 && scenario.answer.length <= MAX_ANSWER_CHARS)
          assert.equal(log.model_stream_completed, !scenario.empty && !scenario.json && !scenario.providerError &&
            !scenario.interrupted && !scenario.deadline && !scenario.cancel && !scenario.requestAbort && !scenario.initializationError &&
            !scenario.emissionError && scenario.answer.length <= MAX_ANSWER_CHARS)
          assert.equal(log.interaction_write_started, !scenario.failure && !scenario.cancel && !scenario.requestAbort || !!scenario.persistError || !!scenario.persistence)
          assert.equal(log.elapsed_ms, now)
          assert.equal(log.request_parse_ms, 2)
          assert.equal(log.auth_ms, 8)
          assert.equal(log.embedding_ms, scenario.retry ? 22 : 11)
          assert.equal(log.retrieval_ms, scenario.empty ? 17 : 36)
          assert.equal(log.model_first_text_ms, log.had_first_text ? 23 : null)
          assert.equal(log.server_ttft_ms, scenario.json ? null : scenario.empty ? 38 : log.had_first_text ? 80 + (scenario.retry ? 11 : 0) : null)
          assert.equal(log.interaction_write_ms, scenario.persistError || scenario.persistence || !scenario.failure && !scenario.cancel && !scenario.requestAbort ? persistenceMs : null)
        }
        for (const secret of ["private-document", "private-metadata", "private-query", "fixture-user-token", "fixture-service-secret", "fixture-google-secret", "fixture-error-secret", scenario.answer].filter(Boolean)) {
          assert.ok(!JSON.stringify(logs).includes(secret), secret)
        }
      }
      let metrics: Record<string, unknown>
      if (scenario.cancel || scenario.persistence === "stream cancellation") {
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let seenMetadata = false
        while (!seenMetadata) {
          const chunk = await reader.read()
          const frame = decoder.decode(chunk.value)
          if (/"type":"metadata"/.test(frame)) {
            seenMetadata = true
            break
          }
          assert.match(frame, /"type":"agent_step"/)
        }
        if (scenario.persistence) {
          await persistenceStarted
          assert.equal(writeSignal?.aborted, false)
          const text = await reader.read()
          assert.match(decoder.decode(text.value), /"type":"text"/)
          now += persistenceMs
        }
        await reader.cancel()
        releaseModel()
        await logDone
        assert.equal(logs[0].status, "cancelled")
        assert.equal(logs[0].server_ttft_ms, scenario.persistence ? persistedLatency : null)
        assert.equal(logs[0].server_finish_ready_ms, null)
        if (scenario.persistence) {
          assert.equal(writeSignal?.aborted, true)
          st.mock.timers.tick(10000)
          resolvePersistence(new Response(null, { status: 201 }))
          await new Promise<void>(resolve => setImmediate(resolve))
          assert.deepEqual(unhandled, [])
        } else assert.equal(persistedLatency, undefined)
        checkDiagnostics()
        return
      }
      if (scenario.json) {
        const body = await response.json()
        metrics = body.metrics
        assert.equal(body.text, scenario.answer)
      } else {
        const events: ChatEvent[] = []
        const wire = response.clone().text()
        const reading = readChatStream(response, event => { events.push(event); if (event.type === "text" && event.text) releaseText() })
        const completion = scenario.failure || scenario.requestAbort ? assert.rejects(reading, /could not be completed/) : reading
        releaseModel()
        if (scenario.persistence) {
          await persistenceStarted
          assert.equal(writeSignal?.aborted, false)
          assert.equal(events.some(event => event.type === "finish"), false)
          if (persistenceMs === 5000) {
            now += 4999
            st.mock.timers.tick(4999)
            await new Promise<void>(resolve => setImmediate(resolve))
            assert.equal(writeSignal?.aborted, false)
            assert.equal(logs.length, 0)
            assert.equal(events.some(event => event.type === "finish"), false)
            now++
            st.mock.timers.tick(1)
          } else {
            now += persistenceMs
            st.mock.timers.tick(persistenceMs)
          }
          if (scenario.persistence === "success") resolvePersistence(new Response(null, { status: 201 }))
          if (scenario.persistence === "rejection") rejectPersistence(new Error("fixture-error-secret"))
          if (scenario.persistence === "request cancellation") clientAbort.abort(new DOMException("fixture-error-secret", "AbortError"))
        }
        if (scenario.failure || scenario.requestAbort) {
          await completion
          await logDone
          assert.equal(events.some(event => event.type === "finish"), false)
          assert.equal(persistedLatency !== undefined, !!scenario.persistError || !!scenario.persistence)
          assert.equal(logs[0].status, scenario.requestAbort || scenario.persistence === "request cancellation" ? "cancelled" : "error")
          assert.equal(logs[0].server_finish_ready_ms, null)
          if (scenario.persistence) {
            assert.equal(writeSignal?.aborted, true)
            if (persistenceMs === 5000) assert.match(String(writeSignal?.reason), /Interaction persistence timed out after 5000ms/)
            if (scenario.persistence === "late success") resolvePersistence(new Response(null, { status: 201 }))
            if (scenario.persistence === "late rejection") rejectPersistence(new Error("fixture-error-secret"))
            await new Promise<void>(resolve => setImmediate(resolve))
            st.mock.timers.tick(10000)
            assert.deepEqual(unhandled, [])
          }
          const wireEvents = (await wire).trim().split("\n\n").map(frame => JSON.parse(frame.slice(6)))
          const nonAgentWire = wireEvents.filter(event => event.type !== "agent_step")
          assert.ok(wireEvents.some(event => event.type === "agent_step"))
          assert.deepEqual(nonAgentWire.map(event => event.type), ["metadata", ...(logs[0].had_first_text && !scenario.emissionError ? ["text"] : []), "error"])
          assert.deepEqual(wireEvents.at(-1), { type: "error", message: "The answer could not be completed. Please retry." })
          checkDiagnostics()
          return
        }
        await completion
        const nonAgentEvents = events.filter(event => event.type !== "agent_step")
        assert.ok(events.some(event => event.type === "agent_step"))
        assert.deepEqual(nonAgentEvents.map(event => event.type), ["metadata", "text", "finish"])
        const metadata = nonAgentEvents[0]
        assert.ok(metadata.type === "metadata")
        assert.equal(metadata.interactionId, response.headers.get("x-interaction-id"))
        const finish = events.at(-1)
        assert.ok(finish?.type === "finish")
        metrics = finish.metrics
        await wire
        if (scenario.persistence) {
          st.mock.timers.tick(10000)
          clientAbort.abort()
          assert.equal(writeSignal?.aborted, false, "Persistence timer and cancellation listener must be cleaned up")
          assert.deepEqual(unhandled, [])
        }
        assert.equal(events.filter(event => event.type === "text").map(event => event.text).join(""), scenario.answer)
      }
      if (!scenario.production) await logDone
      for (const field of ["failure_stage", "failure_category", "had_first_text", "model_stream_completed", "interaction_write_started", "elapsed_ms"]) {
        assert.equal(field in metrics, false, "Diagnostics must not enter response metrics")
      }
      checkDiagnostics()
      assert.equal(metrics.request_parse_ms, 2)
      assert.equal(metrics.auth_ms, 8)
      assert.equal(metrics.embedding_ms, scenario.retry ? 22 : 11)
      assert.equal(metrics.rrf_rpc_ms, 17)
      assert.equal(metrics.chunk_verify_ms, scenario.empty ? null : 19)
      assert.equal(metrics.retrieval_ms, scenario.empty ? 17 : 36)
      assert.equal(metrics.prompt_build_ms, 0)
      assert.equal(metrics.interaction_write_ms, persistenceMs)
      assert.equal(metrics.model_first_text_ms, scenario.empty || scenario.json ? null : 23)
      assert.equal(metrics.server_ttft_ms, scenario.json ? null : persistedLatency)
      assert.equal(metrics.server_finish_ready_ms, scenario.json ? null : persistedLatency! + persistenceMs)
      assert.equal(metrics.total_ms, persistedLatency, "Legacy total still excludes persistence")
      assert.equal(metrics.generation_ms, scenario.empty ? 0 : 23)
      assert.equal((metrics.retries as { embedding: number }).embedding, scenario.retry ? 1 : 0)
      assert.equal(metrics.retrieved_chunk_count, scenario.empty ? 0 : 2)
      assert.equal(metrics.context_chars, scenario.empty ? "NO_CONTEXT_FOUND".length :
        "### Document Context [Chunk 1 | ID: a]\nprivate-document\n\n### Document Context [Chunk 2 | ID: b]\nprivate-document".length)
    })
  }
})

test("RRF timing includes retries while an unexecuted verification remains null", async t => {
  let now = 0
  t.mock.method(performance, "now", () => now)
  const client = createClient("https://retrieval-test.invalid", "fixture-key", {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => {
    now += 7
    return ++calls === 1 ? Response.json({ message: "temporary" }, { status: 400 }) : Response.json([])
  })
  const telemetry = {
    retries: { retrieval: 0 }, errors: [] as string[],
    rrf_rpc_ms: null as number | null, chunk_verify_ms: null as number | null
  }
  assert.deepEqual(await retrieveVerifiedChunks(client, "11111111-1111-4111-8111-111111111111",
    Array(1536).fill(0.1), "Question", new AbortController().signal, telemetry), [])
  assert.equal(calls, 2)
  assert.equal(telemetry.retries.retrieval, 1)
  assert.equal(telemetry.rrf_rpc_ms, 14)
  assert.equal(telemetry.chunk_verify_ms, null)
})

test("attempted retrieval stages retain timings on failure without changing database calls", async t => {
  const project = "11111111-1111-4111-8111-111111111111"
  const embedding = Array(1536).fill(0.1)
  for (const scenario of ["RPC failure", "verification error", "verification rejection", "no ranked IDs", "no allowed chunks"]) {
    await t.test(scenario, async st => {
      let now = 0
      st.mock.method(performance, "now", () => now)
      const client = createClient("https://retrieval-test.invalid", "fixture-key", {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      const originalError = new Error("verification rejected")
      // Abort rejection avoids SDK transport retries while checking original error identity.
      originalError.name = "AbortError"
      if (scenario === "verification rejection") {
        const from = client.from.bind(client)
        st.mock.method(client, "from", (table: string) => {
          const query = from(table)
          const select = query.select.bind(query)
          st.mock.method(query, "select", (columns?: string) => select(columns).throwOnError())
          return query
        })
      }
      let rpcCalls = 0
      let verificationCalls = 0
      st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        assert.equal(url.hostname, "retrieval-test.invalid")
        assert.ok(init?.signal)
        if (url.pathname.endsWith("/rpc/search_rag_chunks")) {
          now += 7
          rpcCalls++
          assert.equal(url.searchParams.get("select"), "id")
          assert.deepEqual(JSON.parse(String(init?.body)), {
            query_embedding: embedding, query_text: "Question", target_project_id: project,
          })
          if (scenario === "RPC failure") return Response.json({ message: "RPC unavailable" }, { status: 400 })
          return Response.json(scenario === "no ranked IDs" ? [] : [{ id: "ranked" }])
        }
        now += 11
        verificationCalls++
        assert.equal(url.pathname, "/rest/v1/document_chunks")
        assert.equal(url.searchParams.get("project_id"), `eq.${project}`)
        assert.equal(url.searchParams.get("documents.status"), "eq.indexed")
        assert.equal(url.searchParams.get("select"), "id,content,metadata,documents!inner(status)")
        assert.equal(url.searchParams.get("id"), "in.(ranked)")
        if (scenario === "verification rejection") throw originalError
        if (scenario === "verification error") return Response.json({ message: "verification denied" }, { status: 403 })
        return Response.json([])
      })
      const telemetry = {
        retries: { retrieval: 0 }, errors: [] as string[],
        rrf_rpc_ms: null as number | null, chunk_verify_ms: null as number | null
      }
      const result = retrieveVerifiedChunks(client, ` ${project} `, embedding, "Question", new AbortController().signal, telemetry)
      if (scenario === "RPC failure") await assert.rejects(result, /RPC unavailable/)
      else if (scenario === "verification error") await assert.rejects(result, error => (error as { message: string }).message === "verification denied")
      else if (scenario === "verification rejection") await assert.rejects(result, error => error === originalError)
      else assert.deepEqual(await result, [])
      const skipped = scenario === "RPC failure" || scenario === "no ranked IDs"
      assert.equal(rpcCalls, scenario === "RPC failure" ? 2 : 1)
      assert.equal(verificationCalls, skipped ? 0 : 1)
      assert.equal(telemetry.retries.retrieval, scenario === "RPC failure" ? 1 : 0)
      assert.equal(telemetry.rrf_rpc_ms, scenario === "RPC failure" ? 14 : 7)
      assert.equal(telemetry.chunk_verify_ms, skipped ? null : 11)
      assert.deepEqual(telemetry.errors, scenario === "RPC failure" ? ["Retrieval RPC: RPC unavailable"] : [])
    })
  }
})
