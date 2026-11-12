import assert from "node:assert/strict"
import test from "node:test"
import { loadWorkspace, watchWorkspace } from "../lib/load-workspace"
import { useChatStore, type DocumentItem } from "../lib/store/chat-store"

const document: DocumentItem = {
  id: "doc-a", project_id: "project-a", storage_path: "a.txt", status: "indexed", created_at: "2026-11-04",
}

test("workspace loading fetches each resource once and preserves project isolation", async t => {
  const initial = useChatStore.getState()
  t.after(() => useChatStore.setState(initial, true))

  await t.test("loads documents and suggestions with one request per resource", async st => {
    useChatStore.getState().setActiveProject("project-a")
    const requests: string[] = []
    const controller = new AbortController()
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(input))
      assert.equal(init?.signal, controller.signal)
      return Response.json(String(input).startsWith("/api/documents")
        ? { documents: [document] } : { project: { suggested_queries: ["Question"] } })
    })
    await loadWorkspace("project-a", controller.signal)
    assert.deepEqual(requests.sort(), ["/api/documents?projectId=project-a", "/api/projects?id=project-a"])
    assert.deepEqual(useChatStore.getState().documents, [document])
    assert.deepEqual(useChatStore.getState().suggestedQueries, ["Question"])
    assert.equal(useChatStore.getState().isDocumentsLoading, false)
  })

  await t.test("navigation during JSON parsing cannot overwrite the new workspace", async st => {
    useChatStore.getState().setActiveProject("project-a")
    let release!: (value: { documents: DocumentItem[] }) => void
    let parsing!: () => void
    const started = new Promise<void>(resolve => { parsing = resolve })
    const body = new Promise(resolve => { release = resolve })
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/documents")) {
        const response = Response.json({})
        response.json = () => { parsing(); return body }
        return response
      }
      return Response.json({ project: { suggested_queries: ["Old question"] } })
    })
    const loading = loadWorkspace("project-a")
    await started
    useChatStore.getState().setActiveProject("project-b")
    release({ documents: [document] })
    await loading
    assert.deepEqual(useChatStore.getState().documents, [])
    assert.deepEqual(useChatStore.getState().suggestedQueries, [])
    assert.equal(useChatStore.getState().isDocumentsLoading, true)
  })

  await t.test("aborted work does not replace a newer load of the same project", async st => {
    useChatStore.getState().setActiveProject("project-a")
    const controller = new AbortController()
    st.mock.method(globalThis, "fetch", async () => {
      controller.abort()
      return Response.json({ documents: [document], project: { suggested_queries: ["Old question"] } })
    })
    await loadWorkspace("project-a", controller.signal)
    assert.deepEqual(useChatStore.getState().documents, [])
    assert.deepEqual(useChatStore.getState().suggestedQueries, [])
    assert.equal(useChatStore.getState().isDocumentsLoading, true)
  })

  await t.test("failed responses cannot populate the store and loading completes", async st => {
    useChatStore.getState().setActiveProject("project-a")
    st.mock.method(globalThis, "fetch", async () => Response.json({ documents: [document] }, { status: 403 }))
    await loadWorkspace("project-a")
    assert.deepEqual(useChatStore.getState().documents, [])
    assert.equal(useChatStore.getState().isDocumentsLoading, false)
  })

  await t.test("network failure clears loading without replacing data", async st => {
    useChatStore.getState().setActiveProject("project-a")
    useChatStore.getState().setDocuments([document])
    st.mock.method(console, "error", () => {})
    st.mock.method(globalThis, "fetch", async () => { throw new Error("offline") })
    await loadWorkspace("project-a")
    assert.deepEqual(useChatStore.getState().documents, [document])
    assert.equal(useChatStore.getState().isDocumentsLoading, false)
  })

  await t.test("inactive or already aborted loads make no requests", async st => {
    useChatStore.getState().setActiveProject("project-b")
    const fetch = st.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected request") })
    await loadWorkspace("project-a")
    const controller = new AbortController()
    controller.abort()
    await loadWorkspace("project-b", controller.signal)
    assert.equal(fetch.mock.callCount(), 0)
  })

  await t.test("reopened ingestion is polled through recovery until indexed or failed", async st => {
    st.mock.timers.enable({ apis: ["setTimeout"] })
    for (const terminal of ["indexed", "failed"] as const) {
      useChatStore.getState().setActiveProject("project-a")
      const statuses = ["pending_upload", "processing", "uploaded", terminal] as const
      let loads = 0
      const fetch = st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
        return Response.json(String(input).startsWith("/api/documents")
          ? { documents: [{ ...document, status: statuses[loads++] }] }
          : { project: { suggested_queries: ["Recovered question"] } })
      })
      const stop = watchWorkspace("project-a")
      st.after(stop)
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(loads, 1)
      st.mock.timers.tick(1999)
      assert.equal(loads, 1)
      for (let i = 1; i < statuses.length; i++) {
        st.mock.timers.tick(i === 1 ? 1 : 2000)
        await new Promise<void>(resolve => setImmediate(resolve))
        assert.equal(useChatStore.getState().documents[0].status, statuses[i])
      }
      assert.deepEqual(useChatStore.getState().suggestedQueries, ["Recovered question"])
      st.mock.timers.tick(10000)
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(loads, statuses.length)
      stop()
      fetch.mock.restore()
    }
  })

  await t.test("workspace cleanup cancels pending polling and in-flight refreshes", async st => {
    st.mock.timers.enable({ apis: ["setTimeout"] })
    useChatStore.getState().setActiveProject("project-a")
    let release!: () => void
    const body = new Promise<void>(resolve => { release = resolve })
    let signal: AbortSignal | undefined
    const fetch = st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      if (String(input).startsWith("/api/documents")) {
        await body
        return Response.json({ documents: [{ ...document, status: "processing" }] })
      }
      return Response.json({ project: { suggested_queries: ["Old question"] } })
    })
    const stop = watchWorkspace("project-a")
    stop()
    assert.equal(signal?.aborted, true)
    release()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(useChatStore.getState().documents, [])
    assert.deepEqual(useChatStore.getState().suggestedQueries, [])
    st.mock.timers.tick(10000)
    assert.equal(fetch.mock.callCount(), 2)

    const stopPolling = watchWorkspace("project-a")
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(useChatStore.getState().documents[0].status, "processing")
    stopPolling()
    const calls = fetch.mock.callCount()
    st.mock.timers.tick(10000)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(fetch.mock.callCount(), calls)
  })
})
