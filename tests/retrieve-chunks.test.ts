import assert from "node:assert/strict"
import test from "node:test"
import { createClient } from "@supabase/supabase-js"
import { retrieveVerifiedChunks, toPersonalSparseQueryText } from "../lib/retrieve-chunks"

test("retrieval returns only authoritative indexed project chunks in ranked order", async t => {
  const client = createClient("https://retrieval-test.invalid", "test-service", {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const project = "11111111-1111-4111-8111-111111111111"
  const embedding = Array(1536).fill(0.1)
  const run = (signal = new AbortController().signal) => {
    const telemetry = { retries: { retrieval: 0 }, errors: [] as string[] }
    return { telemetry, result: retrieveVerifiedChunks(client, ` ${project} `, embedding, "Question", signal, telemetry) }
  }
  const urlOf = (input: RequestInfo | URL) => new URL(input instanceof Request ? input.url : String(input))

  await t.test("RPC content is ignored, unverified IDs removed, and ranking preserved", async st => {
    let calls = 0
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input)
      assert.equal(url.hostname, "retrieval-test.invalid")
      assert.ok(init?.signal)
      calls++
      if (url.pathname.endsWith("/rpc/search_rag_chunks")) {
        assert.equal(url.searchParams.get("select"), "id")
        const body = JSON.parse(String(init?.body))
        assert.equal(body.target_project_id, project)
        assert.deepEqual(body.query_embedding, embedding)
        return Response.json([{ id: "b", content: "Forged" }, { id: "foreign" }, { id: "a" }])
      }
      assert.equal(url.pathname, "/rest/v1/document_chunks")
      assert.equal(url.searchParams.get("project_id"), `eq.${project}`)
      assert.equal(url.searchParams.get("documents.status"), "eq.indexed")
      assert.match(url.searchParams.get("select")!, /documents!inner\(status\)/)
      assert.equal(url.searchParams.get("id"), "in.(b,foreign,a)")
      return Response.json([
        { id: "a", content: "Verified A", metadata: {} }, { id: "b", content: "Verified B", metadata: {} },
      ])
    })
    const { result, telemetry } = run()
    assert.deepEqual((await result).map(c => [c.id, c.content]), [["b", "Verified B"], ["a", "Verified A"]])
    assert.equal(calls, 2)
    assert.equal(telemetry.retries.retrieval, 0)
  })

  await t.test("empty search skips the authoritative query", async st => {
    const fetch = st.mock.method(globalThis, "fetch", async () => Response.json([]))
    assert.deepEqual(await run().result, [])
    assert.equal(fetch.mock.callCount(), 1)
  })

  await t.test("one RPC retry is retained and reported", async st => {
    let calls = 0
    st.mock.method(globalThis, "fetch", async () => ++calls === 1
      ? Response.json({ message: "temporary" }, { status: 400 }) : Response.json([]))
    const { result, telemetry } = run()
    assert.deepEqual(await result, [])
    assert.equal(calls, 2)
    assert.equal(telemetry.retries.retrieval, 1)
    assert.deepEqual(telemetry.errors, [])
  })

  await t.test("exhausted RPC errors fail closed", async st => {
    const fetch = st.mock.method(globalThis, "fetch", async () => Response.json({ message: "unavailable" }, { status: 400 }))
    const { result, telemetry } = run()
    await assert.rejects(result, /unavailable/)
    assert.equal(fetch.mock.callCount(), 2)
    assert.deepEqual(telemetry.errors, ["Retrieval RPC: unavailable"])
  })

  await t.test("verification failure never falls back to RPC content", async st => {
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => urlOf(input).pathname.includes("/rpc/")
      ? Response.json([{ id: "foreign", content: "Untrusted" }])
      : Response.json({ message: "verification failed" }, { status: 403 }))
    await assert.rejects(run().result, error => (error as { message: string }).message === "verification failed")
  })

  await t.test("Personal sparse query helper distills long queries while preserving short and Enterprise queries", () => {
    assert.equal(toPersonalSparseQueryText("Question"), "Question")
    assert.equal(toPersonalSparseQueryText("avoid Kafka small chunks"), "avoid Kafka small chunks")
    assert.equal(
      toPersonalSparseQueryText("PostgreSQL backups recovery RPO frequency"),
      "PostgreSQL backups recovery RPO frequency",
    )
    assert.equal(
      toPersonalSparseQueryText("Production RAG blueprint chunk count Kafka Kubernetes vector database multi LLM agents"),
      "kafka kubernetes llm",
    )
    assert.equal(
      toPersonalSparseQueryText("Below what chunk count does the Production RAG blueprint recommend deliberately avoiding Kafka, Kubernetes, a dedicated vector database, or multiple LLM agents?"),
      "kafka kubernetes llm",
    )
  })
})
