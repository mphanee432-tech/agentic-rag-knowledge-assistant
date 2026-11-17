import { createServerClient as createSupabaseServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import {
  readPublicEnvForBrowser,
  resolveWorkspacePublicSupabaseConfig,
  type WorkspaceScope,
} from "@/lib/supabase/config"

export const createClient = createServerClient

export async function createServerClient(scope: WorkspaceScope = "personal") {
  const cookieStore = await cookies()
  const { url, key, cookieName } = resolveWorkspacePublicSupabaseConfig(scope, readPublicEnvForBrowser())

  return createSupabaseServerClient(url, key, {
    cookieOptions: {
      name: cookieName,
    },
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        } catch {
          // The `setAll` method was called from a Server Component.
          // This can be ignored if you have middleware refreshing user sessions.
        }
      },
    },
  })
}
