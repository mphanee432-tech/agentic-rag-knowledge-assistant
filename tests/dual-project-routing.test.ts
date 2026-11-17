import assert from "node:assert/strict"
import test from "node:test"
import { NextRequest } from "next/server"
import { GET as listProjects } from "../app/api/projects/route"
import { GET as listDepartments } from "../app/api/enterprise/departments/route"
import { POST as chat } from "../app/api/chat/route"
import { proxy } from "../proxy"

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url")
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.sig`
}

const DUAL_ENV = {
  NEXT_PUBLIC_PERSONAL_SUPABASE_URL: "https://smhzdovflyuqznpcxype.supabase.co",
  NEXT_PUBLIC_PERSONAL_SUPABASE_ANON_KEY: makeJwt({ role: "anon", ref: "smhzdovflyuqznpcxype" }),
  PERSONAL_SUPABASE_SERVICE_ROLE_KEY: makeJwt({ role: "service_role", ref: "smhzdovflyuqznpcxype" }),
  NEXT_PUBLIC_ENTERPRISE_SUPABASE_URL: "https://cpowlkptvtnkjkulveph.supabase.co",
  NEXT_PUBLIC_ENTERPRISE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_ent_test",
  ENTERPRISE_SUPABASE_SECRET_KEY: "sb_secret_ent_test",
} as const

function withDualEnv(t: test.TestContext) {
  const previous = Object.fromEntries(Object.keys(DUAL_ENV).map((k) => [k, process.env[k]]))
  Object.assign(process.env, DUAL_ENV)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test("dual-project routes isolate Personal and Enterprise Supabase calls and reject cross-project tokens", async (t) => {
  withDualEnv(t)

  const seenCalls: Array<{ host: string; apikey: string | null; auth: string | null; path: string }> = []
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const headers = new Headers(init?.headers)
    const apikey = headers.get("apikey")
    const auth = headers.get("authorization")
    seenCalls.push({ host: url.hostname, apikey, auth, path: url.pathname })

    if (url.pathname === "/auth/v1/user") {
      if (url.hostname === "smhzdovflyuqznpcxype.supabase.co" && auth === "Bearer personal-jwt") {
        return Response.json({ id: "personal-user", aud: "authenticated", role: "authenticated" })
      }
      if (url.hostname === "cpowlkptvtnkjkulveph.supabase.co" && auth === "Bearer enterprise-jwt") {
        return Response.json({ id: "enterprise-user", aud: "authenticated", role: "authenticated" })
      }
      return Response.json({ message: "Invalid JWT" }, { status: 401 })
    }

    if (url.hostname === "smhzdovflyuqznpcxype.supabase.co" && url.pathname === "/rest/v1/projects") {
      return Response.json([{ id: "11111111-1111-4111-8111-111111111111", name: "My Personal Project" }])
    }

    if (
      url.hostname === "cpowlkptvtnkjkulveph.supabase.co" &&
      url.pathname === "/rest/v1/rpc/enterprise_policy_departments"
    ) {
      return Response.json([{ id: "dept-eng", name: "Engineering" }])
    }

    return Response.json({}, { status: 404 })
  })

  // Personal route ignores forged ?workspace=enterprise and validates strictly against Personal Supabase
  const personalOk = await listProjects(
    new Request("https://app.invalid/api/projects?workspace=enterprise", {
      headers: { Authorization: "Bearer personal-jwt" },
    }),
  )
  assert.equal(personalOk.status, 200)

  const personalWithEnterpriseJwt = await listProjects(
    new Request("https://app.invalid/api/projects", {
      headers: { Authorization: "Bearer enterprise-jwt" },
    }),
  )
  assert.equal(personalWithEnterpriseJwt.status, 401)

  const orgId = "55555555-5555-4555-8555-555555555555"
  const entWithPersonalJwt = await listDepartments(
    new Request(`https://app.invalid/api/enterprise/departments?organizationId=${orgId}`, {
      headers: { Authorization: "Bearer personal-jwt" },
    }),
  )
  assert.equal(entWithPersonalJwt.status, 401)

  const chatWithPersonalJwt = await chat(
    new Request("https://app.invalid/api/chat", {
      method: "POST",
      headers: { Authorization: "Bearer personal-jwt", "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: orgId, query: "Parental leave?", stream: false }),
    }),
  )
  assert.equal(chatWithPersonalJwt.status, 401)

  const entOk = await listDepartments(
    new Request(`https://app.invalid/api/enterprise/departments?organizationId=${orgId}`, {
      headers: { Authorization: "Bearer enterprise-jwt" },
    }),
  )
  assert.equal(entOk.status, 200)
  assert.ok(seenCalls.some((c) => c.host === "cpowlkptvtnkjkulveph.supabase.co" && c.apikey === "sb_publishable_ent_test"))
  assert.ok(!seenCalls.some((c) => c.host === "smhzdovflyuqznpcxype.supabase.co" && c.apikey === "sb_publishable_ent_test"))
  assert.ok(!seenCalls.some((c) => c.host === "cpowlkptvtnkjkulveph.supabase.co" && c.apikey === DUAL_ENV.NEXT_PUBLIC_PERSONAL_SUPABASE_ANON_KEY))
})

test("proxy routes Enterprise PKCE recovery to Enterprise Supabase and keeps dual cookies separate", async (t) => {
  withDualEnv(t)

  const hostsHit: string[] = []
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    hostsHit.push(url.hostname)
    if (url.pathname === "/auth/v1/token") {
      return Response.json({
        access_token: "ent-recovery-access",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "ent-recovery-refresh",
        user: { id: "ent-user-1", email: "eng@example.com" },
      })
    }
    return Response.json({ message: "Unauthorized" }, { status: 401 })
  })

  const verifierCookie = `sb-cpowlkptvtnkjkulveph-auth-token-code-verifier=${encodeURIComponent(JSON.stringify("verifier-ent"))}`
  const req = new NextRequest("http://localhost:3000/reset-password?code=pkce-ent&workspace=enterprise", {
    headers: { cookie: verifierCookie },
  })
  const res = await proxy(req)
  assert.equal(res.status, 307)
  assert.equal(res.headers.get("location"), "http://localhost:3000/reset-password?workspace=enterprise")
  const setCookie = res.headers.get("set-cookie") ?? ""
  assert.ok(setCookie.includes("sb-cpowlkptvtnkjkulveph-auth-token"))
  assert.ok(!setCookie.includes("sb-smhzdovflyuqznpcxype-auth-token"))
  assert.deepEqual(hostsHit, ["cpowlkptvtnkjkulveph.supabase.co"])
})

