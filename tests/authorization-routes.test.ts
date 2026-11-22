import assert from "node:assert/strict"
import test from "node:test"
import { GET as listProjects, POST as createProject } from "../app/api/projects/route"
import { GET as listDocuments, DELETE as deleteDocument } from "../app/api/documents/route"
import { POST as reserveUpload } from "../app/api/documents/upload-url/route"
import { POST as feedback } from "../app/api/feedback/route"
import { POST as chat } from "../app/api/chat/route"
import { POST as ingestPolicy } from "../app/api/enterprise/ingest/route"
import { POST as onboardEmployee } from "../app/api/enterprise/onboard/route"

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

  await t.test("enterprise upload uses the department reservation and rejects an employee before Storage", async st => {
    const organizationId = "55555555-5555-4555-8555-555555555555"
    const departmentId = "66666666-6666-4666-8666-666666666666"
    let signingCalls = 0
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const headers = new Headers(init?.headers)
      if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-a", role: "authenticated" })
      if (url.pathname.endsWith("/reserve_enterprise_policy")) {
        assert.equal(headers.get("apikey"), env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
        if (headers.get("authorization") === "Bearer employee") {
          return Response.json({ code: "42501", message: "denied" }, { status: 403 })
        }
        const params = JSON.parse(String(init?.body))
        assert.deepEqual(params, {
          target_organization_id: organizationId, target_department_id: departmentId,
          p_document_id: params.p_document_id, p_filename: "policy.html", p_expected_size: 10,
          p_classification: "restricted", p_access_scope: "department",
        })
        return Response.json({ project_id: projects.b, storage_path: `enterprise/${projects.b}/${params.p_document_id}/policy.html` })
      }
      assert.match(url.pathname, new RegExp(`^/storage/v1/object/upload/sign/documents/enterprise/${projects.b}/`))
      assert.equal(headers.get("apikey"), env.SUPABASE_SERVICE_ROLE_KEY)
      signingCalls++
      return Response.json({ url: "/object/upload/sign/documents/path?token=signed-token" })
    })
    const policy = { organizationId, departmentId, projectId: projects.a,
      filename: "policy.html", fileSize: 10, classification: "restricted", accessScope: "department" }
    const path = "/api/documents/upload-url"
    assert.equal((await reserveUpload(request(path, "employee", "POST", policy))).status, 403)
    assert.equal((await reserveUpload(request(path, "uploader", "POST", { ...policy, accessScope: "company" }))).status, 400)
    assert.equal(signingCalls, 0)
    const response = await reserveUpload(request(path, "uploader", "POST", policy))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).projectId, projects.b)
    assert.equal(signingCalls, 1)
  })

  await t.test("an indexed but unpublished reservation can be published on retry", async st => {
    const calls: string[] = []
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      calls.push(url.pathname)
      if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-a", role: "authenticated" })
      if (url.pathname.endsWith("/can_upload_enterprise_policy")) return Response.json(true)
      if (url.pathname.endsWith("/documents")) {
        assert.equal(url.searchParams.get("project_id"), `eq.${projects.b}`)
        return Response.json([{ id: docId, status: "indexed", is_published: false }])
      }
      assert.match(url.pathname, /publish_enterprise_document$/)
      assert.deepEqual(JSON.parse(String(init?.body)), { p_document_id: docId })
      return Response.json(null)
    })
    const response = await ingestPolicy(request("/api/enterprise/ingest", "uploader", "POST", { documentId: docId, projectId: projects.b }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { success: true, alreadyIndexed: true, isPublished: true })
    assert.equal(calls.length, 4)
  })

  await t.test("publication failure keeps indexed content retryable without reclaiming or resetting ingestion", async st => {
    const calls: string[] = []
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      calls.push(url.pathname)
      if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-a", role: "authenticated" })
      if (url.pathname.endsWith("/can_upload_enterprise_policy")) return Response.json(true)
      if (url.pathname.endsWith("/documents")) return Response.json([{ id: docId, status: "indexed", is_published: false }])
      assert.match(url.pathname, /publish_enterprise_document$/)
      return Response.json({ code: "55000", message: "Publication could not complete" }, { status: 400 })
    })
    const response = await ingestPolicy(request("/api/enterprise/ingest", "uploader", "POST", { documentId: docId, projectId: projects.b }))
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: "Document indexed but publication failed. Please retry." })
    assert.equal(calls.length, 4)
  })

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

  await t.test("a rejected reservation cannot issue an upload token", async st => {
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-a" })
      if (url.pathname === "/rest/v1/projects") return Response.json([{ id: projects.a, user_id: "user-a" }])
      assert.equal(url.pathname, "/rest/v1/documents", "Rejected reservations must never reach Storage signing")
      assert.equal(init?.method, "POST")
      return Response.json({ message: "Reservation rejected" }, { status: 400 })
    })
    const response = await reserveUpload(request("/api/documents/upload-url", "token-a", "POST", {
      projectId: projects.a, filename: "source.txt", fileSize: 5,
    }))
    assert.equal(response.status, 500)
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

  await t.test("enterprise onboarding enforces one-time employee department enrollment and rejects privilege escalation", async st => {
    const orgId = "c0000000-0000-4000-8000-000000000001"
    let rpcCalls = 0
    const enrolledByUser = new Map<string, { department: string; role: string }>()
    enrolledByUser.set("existing-manager", { department: "Engineering", role: "manager" })

    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const headers = new Headers(init?.headers)
      const authHeader = headers.get("authorization") || ""
      if (url.pathname === "/auth/v1/user") {
        if (authHeader === "Bearer expired") return Response.json({ message: "Invalid" }, { status: 401 })
        const userId = authHeader.replace(/^Bearer /, "")
        return Response.json({ id: userId, aud: "authenticated", role: "authenticated" })
      }
      if (url.pathname === "/rest/v1/rpc/onboard_demo_employee") {
        rpcCalls += 1
        const userId = authHeader.replace(/^Bearer /, "")
        const { target_department } = JSON.parse(String(init?.body)) as { target_department: string }
        const existing = enrolledByUser.get(userId)
        if (existing && (existing.department !== target_department || existing.role !== "employee")) {
          return Response.json(
            { code: "42501", message: "Department assignment is one-time and cannot be changed" },
            { status: 403 },
          )
        }
        enrolledByUser.set(userId, { department: target_department, role: "employee" })
        return Response.json({
          organization_id: orgId,
          department_id: "c0000000-0000-4000-8000-000000000002",
          department_name: target_department,
          role: "employee",
        })
      }
      throw new Error(`Unexpected request: ${url.pathname}`)
    })

    // Unauthenticated onboarding is rejected without calling RPC
    assert.equal(
      (await onboardEmployee(request("/api/enterprise/onboard", "expired", "POST", { department: "Engineering" }))).status,
      401,
    )

    // Invalid departments are rejected before calling RPC
    for (const badDept of [{ department: "" }, { department: "Executive" }, {}]) {
      assert.equal(
        (await onboardEmployee(request("/api/enterprise/onboard", "new-eng-user", "POST", badDept))).status,
        400,
      )
    }

    // Privilege escalation or client-supplied role/org/grants/user_id keys are rejected with 403 before calling RPC
    for (const escalationBody of [
      { department: "Engineering", role: "manager" },
      { department: "Engineering", role: "cxo" },
      { department: "Engineering", role: "employee" },
      { department: "Engineering", organizationId: orgId },
      { department: "Engineering", userId: "other-user" },
      { department: "Engineering", is_active: true },
      { department: "Engineering", grants: ["D03"] },
      { department: "Engineering", project_memberships: ["D12"] },
    ]) {
      const res = await onboardEmployee(request("/api/enterprise/onboard", "new-eng-user", "POST", escalationBody))
      assert.equal(res.status, 403)
    }
    assert.equal(rpcCalls, 0)

    // Valid one-time Engineering signup enrollment succeeds and is idempotent on retry
    const firstEnroll = await onboardEmployee(
      request("/api/enterprise/onboard", "new-eng-user", "POST", { department: "Engineering" }),
    )
    assert.equal(firstEnroll.status, 200)
    assert.deepEqual(await firstEnroll.json(), {
      organizationId: orgId,
      departmentId: "c0000000-0000-4000-8000-000000000002",
      departmentName: "Engineering",
      role: "employee",
    })

    const retryEnroll = await onboardEmployee(
      request("/api/enterprise/onboard", "new-eng-user", "POST", { department: "Engineering" }),
    )
    assert.equal(retryEnroll.status, 200)

    // Attempting to switch departments or overwrite an existing Manager/CXO membership is rejected with 403
    const switchDept = await onboardEmployee(
      request("/api/enterprise/onboard", "new-eng-user", "POST", { department: "HR" }),
    )
    assert.equal(switchDept.status, 403)

    const managerAttempt = await onboardEmployee(
      request("/api/enterprise/onboard", "existing-manager", "POST", { department: "Engineering" }),
    )
    assert.equal(managerAttempt.status, 403)
    assert.equal(rpcCalls, 4)
  })
})
