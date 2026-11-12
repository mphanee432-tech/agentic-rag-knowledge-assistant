import { apiError, HttpError, requireProject, requireUser } from "@/lib/auth"
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams
    const id = params.get("id") || params.get("projectId")
    if (id) return Response.json({ project: (await requireProject(id, req)).project })
    const { supabase, user } = await requireUser(req)
    const { data, error } = await supabase.from("projects").select("id, name, suggested_queries, created_at")
      .eq("user_id", user.id).order("created_at", { ascending: false })
    if (error) throw error
    return Response.json({ projects: data })
  } catch (error) { return apiError(error) }
}
export async function POST(req: Request) {
  try {
    const { supabase, user } = await requireUser(req)
    const body = await req.json()
    const name = typeof body.name === "string" ? body.name.trim() : "Untitled Project"
    if (!name || name.length > 60) throw new HttpError(400, "Name must contain 1–60 characters.")
    const { data, error } = await supabase.from("projects")
      .insert({ id: crypto.randomUUID(), user_id: user.id, name }).select().single()
    if (error) throw error
    return Response.json({ project: data }, { status: 201 })
  } catch (error) { return apiError(error) }
}
