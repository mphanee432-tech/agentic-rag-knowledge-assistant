import assert from "node:assert/strict"
import test from "node:test"
import { NextRequest } from "next/server"
import { config as proxyConfig, proxy } from "../proxy"

test("proxy matches /reset-password and exchanges PKCE recovery code once then redirects cleanly", async (t) => {
  assert.ok(proxyConfig.matcher.includes("/reset-password"))

  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const previousKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://cpowlkptvtnkjkulveph.supabase.co"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key"

  const originalFetch = globalThis.fetch
  let tokenExchangeCalls = 0
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname === "/auth/v1/token") {
      tokenExchangeCalls += 1
      return Response.json({
        access_token: "recovery-access-token",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "recovery-refresh-token",
        user: { id: "user-123", email: "user@example.com" },
      })
    }
    return Response.json({}, { status: 404 })
  }

  t.after(() => {
    globalThis.fetch = originalFetch
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl
    if (previousKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousKey
  })

  const verifierCookie = `sb-cpowlkptvtnkjkulveph-auth-token-code-verifier=${encodeURIComponent(JSON.stringify("test-verifier"))}`
  const request = new NextRequest("http://localhost:3000/reset-password?code=pkce-code-123", {
    headers: {
      cookie: verifierCookie,
    },
  })
  const response = await proxy(request)

  assert.equal(tokenExchangeCalls, 1)
  assert.equal(response.status, 307)
  const location = response.headers.get("location")
  assert.equal(location, "http://localhost:3000/reset-password")
  const setCookieHeader = response.headers.get("set-cookie") ?? ""
  assert.ok(setCookieHeader.includes("sb-cpowlkptvtnkjkulveph-auth-token"))
})

test("proxy redirects invalid or expired recovery code on /reset-password with error param", async (t) => {
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const previousKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://cpowlkptvtnkjkulveph.supabase.co"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key"

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname === "/auth/v1/token") {
      return Response.json({ error: "invalid_grant", error_description: "Code expired" }, { status: 400 })
    }
    return Response.json({}, { status: 404 })
  }

  t.after(() => {
    globalThis.fetch = originalFetch
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl
    if (previousKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousKey
  })

  const verifierCookie = `sb-cpowlkptvtnkjkulveph-auth-token-code-verifier=${encodeURIComponent(JSON.stringify("test-verifier"))}`
  const request = new NextRequest("http://localhost:3000/reset-password?code=expired-code", {
    headers: {
      cookie: verifierCookie,
    },
  })
  const response = await proxy(request)

  assert.equal(response.status, 307)
  assert.equal(
    response.headers.get("location"),
    "http://localhost:3000/reset-password?error=recovery_link_invalid",
  )
})

test("proxy verifies token_hash recovery link on /reset-password and strips query params", async (t) => {
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const previousKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://cpowlkptvtnkjkulveph.supabase.co"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key"

  const originalFetch = globalThis.fetch
  let verifyCalls = 0
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname === "/auth/v1/verify") {
      verifyCalls += 1
      return Response.json({
        access_token: "otp-access-token",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "otp-refresh-token",
        user: { id: "user-123", email: "user@example.com" },
      })
    }
    return Response.json({}, { status: 404 })
  }

  t.after(() => {
    globalThis.fetch = originalFetch
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl
    if (previousKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousKey
  })

  const request = new NextRequest("http://localhost:3000/reset-password?token_hash=hash-123&type=recovery")
  const response = await proxy(request)

  assert.equal(verifyCalls, 1)
  assert.equal(response.status, 307)
  assert.equal(response.headers.get("location"), "http://localhost:3000/reset-password")
})

