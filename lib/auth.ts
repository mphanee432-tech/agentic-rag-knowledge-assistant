import { createClient } from "@supabase/supabase-js"
import { createServerClient } from "@/lib/supabase/server"

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
export async function requireUser(req?: Request) {
  const token = req?.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1]
  const supabase = token
    ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : await createServerClient()
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) throw new HttpError(401, "Sign in to continue.")
  return { supabase, user }
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
  const auth = await requireUser(req)
  const project = await findOwnedProject(auth, projectId)
  if (!project) throw new HttpError(404, "Project not found.")
  return { ...auth, project }
}
export async function requireChatProject(projectId: string, req?: Request) {
  const auth = await requireUser(req)
  const project = await findOwnedProject(auth, projectId)
  if (project) return { ...auth, project, enterprise: false }
  const { data, error } = await auth.supabase.rpc("enterprise_chat_projects", { target_project_id: projectId }).maybeSingle<{ id: string; name: string }>()
  if (error) throw new HttpError(500, "Unable to load project.")
  if (!data) throw new HttpError(404, "Project not found.")
  return { ...auth, project: data, enterprise: true }
}
export function apiError(error: unknown) {
  if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status })
  if (error instanceof SyntaxError) return Response.json({ error: "Invalid JSON payload." }, { status: 400 })
  console.error(error)
  return Response.json({ error: "The request could not be completed." }, { status: 500 })
}

