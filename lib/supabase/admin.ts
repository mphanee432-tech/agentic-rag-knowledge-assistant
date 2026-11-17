import { createClient } from "@supabase/supabase-js"
import {
  readPublicEnvForBrowser,
  resolveWorkspaceAdminSupabaseConfig,
  type WorkspaceScope,
} from "@/lib/supabase/config"

export function createAdminClient(scope: WorkspaceScope = "personal") {
  const { url, key } = resolveWorkspaceAdminSupabaseConfig(scope, {
    ...readPublicEnvForBrowser(),
    personalSecretKey: process.env.PERSONAL_SUPABASE_SECRET_KEY,
    personalServiceRoleKey: process.env.PERSONAL_SUPABASE_SERVICE_ROLE_KEY,
    enterpriseSecretKey: process.env.ENTERPRISE_SUPABASE_SECRET_KEY,
    enterpriseServiceRoleKey: process.env.ENTERPRISE_SUPABASE_SERVICE_ROLE_KEY,
    genericSecretKey: process.env.SUPABASE_SECRET_KEY,
    genericServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  })

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}
