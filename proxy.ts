import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

type CookieToSet = {
  name: string
  value: string
  options?: Parameters<NextResponse["cookies"]["set"]>[2]
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })
  const cookiesToSet: CookieToSet[] = []

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookies) => {
          cookiesToSet.push(...cookies)
          cookies.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
        },
      },
    },
  )

  const code = request.nextUrl.searchParams.get("code")
  const tokenHash = request.nextUrl.searchParams.get("token_hash")
  const type = request.nextUrl.searchParams.get("type")
  const isRecoveryPath = request.nextUrl.pathname === "/reset-password"

  if (code) {
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
  } else {
    await supabase.auth.getUser()
  }

  return response
}

export const config = { matcher: ["/", "/project/:path*", "/login", "/reset-password"] }

