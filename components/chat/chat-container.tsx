"use client"

import * as React from "react"
import { sendChat } from "@/lib/send-chat"
import { useRef, useEffect } from "react"
import { ENTERPRISE_NO_EVIDENCE } from "@/lib/chat-contract"
import {
  draftJiraTicket,
  extractJiraStatusIssueKey,
} from "@/lib/jira-ticket"
import { JiraTicketDraftForm, useJiraTicketDraft } from "@/components/jira/jira-ticket-draft"
import {
  RotateCcw,
  Lock,
  Building2,
  ArrowRight,
  ShieldCheck,
  FileUp,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ChatMessages } from "@/components/chat/chat-messages"
import { ChatInput } from "@/components/chat/chat-input"
import { ThemeToggle } from "@/components/theme-toggle"
import { SignOut } from "@/components/sign-out"
import { AccountSummary } from "@/components/account-summary"
import { WorkspaceTabs } from "@/components/workspace-tabs"
import type { AccountSummaryInfo } from "@/lib/account-summary"
import { DocumentUploader } from "@/components/upload/document-uploader"
import { EnterprisePolicyDialog } from "@/components/upload/enterprise-policy-dialog"
import { useChatStore } from "@/lib/store/chat-store"

interface ChatContainerProps {
  projectId?: string
  projectName?: string | null
  organizationId?: string
  canUploadPolicy?: boolean
  accountSummary?: AccountSummaryInfo
  enrolled?: boolean
}

export function ChatContainer({
  projectId,
  projectName,
  organizationId,
  canUploadPolicy,
  accountSummary,
  enrolled,
}: ChatContainerProps) {
  const {
    messages,
    isLoading,
    statusMessage,
    documents,
    suggestedQueries,
    clearChat,
  } = useChatStore()

  const enterprise = Boolean(organizationId)
  const canDraftJira = Boolean(accountSummary?.jiraAccessAvailable)
  const [isUploadPolicyOpen, setIsUploadPolicyOpen] = React.useState(false)
  const draftContextRef = useRef<{ accountId: string | null; activeProjectId: string | null }>({
    accountId: null,
    activeProjectId: null,
  })
  const {
    jiraDraft,
    setJiraDraft,
    jiraOptions,
    isLoadingJiraOptions,
    jiraOptionsError,
    jiraError,
    isCreatingTicket,
    loadJiraOptions,
    openJiraDraft,
    closeJiraDraft,
    confirmJiraTicket,
  } = useJiraTicketDraft({
    organizationId,
    onTicketCreated: (ticketKey) => {
      const store = useChatStore.getState()
      if (
        store.accountId === draftContextRef.current.accountId &&
        store.activeProjectId === draftContextRef.current.activeProjectId
      ) {
        store.addMessage({ id: crypto.randomUUID(), role: "assistant", content: `Created Jira ticket **${ticketKey}**.` })
      }
    },
  })

  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Scroll to bottom on new messages or streaming chunks
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, statusMessage])

  const lookupJiraStatus = async (query: string, issueKey: string) => {
    if (!organizationId) return
    const store = useChatStore.getState()
    const { accountId, activeProjectId } = store
    store.addMessage({ id: crypto.randomUUID(), role: "user", content: query })
    store.setIsLoading(true)
    store.setStatusMessage(`Checking Jira status for ${issueKey}…`)

    const appendAssistantMessage = (content: string) => {
      const current = useChatStore.getState()
      if (current.accountId === accountId && current.activeProjectId === activeProjectId) {
        current.addMessage({ id: crypto.randomUUID(), role: "assistant", content })
      }
    }

    try {
      const response = await fetch("/api/jira/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, issueKey }),
      })
      const result = await response.json().catch(() => null)
      if (
        !response.ok ||
        typeof result?.ticketKey !== "string" ||
        typeof result?.status !== "string" ||
        typeof result?.summary !== "string"
      ) {
        appendAssistantMessage(
          typeof result?.error === "string"
            ? result.error
            : `Unable to retrieve Jira status for ${issueKey}.`,
        )
        return
      }

      appendAssistantMessage(
        `**${result.ticketKey} — ${result.status}**\n\nSummary: ${result.summary}`,
      )
    } catch {
      appendAssistantMessage(`Unable to retrieve Jira status for ${issueKey}.`)
    } finally {
      const current = useChatStore.getState()
      current.setIsLoading(false)
      current.setStatusMessage(null)
    }
  }

  const handleSendMessage = async (query: string) => {
    if (jiraDraft) return
    const statusIssueKey = organizationId ? extractJiraStatusIssueKey(query) : null
    if (statusIssueKey) {
      return lookupJiraStatus(query, statusIssueKey)
    }
    const draft = canDraftJira ? draftJiraTicket(query) : null
    if (!draft) return sendChat(query, projectId, organizationId)

    const store = useChatStore.getState()
    draftContextRef.current = { accountId: store.accountId, activeProjectId: store.activeProjectId }
    store.addMessage({ id: crypto.randomUUID(), role: "user", content: query })
    openJiraDraft(draft)
  }
  const latestMessage = messages.at(-1)
  const fallbackQuestions = enterprise && !isLoading && latestMessage?.role === "assistant"
    && latestMessage.content === ENTERPRISE_NO_EVIDENCE ? latestMessage.fallbackQuestions : undefined

  const activeDocCount = documents.filter((d) => d.status === "indexed").length

  return (
    <main className="flex-1 flex flex-col h-full bg-white dark:bg-zinc-950 overflow-hidden">
      {/* Top Navigation Bar */}
      <header className="px-4 sm:px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-3 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-sm z-10 shrink-0">
        <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 tracking-tight">
              {enterprise ? "Employee Knowledge Copilot" : projectName || "Untitled Project"}
            </h1>
            {enterprise && (
              <Badge variant="outline" className="text-[10px] font-medium border-primary/30 text-primary bg-primary/5 gap-1">
                <Building2 className="size-2.5" /> Enterprise
              </Badge>
            )}
          </div>
          <WorkspaceTabs activeTab={enterprise ? "enterprise" : "personal"} />
        </div>

        <div className="flex items-center gap-2">
          {enterprise && canUploadPolicy && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => setIsUploadPolicyOpen(true)}
              className="text-xs h-7 gap-1.5 border-primary/40 text-primary hover:bg-primary/5 cursor-pointer font-medium"
            >
              <FileUp className="size-3 text-primary" />
              <span>Upload Policy</span>
            </Button>
          )}
          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                closeJiraDraft()
                clearChat()
              }}
              disabled={isLoading || isCreatingTicket}
              className="text-xs h-7 gap-1 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
            >
              <RotateCcw className="size-3" />
              <span>Clear Session</span>
            </Button>
          )}
          <SignOut workspace={enterprise ? "enterprise" : "personal"} />
          <ThemeToggle />
        </div>
      </header>
      {accountSummary && <AccountSummary account={accountSummary} />}
      {enrolled && enterprise && accountSummary?.accessStatus === "Active" && (
        <div
          role="status"
          className="px-6 py-2 border-b border-emerald-500/30 bg-emerald-500/10 text-xs font-medium text-emerald-800 dark:text-emerald-300"
        >
          Enterprise Employee membership activated for {accountSummary.organizationName || "DeccanBridge Software"}
          {accountSummary.departmentName ? ` (${accountSummary.departmentName})` : ""}.
        </div>
      )}

      {/* 0 Documents State (Hard Lock) */}
      {!enterprise && activeDocCount === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center p-6 md:p-12 overflow-y-auto">
          <div className="w-full max-w-xl mx-auto flex flex-col items-center text-center">
            <div className="size-16 rounded-3xl bg-amber-500/10 border border-amber-500/20 text-amber-500 flex items-center justify-center mb-4 shadow-xs">
              <Lock className="size-8" />
            </div>

            <Badge
              variant="outline"
              className="px-3 py-1 text-xs font-medium gap-1.5 border-amber-500/30 text-amber-600 dark:text-amber-400 bg-amber-500/10 mb-3"
            >
              <Lock className="size-3 text-amber-500" />
              <span>Workspace Locked • No Indexed Documents</span>
            </Badge>

            <h2 className="text-xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100 mb-2">
              Upload a document and wait for indexing to finish to unlock chat.
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-md mx-auto mb-6 leading-relaxed">
              Upload at least one engineering document, API contract, or error log to provide grounded answers with citations.
            </p>

            {/* Prominent Large Drag-and-Drop Zone */}
            <DocumentUploader
              projectId={projectId || ""}
              largeDropzone={true}
              customInstruction="Upload a document and wait for indexing to finish to unlock chat."
              className="w-full"
            />
          </div>
        </div>
      ) : (
        <>
          {/* Messages Thread Container */}
          <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 flex flex-col gap-2">
            {messages.length === 0 ? (
              enterprise ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-6 my-auto max-w-lg mx-auto">
                  <div className="size-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary mb-4 shadow-2xs">
                    <Building2 className="size-7" />
                  </div>
                  <Badge variant="outline" className="px-2.5 py-0.5 text-xs font-medium border-primary/30 text-primary bg-primary/5 mb-3 gap-1">
                    <ShieldCheck className="size-3 text-emerald-500" />
                    <span>Employee Knowledge Copilot</span>
                  </Badge>
                  <h2 className="text-xl font-bold tracking-tight text-foreground mb-1.5">
                    Organization Knowledge Base
                  </h2>
                  <p className="text-xs text-muted-foreground max-w-md mx-auto mb-6 leading-relaxed">
                    Ask questions across authorized department documentation, engineering guidelines, and release runbooks. All answers include verifiable citations.
                  </p>
                </div>
              ) : (
                <div className="flex-1" />
              )
            ) : (
              <>
                <ChatMessages messages={messages} isLoading={isLoading} />
                {fallbackQuestions?.length ? (
                  <div className="max-w-3xl w-full mx-auto flex flex-col items-start gap-2">
                    <p className="text-sm text-muted-foreground">Here are some things I can help you with:</p>
                    {fallbackQuestions.map(question => (
                      <Button
                        key={question}
                        type="button"
                        variant="outline"
                        className="h-auto max-w-full whitespace-normal text-left justify-start"
                        onClick={() => handleSendMessage(question)}
                      >
                        {question}
                        <ArrowRight className="size-3 shrink-0" aria-hidden="true" />
                      </Button>
                    ))}
                  </div>
                ) : null}
                {jiraDraft && (
                  <JiraTicketDraftForm
                    jiraDraft={jiraDraft}
                    setJiraDraft={setJiraDraft}
                    jiraOptions={jiraOptions}
                    isLoadingJiraOptions={isLoadingJiraOptions}
                    jiraOptionsError={jiraOptionsError}
                    jiraError={jiraError}
                    isCreatingTicket={isCreatingTicket}
                    onLoadOptions={(targetProjectId) => void loadJiraOptions(targetProjectId)}
                    onConfirm={() => void confirmJiraTicket()}
                    onCancel={closeJiraDraft}
                  />
                )}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {/* Bottom Input Area */}
          <footer className="p-4 md:px-8 max-w-3xl w-full mx-auto border-t border-zinc-100 dark:border-zinc-800/60 bg-white dark:bg-zinc-950 shrink-0">
            <ChatInput
              onSendMessage={handleSendMessage}
              isLoading={isLoading}
              statusMessage={statusMessage}
              disabled={Boolean(jiraDraft) || (!projectId && !organizationId)}
              suggestedQueries={suggestedQueries}
              showSuggestions={messages.length === 0}
            />
          </footer>
        </>
      )}

      {organizationId && canUploadPolicy && (
        <EnterprisePolicyDialog
          organizationId={organizationId}
          isOpen={isUploadPolicyOpen}
          onOpenChange={setIsUploadPolicyOpen}
        />
      )}
    </main>
  )
}
