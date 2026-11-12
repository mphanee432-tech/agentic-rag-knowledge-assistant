import { useChatStore } from "@/lib/store/chat-store"

export async function loadWorkspace(projectId: string, signal?: AbortSignal) {
  const current = () => !signal?.aborted && useChatStore.getState().activeProjectId === projectId
  if (!current()) return
  const { setDocuments, setSuggestedQueries, setIsDocumentsLoading } = useChatStore.getState()
  setIsDocumentsLoading(true)
  try {
    const [docRes, projRes] = await Promise.all([
      fetch(`/api/documents?projectId=${projectId}`, { signal }),
      fetch(`/api/projects?id=${projectId}`, { signal }),
    ])
    const [docData, projData] = await Promise.all([
      docRes.ok ? docRes.json() : null,
      projRes.ok ? projRes.json() : null,
    ])
    // Navigation can happen while response bodies are being read.
    if (!current()) return
    if (docData?.documents) setDocuments(docData.documents)
    if (Array.isArray(projData?.project?.suggested_queries)) {
      setSuggestedQueries(projData.project.suggested_queries)
    }
  } catch (error) {
    if (current()) console.error("Failed to fetch workspace data:", error)
  } finally {
    if (current()) setIsDocumentsLoading(false)
  }
}

export function watchWorkspace(projectId: string) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const refresh = async () => {
    await loadWorkspace(projectId, controller.signal)
    const state = useChatStore.getState()
    if (!controller.signal.aborted && state.activeProjectId === projectId &&
        state.documents.some(doc => ["pending_upload", "uploaded", "processing"].includes(doc.status))) {
      timer = setTimeout(() => { void refresh() }, 2000)
    }
  }
  void refresh()
  return () => {
    controller.abort()
    clearTimeout(timer)
  }
}
