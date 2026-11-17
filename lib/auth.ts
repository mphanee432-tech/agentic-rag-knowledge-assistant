import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import {
  isDualProjectConfigured,
  readPublicEnvForBrowser,
  resolveWorkspacePublicSupabaseConfig,
  type WorkspaceScope,
} from "@/lib/supabase/config"
import { createServerClient } from "@/lib/supabase/server"

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
export async function requireUser(req?: Request, scope: WorkspaceScope = "personal") {
  const token = req?.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1]
  let supabase: SupabaseClient
  if (token) {
    const { url, key } = resolveWorkspacePublicSupabaseConfig(scope, readPublicEnvForBrowser())
    supabase = createClient(url, key, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
  } else {
    supabase = await createServerClient(scope)
  }
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) throw new HttpError(401, "Sign in to continue.")
  return { supabase, user, scope }
}

export interface EnterpriseAccountStatusRow {
  organization_id: string
  organization_name: string
  department_id?: string | null
  department_name?: string | null
  role: string
  is_active: boolean
}

export async function getEnterpriseCopilotContext(supabase: SupabaseClient, organizationId?: string) {
  const { data, error } = await supabase.rpc("enterprise_copilot_context", {
    target_organization_id: organizationId ?? null,
  }).maybeSingle<{ organization_id: string; can_upload_policy: boolean }>()
  // The original Personal RAG database has no enterprise functions.
  if (error && !(organizationId === undefined && ["PGRST202", "42883"].includes(error.code))) {
    throw new HttpError(500, "Unable to load enterprise access.")
  }
  return data
}

export async function getEnterpriseAccountStatus(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .rpc("enterprise_account_status")
    .maybeSingle<EnterpriseAccountStatusRow>()
  // Personal RAG has no enterprise functions.
  if (error && !["PGRST202", "42883"].includes(error.code)) {
    throw new HttpError(500, "Unable to load enterprise account status.")
  }
  return data
}

export async function getDemoJiraAccess(supabase: SupabaseClient): Promise<boolean | null> {
  const { data, error } = await supabase
    .from("demo_jira_access")
    .select("enabled")
    .maybeSingle<{ enabled: boolean }>()
  // Personal RAG has no demo_jira_access table.
  if (error && !["PGRST205", "42P01"].includes(error.code)) {
    throw new HttpError(500, "Unable to verify Jira demo access.")
  }
  if (!data || typeof data.enabled !== "boolean") {
    return null
  }
  return data.enabled
}

export async function requireJiraAccess(
  supabase: SupabaseClient,
  organizationId?: unknown,
): Promise<void> {
  if (organizationId !== undefined) {
    if (typeof organizationId !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(organizationId)) {
      throw new HttpError(400, "A valid organization ID is required.")
    }
    if (!(await getEnterpriseCopilotContext(supabase, organizationId))) {
      throw new HttpError(403, "Active membership in this organization is required.")
    }
  } else {
    const accountStatus = await getEnterpriseAccountStatus(supabase)
    if (accountStatus && !accountStatus.is_active) {
      throw new HttpError(403, "Jira access is not enabled for this account.")
    }
  }

  if ((await getDemoJiraAccess(supabase)) !== true) {
    throw new HttpError(403, "Jira access is not enabled for this account.")
  }
}

export async function isJiraAccessAvailable(
  supabase: SupabaseClient,
  organizationId?: string | null,
): Promise<boolean> {
  try {
    const [demoAccess, accountStatus] = await Promise.all([
      getDemoJiraAccess(supabase),
      getEnterpriseAccountStatus(supabase),
    ])
    if (demoAccess !== true) {
      return false
    }
    if (accountStatus && !accountStatus.is_active) {
      return false
    }
    if (organizationId) {
      return Boolean(await getEnterpriseCopilotContext(supabase, organizationId))
    }
    return true
  } catch {
    return false
  }
}
async function findOwnedProject(auth: Awaited<ReturnType<typeof requireUser>>, projectId: unknown) {
  if (typeof projectId !== "string" || !/^[0-9a-f-]{36}$/i.test(projectId)) {
    throw new HttpError(400, "A valid project ID is required.")
  }
  const { data: project, error } = await auth.supabase.from("projects")
    .select("id, name, user_id, suggested_queries, created_at")
    .eq("id", projectId).eq("user_id", auth.user.id).maybeSingle()
  if (error) throw new HttpError(500, "Unable to load project.")
  return project
}
export async function requireProject(projectId: unknown, req?: Request) {
  const auth = await requireUser(req, "personal")
  const project = await findOwnedProject(auth, projectId)
  if (!project) throw new HttpError(404, "Project not found.")
  return { ...auth, project }
}
export async function requireChatProject(projectId: string, req?: Request) {
  if (!isDualProjectConfigured(readPublicEnvForBrowser())) {
    const auth = await requireUser(req, "personal")
    const project = await findOwnedProject(auth, projectId)
    if (project) return { ...auth, project, enterprise: false }
    const { data, error } = await auth.supabase.rpc("enterprise_chat_projects", { target_project_id: projectId }).maybeSingle<{ id: string; name: string }>()
    if (error) throw new HttpError(500, "Unable to load project.")
    if (!data) throw new HttpError(404, "Project not found.")
    return { ...auth, project: data, enterprise: true }
  }

  let personalAuth: Awaited<ReturnType<typeof requireUser>> | null = null
  try {
    personalAuth = await requireUser(req, "personal")
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 401)) throw error
  }
  if (personalAuth) {
    const project = await findOwnedProject(personalAuth, projectId)
    if (project) return { ...personalAuth, project, enterprise: false }
  }

  let enterpriseAuth: Awaited<ReturnType<typeof requireUser>> | null = null
  try {
    enterpriseAuth = await requireUser(req, "enterprise")
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 401)) throw error
  }
  if (!enterpriseAuth) {
    if (personalAuth) throw new HttpError(404, "Project not found.")
    throw new HttpError(401, "Sign in to continue.")
  }

  if (typeof projectId !== "string" || !/^[0-9a-f-]{36}$/i.test(projectId)) {
    throw new HttpError(400, "A valid project ID is required.")
  }
  const { data, error } = await enterpriseAuth.supabase.rpc("enterprise_chat_projects", { target_project_id: projectId }).maybeSingle<{ id: string; name: string }>()
  if (error) throw new HttpError(500, "Unable to load project.")
  if (!data) throw new HttpError(404, "Project not found.")
  return { ...enterpriseAuth, project: data, enterprise: true }
}
export async function requireEnterpriseUploader(projectId: string, req?: Request) {
  const auth = await requireUser(req, "enterprise")
  if (typeof projectId !== "string" || !/^[0-9a-f-]{36}$/i.test(projectId)) {
    throw new HttpError(400, "A valid project ID is required.")
  }
  const { data: canUpload, error } = await auth.supabase.rpc("can_upload_enterprise_policy", {
    p_project_id: projectId,
  })
  if (error || !canUpload) {
    throw new HttpError(403, "Enterprise upload authorization denied.")
  }
  return auth
}
export function apiError(error: unknown) {
  if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status })
  if (error instanceof SyntaxError) return Response.json({ error: "Invalid JSON payload." }, { status: 400 })
  console.error(error)
  return Response.json({ error: "The request could not be completed." }, { status: 500 })
}

