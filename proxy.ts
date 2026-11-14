import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: cookies => {
        cookies.forEach(({ name, value }) => request.cookies.set(name, value))
        response = NextResponse.next({ request })
        cookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
      },
    },
  })
  const code = request.nextUrl.searchParams.get("code")
  const tokenHash = request.nextUrl.searchParams.get("token_hash")
  const type = request.nextUrl.searchParams.get("type")
  if (code) {
    await supabase.auth.exchangeCodeForSession(code)
  } else if (tokenHash && (type === "signup" || type === "email")) {
    await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
  } else {
    await supabase.auth.getUser()
  }
  return response
}
export const config = { matcher: ["/", "/project/:path*", "/login"] }

