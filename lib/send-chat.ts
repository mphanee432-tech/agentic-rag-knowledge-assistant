"use client"
import { readChatStream } from "@/lib/chat-contract"
import { useChatStore, type Citation } from "@/lib/store/chat-store"

export async function sendChat(query: string, projectId: string | null | undefined) {
  const store = useChatStore.getState()
  if (!projectId || !query.trim() || store.isLoading || store.activeProjectId !== projectId) return
  const history = store.messages.slice(-8).map(({ role, content }) => ({ role, content }))
  const messageId = crypto.randomUUID()
  store.addMessage({ id: crypto.randomUUID(), role: "user", content: query })
  store.addMessage({ id: messageId, role: "assistant", content: "", citations: [] })
  store.setIsLoading(true)
  store.setStatusMessage("Searching your documents…")
  const current = () => {
    const state = useChatStore.getState()
    return state.activeProjectId === projectId && state.messages.some(m => m.id === messageId)
  }
  let text = ""
  let citations: Citation[] = []
  let interactionId: string | undefined
  const update = () => {
    if (current()) useChatStore.setState(state => ({
      messages: state.messages.map(m => m.id === messageId ? { ...m, content: text, citations, interactionId } : m),
    }))
  }
  try {
    const response = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, query, messages: history, stream: true }),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.error || "Unable to load answer.")
    }
    await readChatStream(response, event => {
      if (event.type === "metadata") { citations = event.citations; interactionId = event.interactionId }
      if (event.type === "text") { text += event.text; update() }
    })
    update()
  } catch (error) {
    text = error instanceof Error ? `Error: ${error.message}` : "Unable to complete the answer."
    citations = []
    interactionId = undefined
    update()
  } finally {
    if (current()) { store.setIsLoading(false); store.setStatusMessage(null) }
  }
}

