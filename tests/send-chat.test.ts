import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MessageItem } from "../components/chat/message-item"
import { AccountSummary } from "../components/account-summary"
import { WorkspaceTabs } from "../components/workspace-tabs"
import { encodeEvent, ENTERPRISE_NO_EVIDENCE, type ChatEvent } from "../lib/chat-contract"
import { parseChatInput } from "../lib/chat-input"
import { sendChat } from "../lib/send-chat"
import { useChatStore, type ChatMessage } from "../lib/store/chat-store"

const projectId = "11111111-1111-4111-8111-111111111111"
const sourceContext = "retrieved-context-sentinel"
const telemetry = "<!-- rag-telemetry: {\"internal\":true} -->"
const citations = [{ id: "chunk-a", index: 1, content: "private-citation-excerpt", metadata: { filename: "source.txt" } }]

test("logout and account switch discard history and late responses on the same project", async t => {
  const initial = useChatStore.getState()
  t.after(() => useChatStore.setState(initial, true))
  const store = useChatStore.getState()
  store.setAccount("first-user")
  store.setActiveProject(projectId)
  store.addMessage({ id: "old", role: "assistant", content: "Private history", citations })
  store.setAccount("first-user")
  assert.equal(useChatStore.getState().messages.length, 1)

  let finish!: (response: Response) => void
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { finish = resolve }))
  const pending = sendChat("Old account question", projectId)
  store.setAccount(null)
  assert.deepEqual(useChatStore.getState().messages, [])
  store.setAccount("second-user")
  store.setActiveProject(projectId)
  finish(response([{ type: "metadata", citations }, { type: "text", text: "Late private answer" }, { type: "finish", metrics: {} }]))
  await pending
  assert.deepEqual(useChatStore.getState().messages, [])
  assert.equal(useChatStore.getState().accountId, "second-user")
})

function response(events: ChatEvent[]) {
  const bytes = Buffer.concat(events.map(event => Buffer.from(encodeEvent(event))))
  return new Response(new ReadableStream({ start(controller) {
    // Split JSON frames and UTF-8 characters across reads, as real network delivery can do.
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
    controller.close()
  }}), { headers: { "Content-Type": "text/event-stream" } })
}

test("enterprise chat sends an organization request without previous evidence or a project", async t => {
  const initial = useChatStore.getState()
  t.after(() => useChatStore.setState(initial, true))
  const organizationId = "22222222-2222-4222-8222-222222222222"
  initial.setActiveProject(`organization:${organizationId}`)
  initial.addMessage({ id: "old", role: "assistant", content: "Previously authorized answer", citations })
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { organizationId, query: "Question", messages: [], stream: true })
    return response([{ type: "metadata", citations }, { type: "text", text: "Answer [Chunk 1]." }, { type: "finish", metrics: {} }])
  })
  await sendChat("Question", undefined, organizationId)
  assert.equal(useChatStore.getState().messages.at(-1)?.content, "Answer [Chunk 1].")
})

test("enterprise refusal suggestions stay separate from text and are discarded on account switch", async t => {
  const store = useChatStore.getState()
  t.after(() => useChatStore.setState(store, true))
  const organizationId = "22222222-2222-4222-8222-222222222222"
  const scope = `organization:${organizationId}`
  const fallbackQuestions = ["How should I hand off a design?", "How do I request leave?", "How do I request equipment?"]
  const refusal = () => response([
    { type: "text", text: ENTERPRISE_NO_EVIDENCE },
    { type: "finish", metrics: {}, fallbackQuestions },
  ])
  store.setAccount("designer")
  store.setActiveProject(scope)
  let release!: (value: Response) => void
  const requested: string[] = []
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { query, messages } = JSON.parse(String(init?.body))
    assert.deepEqual(messages, [])
    requested.push(query)
    return requested.length === 1 ? refusal() : new Promise<Response>(resolve => { release = resolve })
  })
  await sendChat("Unsupported question", undefined, organizationId)
  const message = useChatStore.getState().messages.at(-1)
  assert.equal(message?.content, ENTERPRISE_NO_EVIDENCE)
  assert.deepEqual(message?.fallbackQuestions, fallbackQuestions)
  const pending = sendChat(fallbackQuestions[0], undefined, organizationId)
  assert.equal(requested.at(-1), fallbackQuestions[0])
  store.setAccount("engineer")
  store.setActiveProject(scope)
  release(refusal())
  await pending
  assert.deepEqual(useChatStore.getState().messages, [])
})

test("shared chat consumer keeps metadata outside answer text and subsequent history", async t => {
  const initial = useChatStore.getState()
  t.after(() => useChatStore.setState(initial, true))

  await t.test("finish telemetry cannot render or enter the next request", async st => {
    useChatStore.getState().setActiveProject(projectId)
    const updates: string[] = []
    const unsubscribe = useChatStore.subscribe(state => {
      updates.push(...state.messages.filter(message => message.role === "assistant").map(message => message.content))
    })
    st.after(unsubscribe)
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
    st.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return response([
        { type: "metadata", interactionId: "interaction-a", citations },
        { type: "text", text: "Answer café " },
        { type: "text", text: "[Chunk 1]." },
        { type: "finish", metrics: { internal_metric: 1234 }, context: `${sourceContext}\n${telemetry}` },
      ])
    })
    await sendChat("Question", projectId)
    const assistant = useChatStore.getState().messages.at(-1)!
    assert.equal(assistant.content, "Answer café [Chunk 1].")
    assert.deepEqual(assistant.citations, citations)
    assert.equal(assistant.interactionId, "interaction-a")
    assert.equal(useChatStore.getState().isLoading, false)
    const html = renderToStaticMarkup(createElement(MessageItem, { message: assistant }))
    assert.ok(html.includes("Answer café"))
    assert.ok(!html.includes(sourceContext) && !html.includes("rag-telemetry") && !html.includes("internal_metric"))
    assert.ok(updates.every(text => !text.includes(sourceContext) && !text.includes("rag-telemetry")))

    await sendChat("Follow-up", projectId)
    assert.deepEqual(requests[1].messages, [
      { role: "user", content: "Question" }, { role: "assistant", content: "Answer café [Chunk 1]." },
    ])
    assert.deepEqual(parseChatInput({ projectId, query: "Follow-up", messages: requests[1].messages }).boundedHistory, [
      ...requests[1].messages, { role: "user", content: "Follow-up" },
    ])
    const wireHistory = JSON.stringify(requests[1].messages)
    for (const privateField of [sourceContext, "rag-telemetry", "internal_metric", "private-citation-excerpt", "interaction-a", "citations"]) {
      assert.ok(!wireHistory.includes(privateField), privateField)
    }
  })

  await t.test("existing message metadata is excluded from outgoing history", async st => {
    useChatStore.getState().setActiveProject(projectId)
    const existing: ChatMessage = { id: "old-message", role: "assistant", content: "Previous answer [Chunk 1]", citations, interactionId: "old-interaction" }
    useChatStore.getState().addMessage(existing)
    st.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.deepEqual(JSON.parse(String(init?.body)).messages, [{ role: "assistant", content: existing.content }])
      return response([
        { type: "metadata", interactionId: "next", citations },
        { type: "text", text: "Next answer [Chunk 1]" },
        { type: "finish", metrics: {} },
      ])
    })
    await sendChat("Next question", projectId)
    assert.equal(useChatStore.getState().messages.at(-1)?.content, "Next answer [Chunk 1]")
  })

  await t.test("legacy raw streams fail closed instead of displaying a telemetry trailer", async st => {
    useChatStore.getState().setActiveProject(projectId)
    st.mock.method(globalThis, "fetch", async () => new Response(`Answer [Chunk 1]\n${telemetry}\n${sourceContext}`, {
      headers: { "Content-Type": "text/plain" },
    }))
    await sendChat("Question", projectId)
    const assistant = useChatStore.getState().messages.at(-1)!
    assert.match(assistant.content, /^Error: Unsupported chat response/)
    assert.ok(!assistant.content.includes(sourceContext) && !assistant.content.includes("rag-telemetry"))
    assert.deepEqual(assistant.citations, [])
  })

  await t.test("streaming failures and empty streams render a readable error instead of a blank message", async st => {
    useChatStore.getState().setActiveProject(projectId)
    st.mock.method(globalThis, "fetch", async () => response([
      { type: "metadata", citations },
      { type: "error", message: "The answer could not be completed. Please retry." },
    ]))
    await sendChat("Question", projectId)
    const assistant = useChatStore.getState().messages.at(-1)!
    assert.equal(assistant.content, "Error: The answer could not be completed. Please retry.")
    assert.deepEqual(assistant.citations, [])
    const html = renderToStaticMarkup(createElement(MessageItem, { message: assistant }))
    assert.ok(html.includes("Response Error"))
    assert.ok(html.includes("The answer could not be completed. Please retry."))

    const emptyFinished: ChatMessage = { id: "empty-assistant", role: "assistant", content: "" }
    const emptyHtml = renderToStaticMarkup(createElement(MessageItem, { message: emptyFinished, isStreaming: false }))
    assert.ok(emptyHtml.includes("Response Error"))
    assert.ok(emptyHtml.includes("The answer could not be completed. Please retry."))
  })
})

test("WP9.14: workspace tabs render Personal RAG and Enterprise RAG links and preserve independent chat histories per scope", t => {
  const initial = useChatStore.getState()
  t.after(() => useChatStore.setState(initial, true))

  const personalTabsHtml = renderToStaticMarkup(createElement(WorkspaceTabs, { activeTab: "personal" }))
  assert.ok(personalTabsHtml.includes("Personal RAG"))
  assert.ok(personalTabsHtml.includes("Your private documents"))
  assert.ok(personalTabsHtml.includes("Enterprise RAG"))
  assert.ok(personalTabsHtml.includes("Company knowledge"))
  assert.ok(personalTabsHtml.includes('href="/?tab=personal"'))
  assert.ok(personalTabsHtml.includes('href="/?tab=enterprise"'))
  assert.ok(personalTabsHtml.includes('grid-cols-2'))
  assert.ok(personalTabsHtml.includes('focus-visible:ring-2'))
  assert.match(personalTabsHtml, /<a[^>]*href="\/\?tab=personal"[^>]*>|<a[^>]*aria-current="page"[^>]*href="\/\?tab=personal"/)
  assert.match(personalTabsHtml, /<a[^>]*aria-current="page"[^>]*href="\/\?tab=personal"/)
  assert.doesNotMatch(personalTabsHtml, /<a[^>]*aria-current="page"[^>]*href="\/\?tab=enterprise"/)

  const enterpriseTabsHtml = renderToStaticMarkup(createElement(WorkspaceTabs, { activeTab: "enterprise" }))
  assert.match(enterpriseTabsHtml, /<a[^>]*aria-current="page"[^>]*href="\/\?tab=enterprise"/)
  assert.doesNotMatch(enterpriseTabsHtml, /<a[^>]*aria-current="page"[^>]*href="\/\?tab=personal"/)

  const store = useChatStore.getState()
  const enterpriseScope = "organization:c0000000-0000-4000-8000-000000000001"
  store.setAccount("user-1")
  store.setActiveProject(projectId)
  store.addMessage({ id: "p-1", role: "user", content: "Personal project question" })
  store.addMessage({ id: "p-2", role: "assistant", content: "Personal project answer [Chunk 1]" })

  // Switch to Enterprise RAG tab: starts with clean enterprise history, does not mix personal messages
  store.setActiveProject(enterpriseScope)
  assert.deepEqual(useChatStore.getState().messages, [])
  store.addMessage({ id: "e-1", role: "user", content: "Enterprise policy question" })
  store.addMessage({ id: "e-2", role: "assistant", content: "Enterprise policy answer [Chunk 1]" })

  // Switch back to Personal RAG project: restores personal conversation without enterprise messages
  store.setActiveProject(projectId)
  assert.deepEqual(
    useChatStore.getState().messages.map(m => m.content),
    ["Personal project question", "Personal project answer [Chunk 1]"],
  )

  // Switch back to Enterprise RAG tab: restores enterprise conversation
  store.setActiveProject(enterpriseScope)
  assert.deepEqual(
    useChatStore.getState().messages.map(m => m.content),
    ["Enterprise policy question", "Enterprise policy answer [Chunk 1]"],
  )

  // Account switch clears all scoped histories
  store.setAccount("user-2")
  store.setActiveProject(projectId)
  assert.deepEqual(useChatStore.getState().messages, [])
  store.setActiveProject(enterpriseScope)
  assert.deepEqual(useChatStore.getState().messages, [])

  const accountHtml = renderToStaticMarkup(
    createElement(AccountSummary, {
      account: {
        email: "newengineering@example.com",
        organizationName: "DeccanBridge Software",
        departmentName: "Engineering",
        role: "Employee",
        accessStatus: "Active",
        jiraAccessAvailable: true,
      },
    }),
  )
  assert.ok(accountHtml.includes("newengineering@example.com"))
  assert.ok(accountHtml.includes("DeccanBridge Software"))
  assert.ok(accountHtml.includes("Engineering"))
  assert.ok(accountHtml.includes("Employee"))
  assert.ok(accountHtml.includes("Enterprise membership: Active"))
  assert.ok(accountHtml.includes("Jira Access: Enabled"))
})

test("WP9.15: Sign Up page displays Department dropdown and renamed Enable Jira Ticket Creation checkbox, while Sign In displays neither", async () => {
  const fs = await import("node:fs/promises")
  const loginSource = await fs.readFile(new URL("../app/login/page.tsx", import.meta.url), "utf8")
  const { DEMO_DEPARTMENTS } = await import("../lib/utils")

  assert.deepEqual(DEMO_DEPARTMENTS, [
    "Engineering",
    "HR",
    "Product Management",
    "Project Management",
    "UI/UX",
    "Operations",
    "Marketing",
    "Finance",
  ])

  // Sign In is default mode and demoJiraAccess is false (unchecked) by default
  assert.match(loginSource, /useState<"signin"\s*\|\s*"signup"\s*\|\s*"forgot">\("signin"\)/)
  assert.match(loginSource, /const \[demoJiraAccess, setDemoJiraAccess\] = useState\(false\)/)

  // Sign Up block renders both Department dropdown and renamed Jira checkbox simultaneously, gated by mode === "signup"
  const signupBlockMatch = loginSource.match(/\{mode === "signup" && \([\s\S]*?\n        \)\}/)
  assert.ok(signupBlockMatch, "Expected signup-only block in app/login/page.tsx")
  const signupBlock = signupBlockMatch[0]

  assert.match(signupBlock, /name="department"[\s\S]*?required/)
  assert.match(signupBlock, /DEMO_DEPARTMENTS\.map/)
  assert.match(signupBlock, /type="checkbox"[\s\S]*?name="demoJiraAccess"/)
  assert.ok(signupBlock.includes("Enable Jira Ticket Creation"))
  assert.ok(signupBlock.includes("Allow creation of Jira tickets through the confirmation workflow."))
  assert.ok(!signupBlock.includes(">Enterprise membership<"))
  assert.ok(!signupBlock.includes("Enable Jira ticket creation for the demo."))
})

test("WP9.25: shared ChatInput displays updated placeholder in both Personal RAG and Enterprise RAG without changing submission", async t => {
  const { ChatContainer } = await import("../components/chat/chat-container")
  const { ChatInput } = await import("../components/chat/chat-input")
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime")
  type AppRouterInstance = import("next/dist/shared/lib/app-router-context.shared-runtime").AppRouterInstance
  const fs = await import("node:fs/promises")

  const mockRouter = {
    back: () => {},
    forward: () => {},
    refresh: () => {},
    push: () => {},
    replace: () => {},
    prefetch: async () => {},
  } as unknown as AppRouterInstance
  const renderWithRouter = (node: ReturnType<typeof createElement>) =>
    renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: mockRouter }, node))

  const initial = useChatStore.getState()
  t.after(() => useChatStore.setState(initial, true))

  // Enterprise RAG ChatContainer renders the shared ChatInput placeholder
  const orgId = "c0000000-0000-4000-8000-000000000001"
  const enterpriseHtml = renderWithRouter(
    createElement(ChatContainer, {
      organizationId: orgId,
      canUploadPolicy: false,
    }),
  )
  assert.ok(enterpriseHtml.includes('placeholder="How can I help you today?"'))
  assert.ok(!enterpriseHtml.includes("Ask a technical question, or paste logs"))

  // Both Personal RAG and Enterprise RAG share the single <ChatInput /> in ChatContainer
  const [chatContainerSource, workspaceClientSource, chatInputSource] = await Promise.all([
    fs.readFile(new URL("../components/chat/chat-container.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../components/chat/project-workspace-client.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../components/chat/chat-input.tsx", import.meta.url), "utf8"),
  ])
  assert.equal((chatContainerSource.match(/<ChatInput\b/g) || []).length, 1)
  assert.match(workspaceClientSource, /<ChatContainer\b/)

  // Direct shared ChatInput render (Personal RAG & Enterprise RAG) & submission wiring remain intact
  const inputHtml = renderToStaticMarkup(
    createElement(ChatInput, {
      onSendMessage: async () => {},
      isLoading: false,
      statusMessage: null,
    }),
  )
  assert.ok(inputHtml.includes('placeholder="How can I help you today?"'))
  assert.ok(!inputHtml.includes("Ask a technical question, or paste logs"))
  assert.ok(inputHtml.includes("0 / 2500"))

  assert.match(chatInputSource, /if \(e\.key === "Enter" && !e\.shiftKey\)/)
  assert.match(chatInputSource, /await onSendMessage\(trimmed\)/)
})

test("Agent Activity captures real server telemetry, stays collapsed by default, and excludes private metadata from history", async t => {
  const initial = useChatStore.getState()
  t.after(() => useChatStore.setState(initial, true))
  const store = useChatStore.getState()
  store.setAccount("pm-demo-user")
  store.setActiveProject(projectId)

  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)))
    if (requests.length === 1) {
      return response([
        { type: "metadata", interactionId: "int-1", citations },
        { type: "text", text: "Recovered answer [Chunk 1]." },
        {
          type: "finish",
          metrics: {
            internal_metric: 999,
            agent: {
              tool: "rag_retrieval",
              decision_mode: "llm",
              steps: 6,
              max_steps: 6,
              retrieval_attempts: 2,
              max_retrieval_attempts: 2,
              reformulated: true,
              evidence_sufficient: true,
              evidence_reason: "HIDDEN_PROMPT_OR_PRIVATE_REASONING",
              next_action: "answer",
              final_outcome: "answer",
              retrieval_steps: [
                { attempt: 1, authorized_chunks: 1, decision: "retry_retrieval" },
                { attempt: 2, authorized_chunks: 2, merged_authorized_chunks: 3, decision: "answer" },
              ],
            },
          },
        },
      ])
    }
    return response([
      { type: "metadata", citations },
      { type: "text", text: "Single attempt answer [Chunk 1]." },
      {
        type: "finish",
        metrics: {
          agent: {
            tool: "rag_retrieval",
            decision_mode: "llm",
            steps: 4,
            max_steps: 6,
            retrieval_attempts: 1,
            max_retrieval_attempts: 2,
            reformulated: false,
            evidence_sufficient: true,
            next_action: "answer",
            final_outcome: "answer",
            retrieval_steps: [
              { attempt: 1, authorized_chunks: 2, decision: "answer" },
            ],
          },
        },
      },
    ])
  })

  await sendChat("First question?", projectId)
  const retryMessage = useChatStore.getState().messages.at(-1)!
  assert.equal(retryMessage.content, "Recovered answer [Chunk 1].")
  assert.deepEqual(retryMessage.agentActivity, {
    status: "completed",
    decisionMode: "llm",
    tool: "rag_retrieval",
    steps: 6,
    maxSteps: 6,
    retrievalAttempts: 2,
    maxRetrievalAttempts: 2,
    reformulated: true,
    finalOutcome: "answer",
    retrievalSteps: [
      { attempt: 1, authorized_chunks: 1, decision: "retry_retrieval" },
      { attempt: 2, authorized_chunks: 2, merged_authorized_chunks: 3, decision: "answer" },
    ],
  })

  const retryHtml = renderToStaticMarkup(createElement(MessageItem, { message: retryMessage }))
  assert.match(retryHtml, /<details\b[^>]*><summary\b[^>]*>Agent Activity<\/summary>/)
  assert.ok(!/<details\b[^>]*\bopen\b/.test(retryHtml), "Agent Activity must be collapsed by default")
  assert.ok(retryHtml.includes("Decision mode"))
  assert.ok(retryHtml.includes(">LLM<"))
  assert.ok(retryHtml.includes("RAG retrieval (rag_retrieval)"))
  assert.ok(retryHtml.includes("Retrieval attempt 1"))
  assert.ok(retryHtml.includes("1 authorized chunk"))
  assert.ok(retryHtml.includes("LLM evidence decision"))
  assert.ok(retryHtml.includes(">retry<"))
  assert.ok(retryHtml.includes("Retrieval attempt 2"))
  assert.ok(retryHtml.includes("2 authorized chunks (3 merged)"))
  assert.ok(retryHtml.includes("Total agent steps"))
  assert.ok(retryHtml.includes("6 / 6"))
  assert.ok(!retryHtml.includes("HIDDEN_PROMPT_OR_PRIVATE_REASONING"))
  assert.ok(!retryHtml.includes("internal_metric"))

  await sendChat("Follow-up question?", projectId)
  assert.deepEqual(requests[1].messages, [
    { role: "user", content: "First question?" },
    { role: "assistant", content: "Recovered answer [Chunk 1]." },
  ])
  const serializedHistory = JSON.stringify(requests[1].messages)
  assert.ok(!serializedHistory.includes("agentActivity"))
  assert.ok(!serializedHistory.includes("rag_retrieval"))

  const singleAttemptMessage = useChatStore.getState().messages.at(-1)!
  const singleHtml = renderToStaticMarkup(createElement(MessageItem, { message: singleAttemptMessage }))
  assert.ok(singleHtml.includes("Retrieval attempt 1"))
  assert.ok(singleHtml.includes("2 authorized chunks"))
  assert.ok(!singleHtml.includes("Retrieval attempt 2"), "Attempt 2 must not render when only 1 attempt occurred")
  assert.ok(singleHtml.includes("4 / 6"))

  const deterministicMessage: ChatMessage = {
    id: "det-1",
    role: "assistant",
    content: "Hello! How can I help you?",
    agentActivity: {
      decisionMode: "deterministic",
      tool: "deterministic_reply",
      steps: 2,
      maxSteps: 6,
      retrievalAttempts: 0,
      maxRetrievalAttempts: 2,
      reformulated: false,
      finalOutcome: "tool_executed",
      retrievalSteps: [],
    },
  }
  const deterministicHtml = renderToStaticMarkup(createElement(MessageItem, { message: deterministicMessage }))
  assert.ok(deterministicHtml.includes("Deterministic shortcut"))
  assert.ok(deterministicHtml.includes("Deterministic reply (deterministic_reply)"))
  assert.ok(deterministicHtml.includes("Tool executed"))
  assert.ok(deterministicHtml.includes("2 / 6"))
  assert.ok(!deterministicHtml.includes("Retrieval attempt 1"))
})

test("Live Agent Activity updates incrementally before finish/text and handles interrupted stream failure clearly", async t => {
  const initial = useChatStore.getState()
  t.after(() => useChatStore.setState(initial, true))
  const store = useChatStore.getState()
  store.setAccount("pm-live-demo")
  store.setActiveProject(projectId)

  let enqueue!: (event: ChatEvent) => void
  let closeStream!: () => void
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) {
      enqueue = (event) => controller.enqueue(Buffer.from(encodeEvent(event)))
      closeStream = () => controller.close()
    },
  }), { headers: { "Content-Type": "text/event-stream" } }))

  const snapshots: string[] = []
  const unsubscribe = useChatStore.subscribe((state) => {
    const assistant = state.messages.at(-1)
    if (assistant?.role === "assistant" && assistant.agentActivity) {
      snapshots.push(renderToStaticMarkup(createElement(MessageItem, { message: assistant, isStreaming: state.isLoading })))
    }
  })
  t.after(unsubscribe)

  const pending = sendChat("Live progress question?", projectId)
  await new Promise((resolve) => setImmediate(resolve))

  // Immediately upon submit, live Agent Activity is shown above the pending answer without fabricated steps.
  const initialLiveHtml = snapshots.at(-1) ?? ""
  assert.ok(initialLiveHtml.includes("Agent Activity (In progress)"))
  assert.ok(initialLiveHtml.includes("Selecting tool (in progress)"))
  assert.ok(initialLiveHtml.indexOf("Agent Activity (In progress)") < initialLiveHtml.indexOf("Waiting for response"))
  assert.ok(!initialLiveHtml.includes("Retrieval attempt 1"))

  enqueue({ type: "agent_step", step: { phase: "tool_selected", decisionMode: "llm", tool: "rag_retrieval" } })
  enqueue({ type: "agent_step", step: { phase: "retrieval_attempt_1_started" } })
  await new Promise((resolve) => setImmediate(resolve))
  const attempt1StartedHtml = snapshots.at(-1) ?? ""
  assert.ok(attempt1StartedHtml.includes("RAG retrieval (rag_retrieval)"))
  assert.ok(attempt1StartedHtml.includes("Retrieval attempt 1"))
  assert.ok(attempt1StartedHtml.includes("In progress"))
  assert.ok(!attempt1StartedHtml.includes("authorized chunk"))

  enqueue({ type: "agent_step", step: { phase: "retrieval_attempt_1_completed", authorizedChunks: 1 } })
  enqueue({ type: "agent_step", step: { phase: "evidence_decision_1", decisionMode: "llm", decision: "retry_retrieval" } })
  enqueue({ type: "agent_step", step: { phase: "retrieval_attempt_2_started" } })
  await new Promise((resolve) => setImmediate(resolve))
  const attempt2StartedHtml = snapshots.at(-1) ?? ""
  assert.ok(attempt2StartedHtml.includes("1 authorized chunk"))
  assert.ok(attempt2StartedHtml.includes(">retry<"))
  assert.ok(attempt2StartedHtml.includes("Retrieval attempt 2"))
  assert.ok(attempt2StartedHtml.includes("In progress"))

  enqueue({ type: "agent_step", step: { phase: "retrieval_attempt_2_completed", authorizedChunks: 2, mergedAuthorizedChunks: 3 } })
  enqueue({ type: "agent_step", step: { phase: "evidence_decision_2", decisionMode: "llm", decision: "answer" } })
  enqueue({ type: "agent_step", step: { phase: "final_decision", outcome: "answer", steps: 6, maxSteps: 6 } })
  enqueue({ type: "metadata", citations })
  enqueue({ type: "text", text: "Live recovered answer [Chunk 1]." })
  enqueue({
    type: "finish",
    metrics: {
      agent: {
        tool: "rag_retrieval",
        decision_mode: "llm",
        steps: 6,
        max_steps: 6,
        retrieval_attempts: 2,
        max_retrieval_attempts: 2,
        reformulated: true,
        next_action: "answer",
        final_outcome: "answer",
        retrieval_steps: [
          { attempt: 1, authorized_chunks: 1, decision: "retry_retrieval" },
          { attempt: 2, authorized_chunks: 2, merged_authorized_chunks: 3, decision: "answer" },
        ],
      },
    },
  })
  closeStream()
  await pending

  // Once finished, Agent Activity transitions to the collapsed-by-default completed panel below the answer.
  const finishedMsg = useChatStore.getState().messages.at(-1)!
  const finishedHtml = renderToStaticMarkup(createElement(MessageItem, { message: finishedMsg, isStreaming: false }))
  assert.match(finishedHtml, /<details\b[^>]*><summary\b[^>]*>Agent Activity<\/summary>/)
  assert.ok(!/<details\b[^>]*\bopen\b/.test(finishedHtml))
  assert.ok(finishedHtml.indexOf("Live recovered answer") < finishedHtml.indexOf("Agent Activity"))

  // Stream interruption/failure shows a clear failed state rather than completed steps.
  const pendingError = sendChat("Interrupted stream question?", projectId)
  await new Promise((resolve) => setImmediate(resolve))
  enqueue({ type: "agent_step", step: { phase: "tool_selected", decisionMode: "llm", tool: "rag_retrieval" } })
  enqueue({ type: "agent_step", step: { phase: "retrieval_attempt_1_completed", authorizedChunks: 1 } })
  enqueue({ type: "error", message: "The answer could not be completed. Please retry." })
  closeStream()
  await pendingError

  const failedMsg = useChatStore.getState().messages.at(-1)!
  assert.equal(failedMsg.agentActivity?.status, "failed")
  assert.equal(failedMsg.agentActivity?.finalOutcome, undefined)
  const failedHtml = renderToStaticMarkup(createElement(MessageItem, { message: failedMsg, isStreaming: false }))
  assert.ok(failedHtml.includes("Agent Activity (Interrupted / failed)"))
  assert.ok(failedHtml.includes("Interrupted / failed before completion"))
  assert.ok(!failedHtml.includes("Final outcome"))
})
