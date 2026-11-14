"use client"

import * as React from "react"
import { sendChat } from "@/lib/send-chat"
import { useRef, useEffect } from "react"
import { ENTERPRISE_NO_EVIDENCE } from "@/lib/chat-contract"
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
import { DocumentUploader } from "@/components/upload/document-uploader"
import { EnterprisePolicyDialog } from "@/components/upload/enterprise-policy-dialog"
import { useChatStore } from "@/lib/store/chat-store"

interface ChatContainerProps {
  projectId?: string
  projectName?: string | null
  organizationId?: string
  canUploadPolicy?: boolean
}

export function ChatContainer({
  projectId,
  projectName,
  organizationId,
  canUploadPolicy,
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
  const [isUploadPolicyOpen, setIsUploadPolicyOpen] = React.useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Scroll to bottom on new messages or streaming chunks
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, statusMessage])

  const handleSendMessage = (query: string) => sendChat(query, projectId, organizationId)
  const latestMessage = messages.at(-1)
  const fallbackQuestions = enterprise && !isLoading && latestMessage?.role === "assistant"
    && latestMessage.content === ENTERPRISE_NO_EVIDENCE ? latestMessage.fallbackQuestions : undefined

  const activeDocCount = documents.filter((d) => d.status === "indexed").length

  return (
    <main className="flex-1 flex flex-col h-full bg-white dark:bg-zinc-950 overflow-hidden">
      {/* Top Navigation Bar */}
      <header className="px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between bg-white/80 dark:bg-zinc-950/80 backdrop-blur-sm z-10 shrink-0">
        <div className="flex items-center gap-3">
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
              onClick={clearChat}
              disabled={isLoading}
              className="text-xs h-7 gap-1 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
            >
              <RotateCcw className="size-3" />
              <span>Clear Session</span>
            </Button>
          )}
          {enterprise && <SignOut />}
          <ThemeToggle />
        </div>
      </header>

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
              disabled={!projectId && !organizationId}
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
