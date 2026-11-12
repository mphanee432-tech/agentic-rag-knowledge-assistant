export interface ChatMessageInput { role: "user" | "assistant"; content: string }
export function parseChatInput(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Invalid request.")
  const body = value as Record<string, unknown>
  const vars = body.vars && typeof body.vars === "object" ? body.vars as Record<string, unknown> : {}
  const projectId = body.projectId || vars.projectId || body.project_id || vars.project_id
  if (typeof projectId !== "string" || !/^[0-9a-f-]{36}$/i.test(projectId)) throw new Error("A valid project ID is required.")
  const messages: ChatMessageInput[] = []
  for (const item of (Array.isArray(body.messages) ? body.messages.slice(-9) : [])) {
    if (!item || typeof item !== "object") continue
    const message = item as Record<string, unknown>
    if ((message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") continue
    if (message.content.trim()) messages.push({ role: message.role, content: message.content.trim().slice(0, 3000) })
  }
  const last = messages.at(-1)
  const query = body.query || vars.query || body.prompt || vars.prompt || body.message || (last?.role === "user" ? last.content : "")
  if (typeof query !== "string" || !query.trim() || query.trim().length > 2500) throw new Error("Query must contain 1–2,500 characters.")
  const userQuery = query.trim()
  if (last?.role !== "user" || last.content !== userQuery) messages.push({ role: "user", content: userQuery })
  const variant = body.promptVariant || vars.promptVariant
  return { projectId, userQuery, boundedHistory: messages.slice(-10),
    promptVariant: typeof variant === "string" ? variant : "strict",
    isEvalMode: body.stream === false || body.stream === "false",
    wantsStream: body.stream === true || body.stream === "true" }
}

