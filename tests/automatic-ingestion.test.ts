import assert from "node:assert/strict"
import test from "node:test"
import { POST } from "../app/api/webhooks/storage/route"

test("automatic webhook dispatch isolates workspaces and fences duplicate events", async t => {
  const env = {
    NEXT_PUBLIC_PERSONAL_SUPABASE_URL: "https://personal-ingestion.invalid",
    NEXT_PUBLIC_ENTERPRISE_SUPABASE_URL: "https://enterprise-ingestion.invalid",
    PERSONAL_SUPABASE_SECRET_KEY: "sb_secret_personal_test",
    ENTERPRISE_SUPABASE_SECRET_KEY: "sb_secret_enterprise_test",
    PERSONAL_SUPABASE_WEBHOOK_SECRET: "personal-hook-test",
    ENTERPRISE_SUPABASE_WEBHOOK_SECRET: "enterprise-hook-test",
    GOOGLE_GENERATIVE_AI_API_KEY: "test-google",
  }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const request = (workspace: string, path: string, secret: string) => new Request(
    `https://app.invalid/api/webhooks/storage?workspace=${workspace}`, {
      method: "POST", headers: { "x-webhook-secret": secret },
      body: JSON.stringify({ type: "INSERT", record: { bucket_id: "documents", name: path } }),
    },
  )
  await t.test("invalid scope, wrong secret and mismatched path cannot access either database", async st => {
    const fetch = st.mock.method(globalThis, "fetch", async () => { throw new Error("No network expected") })
    assert.equal((await POST(request("invalid", "source.txt", env.PERSONAL_SUPABASE_WEBHOOK_SECRET))).status, 400)
    assert.equal((await POST(request("enterprise", "enterprise/source.txt", env.PERSONAL_SUPABASE_WEBHOOK_SECRET))).status, 401)
    assert.equal((await POST(request("personal", "enterprise/source.txt", env.PERSONAL_SUPABASE_WEBHOOK_SECRET))).status, 400)
    assert.equal((await POST(request("enterprise", "user/source.txt", env.ENTERPRISE_SUPABASE_WEBHOOK_SECRET))).status, 400)
    assert.equal((await POST(new Request("https://app.invalid/api/webhooks/storage", {
      method: "POST", headers: { "x-webhook-secret": env.PERSONAL_SUPABASE_WEBHOOK_SECRET }, body: "{}",
    }))).status, 400)
    assert.equal(fetch.mock.callCount(), 0)
  })
  for (const workspace of ["personal", "enterprise"] as const) {
    await t.test(`${workspace}: Storage event starts ingestion; active and indexed duplicates never write twice`, async st => {
      const content = "# Automatic ingestion\n\nPublic test fixture."
      const path = `${workspace === "enterprise" ? "enterprise/" : "user/"}project/document/source.txt`
      const host = `${workspace}-ingestion.invalid`
      const secret = workspace === "personal" ? env.PERSONAL_SUPABASE_WEBHOOK_SECRET : env.ENTERPRISE_SUPABASE_WEBHOOK_SECRET
      let status = "pending_upload"
      let lease: string | undefined
      let attempts = 0
      let finishCalls = 0
      let chunkCount = 0
      let releaseEmbedding!: () => void
      let embeddingStarted!: () => void
      const started = new Promise<void>(resolve => { embeddingStarted = resolve })
      const release = new Promise<void>(resolve => { releaseEmbedding = resolve })
      st.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.hostname === "generativelanguage.googleapis.com") {
          if (url.pathname.endsWith(":batchEmbedContents")) {
            embeddingStarted()
            await release
            return Response.json({ embeddings: [{ values: Array(1536).fill(0.1) }] })
          }
          return Response.json({ candidates: [{ content: { parts: [{ text: "[]" }] }, finishReason: "STOP" }] })
        }
        assert.equal(url.hostname, host, "Webhook must never fall back to the other project")
        assert.equal(new Headers(init?.headers).get("apikey"), `sb_secret_${workspace}_test`)
        if (url.pathname === "/rest/v1/documents") return Response.json([{
          id: "document", project_id: "project", storage_path: path, status, expected_size: Buffer.byteLength(content),
        }])
        if (url.pathname.endsWith("/claim_document_ingestion")) {
          if (status === "processing") return Response.json(false)
          attempts++
          status = "processing"
          lease = JSON.parse(String(init?.body)).p_lease
          return Response.json(true)
        }
        if (url.pathname.startsWith("/storage/v1/object/")) return new Response(content)
        if (url.pathname.endsWith("/finish_document_ingestion")) {
          const body = JSON.parse(String(init?.body))
          assert.equal(body.p_lease, lease)
          finishCalls++
          chunkCount = body.p_chunks.length
          status = "indexed"
          return Response.json(null)
        }
        if (url.pathname === "/rest/v1/projects") return new Response(null, { status: 204 })
        assert.fail("Unexpected request")
      })
      const first = POST(request(workspace, path, secret))
      await started
      const duplicate = await POST(request(workspace, path, secret))
      assert.equal(duplicate.status, 409)
      assert.equal(attempts, 1)
      releaseEmbedding()
      assert.equal((await first).status, 200)
      const replay = await POST(request(workspace, path, secret))
      assert.equal((await replay.json()).alreadyIndexed, true)
      assert.equal(attempts, 1)
      assert.equal(finishCalls, 1)
      assert.equal(chunkCount, 1)
    })
  }
})
