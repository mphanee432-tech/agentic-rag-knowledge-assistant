export type WorkspaceScope = "personal" | "enterprise"

export interface PublicSupabaseEnvInput {
  url?: string
  publishableKey?: string
  anonKey?: string
}

export interface AdminSupabaseEnvInput {
  url?: string
  secretKey?: string
  serviceRoleKey?: string
}

export interface ScopedSupabaseEnvMap {
  personalUrl?: string
  personalPublishableKey?: string
  personalAnonKey?: string
  personalSecretKey?: string
  personalServiceRoleKey?: string
  enterpriseUrl?: string
  enterprisePublishableKey?: string
  enterpriseAnonKey?: string
  enterpriseSecretKey?: string
  enterpriseServiceRoleKey?: string
  genericUrl?: string
  genericPublishableKey?: string
  genericAnonKey?: string
  genericSecretKey?: string
  genericServiceRoleKey?: string
}

export interface ResolvedSupabaseConfig {
  url: string
  key: string
}

export interface ResolvedScopedSupabaseConfig extends ResolvedSupabaseConfig {
  scope: WorkspaceScope
  projectRef: string | null
  cookieName: string
}

export function normalizeWorkspaceScope(
  value: unknown,
  fallback: WorkspaceScope = "personal",
): WorkspaceScope {
  return value === "enterprise" || value === "personal" ? value : fallback
}

export function getSupabaseAuthCookieName(
  supabaseUrl: string,
  scope: WorkspaceScope = "personal",
): string {
  const ref = parseSupabaseProjectRef(supabaseUrl)
  return ref ? `sb-${ref}-auth-token` : `sb-${scope}-auth-token`
}

/** Static NEXT_PUBLIC_* reads so Next.js/Turbopack inlines dual-project public env vars into browser bundles. */
export function readPublicEnvForBrowser(): ScopedSupabaseEnvMap {
  return {
    personalUrl: process.env.NEXT_PUBLIC_PERSONAL_SUPABASE_URL,
    personalPublishableKey: process.env.NEXT_PUBLIC_PERSONAL_SUPABASE_PUBLISHABLE_KEY,
    personalAnonKey: process.env.NEXT_PUBLIC_PERSONAL_SUPABASE_ANON_KEY,
    enterpriseUrl: process.env.NEXT_PUBLIC_ENTERPRISE_SUPABASE_URL,
    enterprisePublishableKey: process.env.NEXT_PUBLIC_ENTERPRISE_SUPABASE_PUBLISHABLE_KEY,
    enterpriseAnonKey: process.env.NEXT_PUBLIC_ENTERPRISE_SUPABASE_ANON_KEY,
    genericUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    genericPublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    genericAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  }
}

export function isDualProjectConfigured(env: ScopedSupabaseEnvMap = readPublicEnvForBrowser()): boolean {
  return Boolean(env.personalUrl?.trim() && env.enterpriseUrl?.trim())
}

interface SupabaseJwtClaims {
  ref?: string
  role?: string
}

/** Extract project ref from standard hosted *.supabase.co URLs; returns null for custom/test hosts. */
export function parseSupabaseProjectRef(supabaseUrl: string): string | null {
  try {
    const hostname = new URL(supabaseUrl).hostname.toLowerCase()
    const match = hostname.match(/^([a-z0-9-]+)\.supabase\.co$/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/** Decode legacy Supabase JWT payload without throwing on non-JWT or opaque sb_* keys. */
export function parseSupabaseJwtClaims(token: string): SupabaseJwtClaims | null {
  if (!token.startsWith("eyJ")) return null
  const parts = token.split(".")
  if (parts.length !== 3 || !parts[1]) return null
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
    return {
      ref: typeof parsed.ref === "string" ? parsed.ref : undefined,
      role: typeof parsed.role === "string" ? parsed.role : undefined,
    }
  } catch {
    return null
  }
}

function assertKeyMatchesProjectUrl(supabaseUrl: string, key: string, label: string): void {
  const urlRef = parseSupabaseProjectRef(supabaseUrl)
  const claims = parseSupabaseJwtClaims(key)
  if (urlRef && claims?.ref && claims.ref !== urlRef) {
    throw new Error(`Supabase URL project (${urlRef}) does not match ${label} project (${claims.ref})`)
  }
}

/** Resolve public Supabase URL + key, preferring NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY over legacy anon. */
export function resolvePublicSupabaseConfig(input: PublicSupabaseEnvInput): ResolvedSupabaseConfig {
  const url = input.url?.trim() ?? ""
  const publishableKey = input.publishableKey?.trim() ?? ""
  const anonKey = input.anonKey?.trim() ?? ""
  const key = publishableKey || anonKey

  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables",
    )
  }
  if (key.startsWith("sb_secret_")) {
    throw new Error("Supabase secret key cannot be used in a public client")
  }

  const claims = parseSupabaseJwtClaims(key)
  if (claims?.role === "service_role") {
    throw new Error("Supabase service_role key cannot be used in a public client")
  }

  assertKeyMatchesProjectUrl(url, key, "public key")
  // Guard against mixed .env/.env.local configs where a legacy anon key from another project sits alongside an opaque publishable key.
  if (publishableKey && anonKey) {
    assertKeyMatchesProjectUrl(url, anonKey, "legacy anon key")
  }

  return { url, key }
}

/** Resolve privileged server Supabase URL + key, preferring SUPABASE_SECRET_KEY over legacy service_role. */
export function resolveAdminSupabaseConfig(input: AdminSupabaseEnvInput): ResolvedSupabaseConfig {
  const url = input.url?.trim() ?? ""
  const secretKey = input.secretKey?.trim() ?? ""
  const serviceRoleKey = input.serviceRoleKey?.trim() ?? ""
  const key = secretKey || serviceRoleKey

  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY environment variables",
    )
  }
  if (key.startsWith("sb_publishable_")) {
    throw new Error("Supabase publishable key cannot be used in an admin client")
  }

  const claims = parseSupabaseJwtClaims(key)
  if (claims?.role === "anon") {
    throw new Error("Supabase anon key cannot be used in an admin client")
  }

  assertKeyMatchesProjectUrl(url, key, "admin key")
  if (secretKey && serviceRoleKey) {
    assertKeyMatchesProjectUrl(url, serviceRoleKey, "legacy service_role key")
  }

  return { url, key }
}

function normalizeUrlOrigin(url: string): string {
  try {
    return new URL(url).origin.toLowerCase()
  } catch {
    return url.trim().toLowerCase()
  }
}

function assertDistinctProjectUrls(personalUrl?: string, enterpriseUrl?: string): void {
  const p = personalUrl?.trim() ?? ""
  const e = enterpriseUrl?.trim() ?? ""
  if (!p || !e) return
  const pRef = parseSupabaseProjectRef(p)
  const eRef = parseSupabaseProjectRef(e)
  if ((pRef && eRef && pRef === eRef) || normalizeUrlOrigin(p) === normalizeUrlOrigin(e)) {
    throw new Error("Personal and Enterprise Supabase projects must point to distinct projects")
  }
}

function pickScopedPublicInput(scope: WorkspaceScope, env: ScopedSupabaseEnvMap): PublicSupabaseEnvInput {
  const personalUrl = env.personalUrl?.trim() ?? ""
  const enterpriseUrl = env.enterpriseUrl?.trim() ?? ""
  const genericUrl = env.genericUrl?.trim() ?? ""
  assertDistinctProjectUrls(personalUrl, enterpriseUrl)

  if (scope === "enterprise") {
    if (enterpriseUrl) {
      return {
        url: enterpriseUrl,
        publishableKey: env.enterprisePublishableKey,
        anonKey: env.enterpriseAnonKey,
      }
    }
    if (personalUrl) {
      throw new Error(
        "Missing NEXT_PUBLIC_ENTERPRISE_SUPABASE_URL for Enterprise workspace while Personal workspace is configured",
      )
    }
    return {
      url: genericUrl,
      publishableKey: env.genericPublishableKey,
      anonKey: env.genericAnonKey,
    }
  }

  if (personalUrl) {
    const hasPersonalKey = Boolean(env.personalPublishableKey?.trim() || env.personalAnonKey?.trim())
    const genericMatchesPersonal = Boolean(genericUrl && normalizeUrlOrigin(genericUrl) === normalizeUrlOrigin(personalUrl))
    return {
      url: personalUrl,
      publishableKey: hasPersonalKey ? env.personalPublishableKey : genericMatchesPersonal ? env.genericPublishableKey : undefined,
      anonKey: hasPersonalKey ? env.personalAnonKey : genericMatchesPersonal ? env.genericAnonKey : undefined,
    }
  }

  return {
    url: genericUrl,
    publishableKey: env.genericPublishableKey,
    anonKey: env.genericAnonKey,
  }
}

function pickScopedAdminInput(scope: WorkspaceScope, env: ScopedSupabaseEnvMap): AdminSupabaseEnvInput {
  const personalUrl = env.personalUrl?.trim() ?? ""
  const enterpriseUrl = env.enterpriseUrl?.trim() ?? ""
  const genericUrl = env.genericUrl?.trim() ?? ""
  assertDistinctProjectUrls(personalUrl, enterpriseUrl)

  if (scope === "enterprise") {
    if (enterpriseUrl) {
      return {
        url: enterpriseUrl,
        secretKey: env.enterpriseSecretKey,
        serviceRoleKey: env.enterpriseServiceRoleKey,
      }
    }
    if (personalUrl) {
      throw new Error(
        "Missing NEXT_PUBLIC_ENTERPRISE_SUPABASE_URL for Enterprise admin client while Personal workspace is configured",
      )
    }
    return {
      url: genericUrl,
      secretKey: env.genericSecretKey,
      serviceRoleKey: env.genericServiceRoleKey,
    }
  }

  if (personalUrl) {
    const hasPersonalSecret = Boolean(env.personalSecretKey?.trim() || env.personalServiceRoleKey?.trim())
    const genericMatchesPersonal = Boolean(genericUrl && normalizeUrlOrigin(genericUrl) === normalizeUrlOrigin(personalUrl))
    return {
      url: personalUrl,
      secretKey: hasPersonalSecret ? env.personalSecretKey : genericMatchesPersonal ? env.genericSecretKey : undefined,
      serviceRoleKey: hasPersonalSecret ? env.personalServiceRoleKey : genericMatchesPersonal ? env.genericServiceRoleKey : undefined,
    }
  }

  return {
    url: genericUrl,
    secretKey: env.genericSecretKey,
    serviceRoleKey: env.genericServiceRoleKey,
  }
}

export function resolveWorkspacePublicSupabaseConfig(
  scope: WorkspaceScope = "personal",
  env: ScopedSupabaseEnvMap = readPublicEnvForBrowser(),
): ResolvedScopedSupabaseConfig {
  const { url, key } = resolvePublicSupabaseConfig(pickScopedPublicInput(scope, env))
  return {
    scope,
    url,
    key,
    projectRef: parseSupabaseProjectRef(url),
    cookieName: getSupabaseAuthCookieName(url, scope),
  }
}

export function resolveWorkspaceAdminSupabaseConfig(
  scope: WorkspaceScope = "personal",
  env: ScopedSupabaseEnvMap,
): ResolvedScopedSupabaseConfig {
  const { url, key } = resolveAdminSupabaseConfig(pickScopedAdminInput(scope, env))
  return {
    scope,
    url,
    key,
    projectRef: parseSupabaseProjectRef(url),
    cookieName: getSupabaseAuthCookieName(url, scope),
  }
}

