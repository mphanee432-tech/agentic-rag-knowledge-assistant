import test from "node:test"
import assert from "node:assert/strict"
import { requireProject, HttpError } from "../lib/auth"

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

