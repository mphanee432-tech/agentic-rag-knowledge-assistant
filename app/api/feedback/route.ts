import { apiError, HttpError, requireProject, requireUser } from "@/lib/auth"
export async function POST(req: Request) {
  try {
    const { supabase } = await requireUser(req)
    const { interactionId, rating, issueTag, comment } = await req.json()
    if (typeof interactionId !== "string" || !["thumbs_up", "thumbs_down"].includes(rating) ||
        (comment != null && (typeof comment !== "string" || comment.length > 2000)) ||
        (issueTag != null && (typeof issueTag !== "string" || issueTag.length > 100))) {
      throw new HttpError(400, "Invalid feedback.")
    }
    const { data, error } = await supabase.from("interactions").select("project_id").eq("id", interactionId).maybeSingle()
    if (error) throw error
    if (!data) throw new HttpError(404, "Interaction not found.")
    await requireProject(data.project_id, req)
    const feedback = { rating, issue_tag: issueTag || null, comment: comment || null, updated_at: new Date().toISOString() }
    const { data: updated, error: updateError } = await supabase.from("interactions").update({ feedback })
      .eq("id", interactionId).eq("project_id", data.project_id).select("id").maybeSingle()
    if (updateError) throw updateError
    if (!updated) throw new HttpError(404, "Interaction not found.")
    return Response.json({ success: true, feedback })
  } catch (error) { return apiError(error) }
}
