"use server"
import { normalizeWorkspaceScope, type WorkspaceScope } from "@/lib/supabase/config"
import { createServerClient } from "@/lib/supabase/server"

export async function signOut(workspace: WorkspaceScope = "personal") {
  const scope = normalizeWorkspaceScope(workspace, "personal")
  const supabase = await createServerClient(scope)
  const { error } = await supabase.auth.signOut({ scope: "local" })
  if (error) throw new Error("Unable to sign out.")
}

