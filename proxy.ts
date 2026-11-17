import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import {
  isDualProjectConfigured,
  normalizeWorkspaceScope,
  readPublicEnvForBrowser,
  resolveWorkspacePublicSupabaseConfig,
  type WorkspaceScope,
} from "@/lib/supabase/config"

type CookieToSet = {
  name: string
  value: string
  options?: Parameters<NextResponse["cookies"]["set"]>[2]
}

function detectAuthCallbackScope(request: NextRequest, scopes: WorkspaceScope[]): WorkspaceScope {
  const explicit = request.nextUrl.searchParams.get("workspace")
  if (explicit === "personal" || explicit === "enterprise") {
    return explicit
  }

  const code = request.nextUrl.searchParams.get("code")
  if (code) {
    const env = readPublicEnvForBrowser()
    const requestCookies = request.cookies.getAll()
    for (const candidate of ["enterprise", "personal"] as const) {
      if (!scopes.includes(candidate)) continue
      try {
        const { cookieName } = resolveWorkspacePublicSupabaseConfig(candidate, env)
        const verifierPrefix = `${cookieName}-code-verifier`
        if (requestCookies.some((c) => c.name === verifierPrefix || c.name.startsWith(`${verifierPrefix}.`))) {
          return candidate
        }
      } catch {
        // Ignore unconfigured workspace during detection.
      }
    }
  }

  if (request.nextUrl.searchParams.get("tab") === "enterprise" || request.nextUrl.pathname.startsWith("/enterprise")) {
    return "enterprise"
  }

  return normalizeWorkspaceScope(explicit, "personal")
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })
  const cookiesToSet: CookieToSet[] = []
  const env = readPublicEnvForBrowser()
  const dualConfigured = isDualProjectConfigured(env)
  const configuredScopes: WorkspaceScope[] = dualConfigured ? ["personal", "enterprise"] : ["personal"]

  const createScopedClient = (scope: WorkspaceScope) => {
    const { url, key, cookieName } = resolveWorkspacePublicSupabaseConfig(scope, env)
    return {
      cookieName,
      client: createServerClient(url, key, {
        cookieOptions: { name: cookieName },
        cookies: {
          getAll: () => request.cookies.getAll(),
          setAll: (cookies) => {
            cookiesToSet.push(...cookies)
            cookies.forEach(({ name, value }) => request.cookies.set(name, value))
            response = NextResponse.next({ request })
            cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
          },
        },
      }),
    }
  }

  const code = request.nextUrl.searchParams.get("code")
  const tokenHash = request.nextUrl.searchParams.get("token_hash")
  const type = request.nextUrl.searchParams.get("type")
  const isRecoveryPath = request.nextUrl.pathname === "/reset-password"

  if (code) {
    const targetScope = detectAuthCallbackScope(request, configuredScopes)
    const { client: supabase } = createScopedClient(targetScope)
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (isRecoveryPath) {
      const redirectUrl = request.nextUrl.clone()
      redirectUrl.searchParams.delete("code")
      redirectUrl.searchParams.delete("token_hash")
      redirectUrl.searchParams.delete("type")
      if (error) {
        redirectUrl.searchParams.set("error", "recovery_link_invalid")
      }
      const redirectResponse = NextResponse.redirect(redirectUrl)
      cookiesToSet.forEach(({ name, value, options }) => {
        redirectResponse.cookies.set(name, value, options)
      })
      return redirectResponse
    }
  } else if (tokenHash && (type === "signup" || type === "email" || type === "recovery")) {
    const targetScope = detectAuthCallbackScope(request, configuredScopes)
    const { client: supabase } = createScopedClient(targetScope)
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
    if (isRecoveryPath) {
      const redirectUrl = request.nextUrl.clone()
      redirectUrl.searchParams.delete("token_hash")
      redirectUrl.searchParams.delete("type")
      if (error) {
        redirectUrl.searchParams.set("error", "recovery_link_invalid")
      }
      const redirectResponse = NextResponse.redirect(redirectUrl)
      cookiesToSet.forEach(({ name, value, options }) => {
        redirectResponse.cookies.set(name, value, options)
      })
      return redirectResponse
    }
  } else if (dualConfigured) {
    const requestCookies = request.cookies.getAll()
    for (const scope of configuredScopes) {
      const { client: supabase, cookieName } = createScopedClient(scope)
      const hasSessionCookie = requestCookies.some(
        (c) => c.name === cookieName || c.name.startsWith(`${cookieName}.`),
      )
      if (hasSessionCookie) {
        await supabase.auth.getUser()
      }
    }
  } else {
    const { client: supabase } = createScopedClient("personal")
    await supabase.auth.getUser()
  }

  return response
}

export const config = { matcher: ["/", "/enterprise", "/project/:path*", "/login", "/reset-password"] }

