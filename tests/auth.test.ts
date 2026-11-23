import test from "node:test"
import assert from "node:assert/strict"
import { POST as chatPost } from "../app/api/chat/route"
import { requireProject, requireChatProject, requireUser, HttpError } from "../lib/auth"

test("authorization rejects invalid identities and foreign projects before returning data", async () => {
  const originalFetch = globalThis.fetch
  const originalURL = process.env.NEXT_PUBLIC_SUPABASE_URL
  const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://auth-test.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  const own = "11111111-1111-4111-8111-111111111111"
  const foreign = "22222222-2222-4222-8222-222222222222"
  let identityValid = false
  let projectReads = 0
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    assert.equal(url.hostname, "auth-test.invalid")
    if (url.pathname === "/auth/v1/user") {
      return Response.json(identityValid ? { id: "user-a", aud: "authenticated", role: "authenticated" } : { message: "Invalid token" }, { status: identityValid ? 200 : 401 })
    }
    projectReads++
    assert.equal(url.searchParams.get("user_id"), "eq.user-a")
    const data = url.searchParams.get("id") === "eq." + own ? { id: own, user_id: "user-a", name: "Owned" } : null
    const accept = new Headers(init?.headers).get("accept") || ""
    return Response.json(accept.includes("object") ? data : data ? [data] : [])
  }
  const request = new Request("https://app.invalid", { headers: { authorization: "Bearer test-token" } })
  try {
    await assert.rejects(requireProject(own, request), error => error instanceof HttpError && error.status === 401)
    assert.equal(projectReads, 0)
    identityValid = true
    await assert.rejects(requireProject(foreign, request), error => error instanceof HttpError && error.status === 404)
    assert.equal((await requireProject(own, request)).project.id, own)
  } finally {
    globalThis.fetch = originalFetch
    if (originalURL === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalURL
    if (originalKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey
  }
})

test("auth fails promptly with clear errors on upstream outage or timeout without probing secondary workspace", async (t) => {
  const env = {
    NEXT_PUBLIC_PERSONAL_SUPABASE_URL: "https://personal-timeout-test.supabase.co",
    NEXT_PUBLIC_PERSONAL_SUPABASE_ANON_KEY: "test-personal-anon",
    NEXT_PUBLIC_ENTERPRISE_SUPABASE_URL: "https://enterprise-timeout-test.supabase.co",
    NEXT_PUBLIC_ENTERPRISE_SUPABASE_ANON_KEY: "test-enterprise-anon",
  }
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  await t.test("upstream 503 during Personal auth returns 503 immediately and skips Enterprise fallback", async (st) => {
    const hostsHit: string[] = []
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      hostsHit.push(url.hostname)
      return Response.json({ message: "upstream unavailable" }, { status: 503 })
    })

    const req = new Request("https://app.invalid/api/chat", {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "11111111-1111-4111-8111-111111111111", query: "Hello?", stream: false }),
    })
    const res = await chatPost(req)
    assert.equal(res.status, 503)
    const body = await res.json()
    assert.match(body.error, /Unable to verify your session/i)
    assert.deepEqual(hostsHit, ["personal-timeout-test.supabase.co"])
  })

  await t.test("hung auth request aborts promptly with 504 instead of hanging ~70s and skips Enterprise fallback", async (st) => {
    const hostsHit: string[] = []
    st.mock.timers.enable({ apis: ["setTimeout"] })
    const perReqController = new AbortController()
    st.mock.method(AbortSignal, "timeout", (ms: number) => {
      if (ms === 5000) return perReqController.signal
      return new AbortController().signal
    })
    st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      hostsHit.push(url.hostname)
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))
        }, { once: true })
      })
    })

    const req = new Request("https://app.invalid/api/chat", {
      headers: { Authorization: "Bearer hung-token" },
    })
    const pending = requireChatProject("11111111-1111-4111-8111-111111111111", req)
    const assertion = assert.rejects(
      pending,
      (error) => error instanceof HttpError && error.status === 504 && /timed out/i.test(error.message),
    )
    // Trigger per-request timeout synchronously and advance virtual timer for overall auth budget if needed.
    await new Promise((resolve) => setImmediate(resolve))
    perReqController.abort(new DOMException("timeout", "TimeoutError"))
    st.mock.timers.tick(8000)
    await assertion
    assert.deepEqual(hostsHit, ["personal-timeout-test.supabase.co"])
  })

  await t.test("GoTrue retryable network outage stops after bounded attempts instead of 30s spin", async (st) => {
    let calls = 0
    st.mock.method(globalThis, "fetch", async () => {
      calls++
      throw new TypeError("fetch failed")
    })
    const req = new Request("https://app.invalid/api/chat", {
      headers: { Authorization: "Bearer test-token" },
    })
    await assert.rejects(
      requireUser(req, "enterprise"),
      (error) => error instanceof HttpError && error.status === 503 && /Unable to verify your session/i.test(error.message),
    )
    assert.equal(calls, 1)
  })
})

