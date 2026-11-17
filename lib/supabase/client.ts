import { createBrowserClient as createSupabaseBrowserClient } from "@supabase/ssr"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  readPublicEnvForBrowser,
  resolveWorkspacePublicSupabaseConfig,
  type WorkspaceScope,
} from "@/lib/supabase/config"

const browserClients = new Map<string, SupabaseClient>()

export function createBrowserClient(scope: WorkspaceScope = "personal") {
  const { url, key, cookieName } = resolveWorkspacePublicSupabaseConfig(scope, readPublicEnvForBrowser())
  const cacheKey = `${scope}:${url}:${key}`
  const existing = browserClients.get(cacheKey)
  if (existing) {
    return existing
  }

  // @supabase/ssr caches a single module-global browser client unless isSingleton is false.
  const client = createSupabaseBrowserClient(url, key, {
    isSingleton: false,
    cookieOptions: {
      name: cookieName,
    },
  })
  browserClients.set(cacheKey, client)
  return client
}

export const createClient = createBrowserClient
