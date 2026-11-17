import { create } from "zustand"

export interface Citation {
  id: string
  index?: number
  content: string
  metadata?: {
    is_tabular?: boolean
    parent_headers?: string[]
    dom_path?: string
    page?: number
    line?: number
    char_count?: number
    filename?: string
    [key: string]: unknown
  }
}

export interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  citations?: Citation[]
  fallbackQuestions?: string[]
  interactionId?: string
}

export interface DocumentItem {
  id: string
  project_id: string
  storage_path: string
  status: "pending_upload" | "uploaded" | "processing" | "indexed" | "failed"
  last_ingestion_error?: string | null
  created_at: string
  metadata?: Record<string, unknown>
}

interface ChatStore {
  accountId: string | null
  setAccount: (accountId: string | null) => void
  messages: ChatMessage[]
  messagesByScope: Record<string, ChatMessage[]>
  activeProjectId: string | null
  isLoading: boolean
  statusMessage: string | null
  documents: DocumentItem[]
  suggestedQueries: string[]
  isDocumentsLoading: boolean

  // Core Actions
  setActiveProject: (projectId: string) => void
  setStatusMessage: (status: string | null) => void
  addMessage: (message: ChatMessage) => void
  clearChat: () => void

  // UI state actions
  setIsLoading: (isLoading: boolean) => void
  updateLastMessage: (content: string, citations?: Citation[], interactionId?: string) => void
  setDocuments: (documents: DocumentItem[]) => void
  setSuggestedQueries: (queries: string[]) => void
  setIsDocumentsLoading: (loading: boolean) => void
}

export const useChatStore = create<ChatStore>((set) => ({
  accountId: null,
  setAccount: (accountId) => set(state => state.accountId === accountId ? state : {
    accountId, activeProjectId: null, messages: [], messagesByScope: {}, documents: [], suggestedQueries: [],
    isLoading: false, statusMessage: null, isDocumentsLoading: true,
  }),
  messages: [],
  messagesByScope: {},
  activeProjectId: null,
  isLoading: false,
  statusMessage: null,
  documents: [],
  suggestedQueries: [],
  isDocumentsLoading: true,

  setActiveProject: (projectId: string) =>
    set((state) => {
      const canPreserveScope = Boolean(
        state.accountId && state.activeProjectId && state.activeProjectId !== projectId,
      )
      const nextMessagesByScope =
        canPreserveScope && state.activeProjectId
          ? { ...state.messagesByScope, [state.activeProjectId]: state.messages }
          : state.messagesByScope
      return {
        activeProjectId: projectId,
        isLoading: false,
        messages: canPreserveScope ? nextMessagesByScope[projectId] ?? [] : [],
        messagesByScope: nextMessagesByScope,
        statusMessage: null,
        documents: [],
        suggestedQueries: [],
        isDocumentsLoading: true,
      }
    }),

  setStatusMessage: (status: string | null) =>
    set({ statusMessage: status }),

  addMessage: (message: ChatMessage) =>
    set((state) => {
      const updated = [...state.messages, message]
      // Strictly enforce bounded 5-turn sliding window (maximum 10 messages: 5 user turns + 5 assistant turns)
      const bounded = updated.length > 10 ? updated.slice(updated.length - 10) : updated
      const nextMessagesByScope =
        state.accountId && state.activeProjectId
          ? { ...state.messagesByScope, [state.activeProjectId]: bounded }
          : state.messagesByScope
      return { messages: bounded, messagesByScope: nextMessagesByScope }
    }),

  clearChat: () =>
    set((state) => {
      const nextMessagesByScope = { ...state.messagesByScope }
      if (state.activeProjectId) {
        delete nextMessagesByScope[state.activeProjectId]
      }
      return {
        messages: [],
        messagesByScope: nextMessagesByScope,
        statusMessage: null,
        isLoading: false,
      }
    }),

  setIsLoading: (isLoading: boolean) =>
    set({ isLoading }),

  updateLastMessage: (content: string, citations?: Citation[], interactionId?: string) =>
    set((state) => {
      if (state.messages.length === 0) return state
      const lastIndex = state.messages.length - 1
      const last = state.messages[lastIndex]
      const updated = [...state.messages]
      updated[lastIndex] = {
        ...last,
        content,
        citations: citations !== undefined ? citations : last.citations,
        interactionId: interactionId !== undefined ? interactionId : last.interactionId,
      }
      const nextMessagesByScope =
        state.accountId && state.activeProjectId
          ? { ...state.messagesByScope, [state.activeProjectId]: updated }
          : state.messagesByScope
      return { messages: updated, messagesByScope: nextMessagesByScope }
    }),

  setDocuments: (documents: DocumentItem[]) =>
    set({ documents, isDocumentsLoading: false }),

  setSuggestedQueries: (suggestedQueries: string[]) =>
    set({ suggestedQueries }),

  setIsDocumentsLoading: (isDocumentsLoading: boolean) =>
    set({ isDocumentsLoading }),
}))
