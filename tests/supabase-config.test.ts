import assert from "node:assert/strict"
import test from "node:test"
import {
  getSupabaseAuthCookieName,
  resolveAdminSupabaseConfig,
  resolvePublicSupabaseConfig,
  resolveWorkspaceAdminSupabaseConfig,
  resolveWorkspacePublicSupabaseConfig,
  type ScopedSupabaseEnvMap,
} from "../lib/supabase/config"

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url")
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.sig`
}

test("resolvePublicSupabaseConfig prefers publishable key and falls back to legacy anon key", () => {
  const legacyAnon = makeJwt({ role: "anon", ref: "smhzdovflyuqznpcxype" })

  const modern = resolvePublicSupabaseConfig({
    url: "https://cpowlkptvtnkjkulveph.supabase.co",
    publishableKey: "sb_publishable_test_key",
    anonKey: makeJwt({ role: "anon", ref: "cpowlkptvtnkjkulveph" }),
  })
  assert.equal(modern.key, "sb_publishable_test_key")

  const legacy = resolvePublicSupabaseConfig({
    url: "https://smhzdovflyuqznpcxype.supabase.co",
    anonKey: legacyAnon,
  })
  assert.equal(legacy.key, legacyAnon)
})

test("resolveAdminSupabaseConfig prefers secret key and falls back to legacy service_role key", () => {
  const legacyService = makeJwt({ role: "service_role", ref: "smhzdovflyuqznpcxype" })

  const modern = resolveAdminSupabaseConfig({
    url: "https://cpowlkptvtnkjkulveph.supabase.co",
    secretKey: "sb_secret_test_key",
    serviceRoleKey: makeJwt({ role: "service_role", ref: "cpowlkptvtnkjkulveph" }),
  })
  assert.equal(modern.key, "sb_secret_test_key")

  const legacy = resolveAdminSupabaseConfig({
    url: "https://smhzdovflyuqznpcxype.supabase.co",
    serviceRoleKey: legacyService,
  })
  assert.equal(legacy.key, legacyService)
})

test("config helpers reject wrong key types and cross-project URL/key mismatches", () => {
  const personalAnon = makeJwt({ role: "anon", ref: "smhzdovflyuqznpcxype" })
  const enterpriseService = makeJwt({ role: "service_role", ref: "cpowlkptvtnkjkulveph" })

  assert.throws(
    () =>
      resolvePublicSupabaseConfig({
        url: "https://cpowlkptvtnkjkulveph.supabase.co",
        publishableKey: "sb_secret_wrong_place",
      }),
    /secret key/i,
  )

  assert.throws(
    () =>
      resolveAdminSupabaseConfig({
        url: "https://cpowlkptvtnkjkulveph.supabase.co",
        secretKey: "sb_publishable_wrong_place",
      }),
    /publishable key/i,
  )

  assert.throws(
    () =>
      resolvePublicSupabaseConfig({
        url: "https://cpowlkptvtnkjkulveph.supabase.co",
        anonKey: personalAnon,
      }),
    /does not match/i,
  )

  assert.throws(
    () =>
      resolvePublicSupabaseConfig({
        url: "https://smhzdovflyuqznpcxype.supabase.co",
        publishableKey: "sb_publishable_enterprise_key",
        anonKey: makeJwt({ role: "anon", ref: "cpowlkptvtnkjkulveph" }),
      }),
    /does not match/i,
  )

  assert.throws(
    () =>
      resolveAdminSupabaseConfig({
        url: "https://smhzdovflyuqznpcxype.supabase.co",
        serviceRoleKey: enterpriseService,
      }),
    /does not match/i,
  )
})

test("dual-project scoped config resolves independent projects and distinct auth cookie names", () => {
  const envMap: ScopedSupabaseEnvMap = {
    personalUrl: "https://smhzdovflyuqznpcxype.supabase.co",
    personalAnonKey: makeJwt({ role: "anon", ref: "smhzdovflyuqznpcxype" }),
    personalServiceRoleKey: makeJwt({ role: "service_role", ref: "smhzdovflyuqznpcxype" }),
    enterpriseUrl: "https://cpowlkptvtnkjkulveph.supabase.co",
    enterprisePublishableKey: "sb_publishable_enterprise_key",
    enterpriseSecretKey: "sb_secret_enterprise_key",
    genericUrl: "https://smhzdovflyuqznpcxype.supabase.co",
    genericAnonKey: makeJwt({ role: "anon", ref: "smhzdovflyuqznpcxype" }),
    genericServiceRoleKey: makeJwt({ role: "service_role", ref: "smhzdovflyuqznpcxype" }),
  }

  const personalPublic = resolveWorkspacePublicSupabaseConfig("personal", envMap)
  const enterprisePublic = resolveWorkspacePublicSupabaseConfig("enterprise", envMap)
  assert.equal(personalPublic.projectRef, "smhzdovflyuqznpcxype")
  assert.equal(enterprisePublic.projectRef, "cpowlkptvtnkjkulveph")
  assert.equal(enterprisePublic.key, "sb_publishable_enterprise_key")
  assert.equal(personalPublic.cookieName, "sb-smhzdovflyuqznpcxype-auth-token")
  assert.equal(enterprisePublic.cookieName, "sb-cpowlkptvtnkjkulveph-auth-token")
  assert.notEqual(personalPublic.cookieName, enterprisePublic.cookieName)

  const personalAdmin = resolveWorkspaceAdminSupabaseConfig("personal", envMap)
  const enterpriseAdmin = resolveWorkspaceAdminSupabaseConfig("enterprise", envMap)
  assert.equal(personalAdmin.url, "https://smhzdovflyuqznpcxype.supabase.co")
  assert.equal(enterpriseAdmin.url, "https://cpowlkptvtnkjkulveph.supabase.co")
  assert.equal(enterpriseAdmin.key, "sb_secret_enterprise_key")

  assert.equal(
    getSupabaseAuthCookieName("https://tenant-custom.invalid", "enterprise"),
    "sb-enterprise-auth-token",
  )

  assert.throws(
    () =>
      resolveWorkspacePublicSupabaseConfig("enterprise", {
        ...envMap,
        enterpriseUrl: envMap.personalUrl,
      }),
    /distinct/i,
  )

  assert.throws(
    () =>
      resolveWorkspacePublicSupabaseConfig("enterprise", {
        personalUrl: envMap.personalUrl,
        personalAnonKey: envMap.personalAnonKey,
        genericUrl: envMap.genericUrl,
        genericAnonKey: envMap.genericAnonKey,
      }),
    /Missing NEXT_PUBLIC_ENTERPRISE_SUPABASE_URL/i,
  )
})

