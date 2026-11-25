import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs/promises"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime"
import { ChatContainer } from "../components/chat/chat-container"
import { useChatStore } from "../lib/store/chat-store"
import { waitForEnterpriseIndexing } from "../lib/enterprise-upload"

const mockRouter = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: async () => {},
} as unknown as AppRouterInstance

function renderWithRouter(node: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: mockRouter }, node))
}

test("Enterprise Upload Document button is shown only for authorized Enterprise uploaders", t => {
  const initial = useChatStore.getState()
  t.after(() => useChatStore.setState(initial, true))

  const orgId = "c0000000-0000-4000-8000-000000000001"

  const authorizedHtml = renderWithRouter(
    createElement(ChatContainer, {
      organizationId: orgId,
      canUploadPolicy: true,
    }),
  )
  assert.ok(authorizedHtml.includes("Upload Document"))

  const employeeHtml = renderWithRouter(
    createElement(ChatContainer, {
      organizationId: orgId,
      canUploadPolicy: false,
    }),
  )
  assert.ok(!employeeHtml.includes("Upload Document"))

  const personalHtml = renderWithRouter(
    createElement(ChatContainer, {
      projectId: "11111111-1111-4111-8111-111111111111",
      canUploadPolicy: true,
    }),
  )
  assert.ok(!personalHtml.includes("Upload Document"))
})

test("Enterprise upload UI derives authorization from server context, preserves manual publish, and leaks no secrets", async () => {
  const [pageSrc, chatSrc, dialogSrc, helperSrc] = await Promise.all([
    fs.readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../components/chat/chat-container.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../components/upload/enterprise-policy-dialog.tsx", import.meta.url), "utf8"),
    fs.readFile(new URL("../lib/enterprise-upload.ts", import.meta.url), "utf8"),
  ])

  assert.match(pageSrc, /getEnterpriseCopilotContext\(supabase\)/)
  assert.match(pageSrc, /canUploadPolicy=\{enterprise\.can_upload_policy\}/)
  assert.match(chatSrc, /\{enterprise && canUploadPolicy && \(/)
  assert.match(chatSrc, /\{organizationId && canUploadPolicy && \(/)

  assert.match(dialogSrc, /accept="\.pdf,\.txt,\.html"/)
  assert.match(dialogSrc, /25 \* 1024 \* 1024/)
  assert.match(dialogSrc, /\/api\/enterprise\/departments\?organizationId=/)
  assert.match(dialogSrc, /\/api\/documents\/upload-url/)
  assert.match(dialogSrc, /uploadToSignedUrl/)
  assert.match(dialogSrc, /if \(indexed\) \{[\s\S]*\/api\/enterprise\/ingest/)
  assert.match(dialogSrc, /Indexed — unpublished\. Select Publish Document/)
  assert.match(dialogSrc, /Retry Publication/)
  assert.match(dialogSrc, /Publish Document/)

  for (const clientSrc of [chatSrc, dialogSrc, helperSrc]) {
    assert.doesNotMatch(clientSrc, /SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|WEBHOOK_SECRET|SUPABASE_ACCESS_TOKEN/)
  }
})

test("waitForEnterpriseIndexing polls GET status without auto-publishing and reports indexing states", async t => {
  const realSetTimeout = globalThis.setTimeout
  t.mock.method(globalThis, "setTimeout", ((cb: (...args: unknown[]) => void, ms?: number) =>
    realSetTimeout(cb, ms === 3000 ? 0 : ms)) as typeof setTimeout)

  const statuses = ["uploaded", "processing", "indexed"]
  let index = 0
  const seenMethods: string[] = []
  const messages: string[] = []

  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "https://app.invalid")
    seenMethods.push(init?.method ?? "GET")
    assert.equal(url.pathname, "/api/enterprise/ingest")
    assert.equal(url.searchParams.get("documentId"), "doc-1")
    assert.equal(url.searchParams.get("projectId"), "proj-1")
    return Response.json({
      document: { id: "doc-1", status: statuses[index++], is_published: false, last_ingestion_error: null },
    })
  })

  await waitForEnterpriseIndexing(
    { documentId: "doc-1", projectId: "proj-1" },
    message => messages.push(message),
    new AbortController().signal,
  )

  assert.deepEqual(seenMethods, ["GET", "GET", "GET"])
  assert.deepEqual(messages, [
    "Uploaded — waiting for automatic ingestion recovery.",
    "Processing — extracting text and generating embeddings...",
  ])

  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      document: { id: "doc-2", status: "failed", is_published: false, last_ingestion_error: "Unsupported file." },
    }),
  )

  await assert.rejects(
    waitForEnterpriseIndexing({ documentId: "doc-2", projectId: "proj-1" }, () => {}, new AbortController().signal),
    /Unsupported file\./,
  )
})
