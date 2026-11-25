"use client"

import * as React from "react"
import { useState } from "react"
import Markdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { Bot, User, Check, Copy, AlertCircle, FileText } from "lucide-react"
import { CitationBadge } from "@/components/chat/citation-badge"
import { splitCitations } from "@/lib/citations"
import { MessageActions } from "@/components/chat/message-actions"
import type { AgentActivity, ChatMessage, Citation } from "@/lib/store/chat-store"

interface MessageItemProps {
  message: ChatMessage
  isStreaming?: boolean
}

const REFUSAL_PREFIX = "I couldn't find evidence in this project's documents"

export function MessageItem({ message, isStreaming = false }: MessageItemProps) {
  const isUser = message.role === "user"
  const displayContent = !isUser && !isStreaming && !message.content.trim()
    ? "Error: The answer could not be completed. Please retry."
    : message.content
  const isError = !isUser && /^Error:/i.test(displayContent.trim())
  const isRefusal = !isError && displayContent.includes(REFUSAL_PREFIX)
  const citations = message.citations || []
  const activity = !isUser ? message.agentActivity : undefined
  const isLiveActivity = Boolean(activity && (isStreaming || activity.status === "in_progress"))
  const isFailedActivity = Boolean(activity && !isLiveActivity && (isError || activity.status === "failed"))

  return (
    <div
      className={`flex w-full gap-3 py-4 ${
        isUser ? "justify-end" : "justify-start"
      }`}
    >
      {!isUser && (
        <div className="size-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0 mt-0.5 text-primary">
          <Bot className="size-4" />
        </div>
      )}

      <div
        className={`flex min-w-0 flex-col max-w-[85%] md:max-w-[75%] gap-2 ${
          isUser
            ? "items-end"
            : "items-start"
        }`}
      >
        {activity && isLiveActivity && (
          <LiveAgentActivityPanel activity={activity} />
        )}

        <div
          className={`rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-xs ${
            isUser
              ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-950 rounded-br-xs"
              : isError
              ? "bg-red-500/10 border border-red-500/25 text-red-700 dark:text-red-300 rounded-bl-xs w-full"
              : isRefusal
              ? "bg-amber-500/10 border border-amber-500/20 text-zinc-800 dark:text-zinc-200 rounded-bl-xs w-full"
              : "bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 rounded-bl-xs w-full"
          }`}
        >
          {isError && (
            <div className="flex items-center gap-2 mb-1.5 font-medium text-xs text-red-600 dark:text-red-400">
              <AlertCircle className="size-4 shrink-0" />
              <span>Response Error</span>
            </div>
          )}
          {isRefusal && (
            <div className="flex items-center gap-2 mb-2 font-medium text-xs text-amber-600 dark:text-amber-400">
              <AlertCircle className="size-4" />
              <span>Grounded Retrieval Refusal</span>
            </div>
          )}

          {/* Render formatted message content */}
          <div className="prose prose-sm dark:prose-invert max-w-none break-words">
            {isStreaming && !displayContent.trim() ? (
              <p className="my-0 text-xs text-zinc-400">Waiting for response…</p>
            ) : (
              <FormattedContent
                content={displayContent}
                citations={citations}
              />
            )}
          </div>

          {/* Citation Tray if citations exist */}
          {!isUser && citations.length > 0 && (
            <div className="mt-3 pt-2.5 border-t border-zinc-100 dark:border-zinc-800/80 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-medium text-zinc-400 flex items-center gap-1">
                <FileText className="size-3" />
                Sources:
              </span>
              {citations.map((c, i) => (
                <CitationBadge key={c.id || i} citation={c} index={i} />
              ))}
            </div>
          )}

          {/* Assistant message actions directly below content */}
          {!isUser && !isStreaming && !isError && (
            <MessageActions
              interactionId={message.interactionId}
              content={displayContent}
            />
          )}
        </div>

        {activity && !isLiveActivity && (
          <AgentActivityPanel activity={activity} failed={isFailedActivity} />
        )}
      </div>

      {isUser && (
        <div className="size-8 rounded-lg bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center shrink-0 mt-0.5 text-zinc-700 dark:text-zinc-300">
          <User className="size-4" />
        </div>
      )}
    </div>
  )
}

function FormattedContent({
  content,
  citations,
}: {
  content: string
  citations: Citation[]
}) {
  const components = React.useMemo<Components>(() => ({
      span({ node, children }) {
        const indices = node?.properties.dataCitationIndices
        if (!Array.isArray(indices)) return <span>{children}</span>
        return <>{indices.map((value, position) => {
          const index = Number(value)
          const citation = citations.find(c => c.index === index && c.id.trim().length > 0)
          return citation ? <CitationBadge key={position} citation={citation} index={index - 1} /> : <span key={position}>[Unverified citation {index}]</span>
        })}</>
      },
      p: ({ children }) => <p className="my-2 whitespace-pre-wrap first:mt-0 last:mb-0">{children}</p>,
      h1: ({ children }) => <h2 className="mb-2 mt-4 text-lg font-semibold">{children}</h2>,
      h2: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold">{children}</h3>,
      h3: ({ children }) => <h4 className="mb-1 mt-3 font-semibold">{children}</h4>,
      ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
      ol: ({ children, start }) => <ol start={start} className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
      blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-zinc-300 pl-3 dark:border-zinc-600">{children}</blockquote>,
      a: ({ children, href }) => <a href={href} className="text-primary underline underline-offset-2">{children}</a>,
      img: ({ alt }) => <span>{alt || "[Image]"}</span>,
      code: ({ children, className }) => <code className={`rounded bg-zinc-100 px-1 font-mono text-[0.9em] dark:bg-zinc-800 ${className || ""}`}>{children}</code>,
      pre({ children }) {
        const code = React.Children.toArray(children)[0]
        if (!React.isValidElement<{ children?: React.ReactNode; className?: string }>(code) || typeof code.props.children !== "string") {
          return <pre>{children}</pre>
        }
        return <CodeBlock code={code.props.children.replace(/\n$/, "")} language={code.props.className?.replace(/^language-/, "")} />
      },
      table: ({ children }) => <div role="region" aria-label="Answer table" tabIndex={0} className="my-3 max-w-full overflow-x-auto rounded-lg border border-zinc-200 focus-visible:outline-2 focus-visible:outline-primary dark:border-zinc-700">
        <table className="w-full border-collapse text-left text-sm">{children}</table>
      </div>,
      thead: ({ children }) => <thead className="bg-zinc-100 dark:bg-zinc-800">{children}</thead>,
      th: ({ children, style }) => <th scope="col" style={style} className="border-b border-zinc-200 px-3 py-2 font-semibold dark:border-zinc-700">{children}</th>,
      td: ({ children, style }) => <td style={style} className="border-b border-zinc-200 px-3 py-2 align-top dark:border-zinc-700">{children}</td>,
    }), [citations])
  return (
    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeCitations]} skipHtml components={components}>{content}</Markdown>
  )
}

interface MarkdownNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: MarkdownNode[]
}

function rehypeCitations() {
  return function transform(node: MarkdownNode) {
    // Literal code and link labels must not gain nested interactive buttons.
    if (!node.children || ["pre", "code", "a"].includes(node.tagName || "")) return
    node.children = node.children.flatMap(child => {
      if (child.type === "text" && child.value) {
        return splitCitations(child.value).map(part => part.indices ? {
          type: "element", tagName: "span", properties: { dataCitationIndices: part.indices },
          children: [{ type: "text", value: part.text }],
        } : { ...child, value: part.text })
      }
      transform(child)
      return [child]
    })
  }
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="my-2.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-950 text-zinc-100 overflow-hidden text-xs">
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900 border-b border-zinc-800 font-mono text-[11px] text-zinc-400">
        <span>{language || "code"}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-zinc-100 cursor-pointer transition-colors"
        >
          {copied ? (
            <>
              <Check className="size-3 text-emerald-400" />
              <span className="text-emerald-400">Copied</span>
            </>
          ) : (
            <>
              <Copy className="size-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <div className="p-3 overflow-x-auto font-mono text-[12px] leading-relaxed select-text">
        <pre>{code}</pre>
      </div>
    </div>
  )
}

const TOOL_LABELS: Record<NonNullable<AgentActivity["tool"]>, string> = {
  rag_retrieval: "RAG retrieval (rag_retrieval)",
  jira_status: "Jira status (jira_status)",
  jira_status_clarification: "Jira clarification (jira_status_clarification)",
  jira_create_draft: "Jira draft (jira_create_draft)",
  jira_create_denied: "Jira access denied (jira_create_denied)",
  deterministic_reply: "Deterministic reply (deterministic_reply)",
}

const EVIDENCE_DECISION_LABELS: Record<NonNullable<AgentActivity["retrievalSteps"][number]["decision"]>, string> = {
  answer: "answer",
  retry_retrieval: "retry",
  clarify: "clarify",
  abstain: "abstain",
}

const OUTCOME_LABELS: Record<NonNullable<AgentActivity["finalOutcome"]>, string> = {
  answer: "Answer",
  retry_retrieval: "Retry retrieval",
  clarify: "Clarify",
  abstain: "Abstain",
  tool_executed: "Tool executed",
  confirmation_required: "Confirmation required",
}

function AgentActivityRows({
  activity,
  live,
  failed,
}: {
  activity: AgentActivity
  live: boolean
  failed: boolean
}) {
  const attempt1 = activity.retrievalSteps.find((step) => step.attempt === 1)
  const attempt2 = activity.retrievalSteps.find((step) => step.attempt === 2)
  const decisionLabelPrefix = activity.decisionMode === "llm" ? "LLM evidence decision" : "Evidence decision"

  return (
    <dl className={`mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-[11px] ${
      failed
        ? "border-red-500/25 bg-red-500/5 text-red-700 dark:text-red-300"
        : "border-zinc-200/80 bg-zinc-50/70 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-300"
    }`}>
      {failed && (
        <>
          <dt className="font-medium text-red-600 dark:text-red-400">Status</dt>
          <dd>Interrupted / failed before completion</dd>
        </>
      )}

      {live && !activity.tool && (
        <>
          <dt className="font-medium text-zinc-500 dark:text-zinc-400">Status</dt>
          <dd>Selecting tool (in progress)</dd>
        </>
      )}

      {activity.decisionMode && (
        <>
          <dt className="font-medium text-zinc-500 dark:text-zinc-400">Decision mode</dt>
          <dd>{activity.decisionMode === "llm" ? "LLM" : "Deterministic shortcut"}</dd>
        </>
      )}

      {activity.tool && (
        <>
          <dt className="font-medium text-zinc-500 dark:text-zinc-400">Selected tool</dt>
          <dd className="font-mono text-[11px]">{TOOL_LABELS[activity.tool]}</dd>
        </>
      )}

      {attempt1 ? (
        <>
          <dt className="font-medium text-zinc-500 dark:text-zinc-400">Retrieval attempt 1</dt>
          <dd>
            {attempt1.authorized_chunks} authorized {attempt1.authorized_chunks === 1 ? "chunk" : "chunks"}
          </dd>

          {attempt1.decision ? (
            <>
              <dt className="font-medium text-zinc-500 dark:text-zinc-400">{decisionLabelPrefix}</dt>
              <dd>{EVIDENCE_DECISION_LABELS[attempt1.decision]}</dd>
            </>
          ) : live && activity.inProgressPhase === "evidence_evaluation_1" ? (
            <>
              <dt className="font-medium text-zinc-500 dark:text-zinc-400">{decisionLabelPrefix}</dt>
              <dd>In progress</dd>
            </>
          ) : null}
        </>
      ) : live && activity.inProgressPhase === "retrieval_attempt_1" ? (
        <>
          <dt className="font-medium text-zinc-500 dark:text-zinc-400">Retrieval attempt 1</dt>
          <dd>In progress</dd>
        </>
      ) : null}

      {attempt2 ? (
        <>
          <dt className="font-medium text-zinc-500 dark:text-zinc-400">Retrieval attempt 2</dt>
          <dd>
            {attempt2.authorized_chunks} authorized {attempt2.authorized_chunks === 1 ? "chunk" : "chunks"}
            {typeof attempt2.merged_authorized_chunks === "number"
              ? ` (${attempt2.merged_authorized_chunks} merged)`
              : ""}
          </dd>

          {attempt2.decision ? (
            <>
              <dt className="font-medium text-zinc-500 dark:text-zinc-400">{decisionLabelPrefix} (attempt 2)</dt>
              <dd>{EVIDENCE_DECISION_LABELS[attempt2.decision]}</dd>
            </>
          ) : live && activity.inProgressPhase === "evidence_evaluation_2" ? (
            <>
              <dt className="font-medium text-zinc-500 dark:text-zinc-400">{decisionLabelPrefix} (attempt 2)</dt>
              <dd>In progress</dd>
            </>
          ) : null}
        </>
      ) : live && activity.inProgressPhase === "retrieval_attempt_2" ? (
        <>
          <dt className="font-medium text-zinc-500 dark:text-zinc-400">Retrieval attempt 2</dt>
          <dd>In progress</dd>
        </>
      ) : null}

      {!failed && activity.finalOutcome && (
        <>
          <dt className="font-medium text-zinc-500 dark:text-zinc-400">Final outcome</dt>
          <dd>
            {OUTCOME_LABELS[activity.finalOutcome]}
            {live && activity.inProgressPhase === "answering" ? " (streaming response)" : ""}
          </dd>
        </>
      )}

      {typeof activity.steps === "number" && typeof activity.maxSteps === "number" && (
        <>
          <dt className="font-medium text-zinc-500 dark:text-zinc-400">Total agent steps</dt>
          <dd>
            {activity.steps} / {activity.maxSteps}
          </dd>
        </>
      )}
    </dl>
  )
}

function LiveAgentActivityPanel({ activity }: { activity: AgentActivity }) {
  return (
    <div role="status" aria-live="polite" className="w-full px-1">
      <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
        Agent Activity (In progress)
      </div>
      <AgentActivityRows activity={activity} live failed={false} />
    </div>
  )
}

function AgentActivityPanel({ activity, failed = false }: { activity: AgentActivity; failed?: boolean }) {
  return (
    <details className="w-full px-1">
      <summary className={`cursor-pointer select-none text-[11px] font-medium ${
        failed
          ? "text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
          : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
      }`}>
        {failed ? "Agent Activity (Interrupted / failed)" : "Agent Activity"}
      </summary>
      <AgentActivityRows activity={activity} live={false} failed={failed} />
    </details>
  )
}
