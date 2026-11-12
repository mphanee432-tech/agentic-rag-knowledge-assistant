import assert from "node:assert/strict"
import test from "node:test"
import { GET as listProjects, POST as createProject } from "../app/api/projects/route"
import { GET as listDocuments, DELETE as deleteDocument } from "../app/api/documents/route"
import { POST as reserveUpload } from "../app/api/documents/upload-url/route"
import { POST as feedback } from "../app/api/feedback/route"
import { POST as chat } from "../app/api/chat/route"

test("public routes enforce identity and ownership before privileged operations", async t => {
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: "https://tenant-test.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-test-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
  }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const projects = { a: "11111111-1111-4111-8111-111111111111", b: "22222222-2222-4222-8222-222222222222" }
  const docId = "33333333-3333-4333-8333-333333333333"
  const interactionId = "44444444-4444-4444-8444-444444444444"
  const path = `user-a/${projects.a}/${docId}/source.txt`
  const request = (route: string, token: string, method = "GET", body?: unknown) => new Request(`https://app.invalid${route}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  const cases = (token: string, project: string) => [
    () => listProjects(request("/api/projects", token)),
    () => listProjects(request(`/api/projects?id=${project}`, token)),
    () => createProject(request("/api/projects", token, "POST", { name: "Test", user_id: "user-a" })),
    () => listDocuments(request(`/api/documents?projectId=${project}`, token)),
    () => deleteDocument(request(`/api/documents?documentId=${docId}`, token, "DELETE")),
    () => reserveUpload(request("/api/documents/upload-url", token, "POST", { projectId: project, filename: "test.txt", fileSize: 5 })),
    () => feedback(request("/api/feedback", token, "POST", { interactionId, rating: "thumbs_up" })),
    () => chat(request("/api/chat", token, "POST", { projectId: project, query: "Test question", stream: true })),
    () => chat(request("/api/chat", token, "POST", { projectId: project, query: "Test question", stream: false })),
  ]

  await t.test("invalid sessions cannot list, create, delete, reserve, submit feedback or chat", async st => {
    let privateCalls = 0
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname !== "tenant-test.invalid" || url.pathname !== "/auth/v1/user") privateCalls++
      return Response.json({ message: "Invalid session" }, { status: 401 })
    })
    for (const call of cases("expired-token", projects.a)) assert.equal((await call()).status, 401)
    assert.equal(privateCalls, 0)
  })

  for (const [actor, foreign] of [["a", projects.b], ["b", projects.a]]) {
    await t.test(`user ${actor} cannot access foreign project data even if child lookup leaks a row`, async st => {
      const privateWrites: string[] = []
      const documentReads: string[] = []
      st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        const headers = new Headers(init?.headers)
        assert.equal(url.hostname, "tenant-test.invalid")
        assert.equal(headers.get("apikey"), env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
        if (url.pathname === "/auth/v1/user") return Response.json({ id: `user-${actor}`, aud: "authenticated", role: "authenticated" })
        if (url.pathname === "/rest/v1/rpc/enterprise_chat_projects") {
          assert.equal(headers.get("authorization"), `Bearer token-${actor}`)
          assert.deepEqual(JSON.parse(String(init?.body)), { target_project_id: foreign })
          return Response.json([])
        }
        if (init?.method && init.method !== "GET") privateWrites.push(url.pathname)
        if (url.pathname === "/rest/v1/projects") {
          assert.equal(url.searchParams.get("user_id"), `eq.user-${actor}`)
          assert.equal(url.searchParams.get("id"), `eq.${foreign}`)
          return Response.json([])
        }
        // Exercise the explicit project guard independently of RLS on child tables.
        if (url.pathname === "/rest/v1/documents") {
          documentReads.push(url.searchParams.get("select")!)
          return Response.json([{ id: docId, project_id: foreign, storage_path: "victim/source.txt" }])
        }
        if (url.pathname === "/rest/v1/interactions") return Response.json([{ project_id: foreign }])
        assert.fail(`Unexpected privileged or model request: ${url.pathname}`)
      })
      const calls = cases(`token-${actor}`, foreign)
      for (const index of [1, 3, 4, 5, 6, 7, 8]) assert.equal((await calls[index]()).status, 404)
      assert.deepEqual(documentReads, ["id,project_id,storage_path"])
      assert.deepEqual(privateWrites, [])
    })
  }

  await t.test("project listing uses caller-scoped credentials and project creation ignores forged ownership", async st => {
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      assert.equal(url.hostname, "tenant-test.invalid")
      assert.equal(new Headers(init?.headers).get("apikey"), env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
      if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-b", aud: "authenticated", role: "authenticated" })
      assert.equal(url.pathname, "/rest/v1/projects")
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body))
        assert.equal(body.user_id, "user-b")
        return Response.json(body, { status: 201 })
      }
      assert.equal(url.searchParams.get("user_id"), "eq.user-b")
      return Response.json([{ id: projects.b, name: "Own" }])
    })
    const listed = await listProjects(request("/api/projects", "token-b"))
    assert.equal(listed.status, 200)
    assert.deepEqual((await listed.json()).projects.map((p: { id: string }) => p.id), [projects.b])
    const created = await createProject(request("/api/projects", "token-b", "POST", { name: "Own", user_id: "user-a" }))
    assert.equal(created.status, 201)
    assert.equal((await created.json()).project.user_id, "user-b")
  })

  await t.test("owner upload reservations bind privileged writes to the authenticated project and user", async st => {
    let reservedPath = ""
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const key = new Headers(init?.headers).get("apikey")
      assert.equal(url.hostname, "tenant-test.invalid")
      if (url.pathname === "/auth/v1/user") {
        assert.equal(key, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
        return Response.json({ id: "user-a", aud: "authenticated", role: "authenticated" })
      }
      if (url.pathname === "/rest/v1/projects") {
        assert.equal(key, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
        assert.equal(url.searchParams.get("id"), `eq.${projects.a}`)
        assert.equal(url.searchParams.get("user_id"), "eq.user-a")
        return Response.json([{ id: projects.a, user_id: "user-a" }])
      }
      assert.equal(key, env.SUPABASE_SERVICE_ROLE_KEY)
      if (url.pathname === "/rest/v1/documents") {
        assert.equal(init?.method, "POST")
        const row = JSON.parse(String(init?.body))
        reservedPath = `user-a/${projects.a}/${row.id}/source.txt`
        assert.equal(row.storage_path, reservedPath)
        assert.equal(row.project_id, projects.a)
        assert.equal(row.status, "pending_upload")
        return new Response(null, { status: 201 })
      }
      assert.equal(url.pathname, `/storage/v1/object/upload/sign/documents/${reservedPath}`)
      return Response.json({ url: `/object/upload/sign/documents/${reservedPath}?token=signed-test-token` })
    })
    const response = await reserveUpload(request("/api/documents/upload-url", "token-a", "POST", {
      projectId: projects.a, filename: "source.txt", fileSize: 5, storagePath: "victim/file.txt", user_id: "user-b",
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.storagePath, reservedPath)
    assert.equal(body.token, "signed-test-token")
  })

  await t.test("invalid upload metadata cannot allocate a document or issue an upload token", async st => {
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-a" })
      assert.equal(url.pathname, "/rest/v1/projects", "Invalid uploads must stop before privileged writes")
      return Response.json([{ id: projects.a, user_id: "user-a" }])
    })
    const invalid = [
      { filename: "source.exe", fileSize: 5 },
      { filename: "source.txt.exe", fileSize: 5 },
      { filename: "a".repeat(201) + ".txt", fileSize: 5 },
      { filename: null, fileSize: 5 },
      ...[0, -1, 1.5, "5", 25 * 1024 * 1024 + 1, null].map(fileSize => ({ filename: "source.txt", fileSize })),
    ]
    for (const metadata of invalid) {
      const response = await reserveUpload(request("/api/documents/upload-url", "token-a", "POST", {
        projectId: projects.a, ...metadata,
      }))
      assert.equal(response.status, 400, JSON.stringify(metadata))
      assert.equal((await response.json()).token, undefined)
    }
  })

  await t.test("a rejected quota reservation cannot issue an upload token", async st => {
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-a" })
      if (url.pathname === "/rest/v1/projects") return Response.json([{ id: projects.a, user_id: "user-a" }])
      assert.equal(url.pathname, "/rest/v1/documents", "Rejected reservations must never reach Storage signing")
      assert.equal(init?.method, "POST")
      return Response.json({ message: "Project document limit reached" }, { status: 400 })
    })
    const response = await reserveUpload(request("/api/documents/upload-url", "token-a", "POST", {
      projectId: projects.a, filename: "source.txt", fileSize: 5,
    }))
    assert.equal(response.status, 409)
    assert.equal((await response.json()).token, undefined)
  })

  await t.test("owner deletion uses the authorized row's path and keeps data operations under RLS", async st => {
    const mutations: string[] = []
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const key = new Headers(init?.headers).get("apikey")
      assert.equal(url.hostname, "tenant-test.invalid")
      if (url.pathname.startsWith("/storage/")) {
        assert.equal(key, env.SUPABASE_SERVICE_ROLE_KEY)
        assert.equal(url.pathname, "/storage/v1/object/documents")
        assert.deepEqual(JSON.parse(String(init?.body)).prefixes, [path])
        mutations.push("storage")
        return Response.json([])
      }
      assert.equal(key, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
      if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-a", aud: "authenticated", role: "authenticated" })
      if (url.pathname === "/rest/v1/projects") {
        assert.equal(url.searchParams.get("id"), `eq.${projects.a}`)
        assert.equal(url.searchParams.get("user_id"), "eq.user-a")
        return Response.json([{ id: projects.a, user_id: "user-a" }])
      }
      assert.equal(url.pathname, "/rest/v1/documents")
      if (url.searchParams.has("id")) assert.equal(url.searchParams.get("id"), `eq.${docId}`)
      else assert.equal(url.searchParams.get("project_id"), `eq.${projects.a}`)
      if (init?.method === "DELETE") {
        assert.equal(url.searchParams.get("project_id"), `eq.${projects.a}`)
        mutations.push("document")
        return new Response(null, { status: 204 })
      }
      return Response.json([{ id: docId, project_id: projects.a, storage_path: path }])
    })
    const documents = await listDocuments(request(`/api/documents?projectId=${projects.a}`, "token-a"))
    assert.equal(documents.status, 200)
    assert.deepEqual((await documents.json()).documents.map((doc: { id: string }) => doc.id), [docId])
    const response = await deleteDocument(request(`/api/documents?documentId=${docId}`, "token-a", "DELETE", { storagePath: "victim/file.txt" }))
    assert.equal(response.status, 200)
    assert.deepEqual(mutations, ["document", "storage"])
  })
})
