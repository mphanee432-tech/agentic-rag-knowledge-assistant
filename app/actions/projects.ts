"use server"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { requireProject, requireUser } from "@/lib/auth"
import { createAdminClient } from "@/lib/supabase/admin"

export async function createProject(nameOrFormData?: string | FormData) {
  const { supabase, user } = await requireUser(undefined, "personal")
  const raw = typeof nameOrFormData === "string" ? nameOrFormData : nameOrFormData?.get("name")
  const name = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 60) : "Untitled Project"
  const id = crypto.randomUUID()
  const { error } = await supabase.from("projects").insert({ id, user_id: user.id, name })
  if (error) throw new Error("Unable to create project.")
  redirect(`/project/${id}`)
}
export const createProjectAction = createProject
export async function renameProject(projectId: string, newName: string) {
  const { supabase, user } = await requireProject(projectId)
  const name = newName.trim()
  if (!name || name.length > 60) throw new Error("Project name must contain 1–60 characters.")
  const { error } = await supabase.from("projects").update({ name }).eq("id", projectId).eq("user_id", user.id)
  if (error) throw new Error("Unable to rename project.")
  revalidatePath("/")
  return { success: true }
}
export async function deleteProject(projectId: string) {
  const { supabase, user } = await requireProject(projectId)
  const { data: docs, error: readError } = await supabase.from("documents").select("storage_path").eq("project_id", projectId)
  if (readError) throw new Error("Unable to load project documents.")
  const { error } = await supabase.from("projects").delete().eq("id", projectId).eq("user_id", user.id)
  if (error) throw new Error("Unable to delete project.")
  if (docs?.length) {
    const { error: cleanup } = await createAdminClient().storage.from("documents").remove(docs.map(d => d.storage_path))
    if (cleanup) throw new Error("Project deleted, but storage cleanup failed. Contact your administrator.")
  }
  revalidatePath("/")
  return { success: true }
}
