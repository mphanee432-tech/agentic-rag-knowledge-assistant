import assert from "node:assert/strict"
import test from "node:test"
import { geminiIngestionFetch, isTransientGeminiError, withGeminiRetry } from "../lib/gemini-ingestion-retry"

test("Gemini retries honor status, jitter, Retry-After, attempt limits and deadlines", async t => {
  const previous = process.env.GEMINI_INGESTION_MAX_ATTEMPTS
  delete process.env.GEMINI_INGESTION_MAX_ATTEMPTS
  t.after(() => {
    if (previous === undefined) delete process.env.GEMINI_INGESTION_MAX_ATTEMPTS
    else process.env.GEMINI_INGESTION_MAX_ATTEMPTS = previous
  })
  t.mock.method(Math, "random", () => 0.5)
  const warnings: string[] = []
  t.mock.method(console, "warn", (message: string) => { warnings.push(message) })
  const delays: number[] = []
  const realSetTimeout = globalThis.setTimeout
  t.mock.method(globalThis, "setTimeout", ((callback: () => void, ms: number) => {
    delays.push(ms)
    return realSetTimeout(callback, 0)
  }) as typeof setTimeout)
  const options = () => ({ stage: "extraction" as const, model: "test-model", inputBytes: 100,
    signal: new AbortController().signal, deadline: Date.now() + 100000, attemptTimeoutMs: 60000 })

  for (const status of [429, 500, 502, 503, 504]) {
    await t.test(`${status} recovers with jitter`, async () => {
      delays.length = 0
      let calls = 0
      const result = await withGeminiRetry(async () => {
        if (++calls === 1) throw Object.assign(new Error("secret content must not be logged"), { status })
        return "success"
      }, options())
      assert.equal(result, "success")
      assert.equal(calls, 2)
      assert.deepEqual(delays, [1500])
    })
  }
  for (const status of [400, 401, 403, 404]) {
    await t.test(`${status} never retries`, async () => {
      let calls = 0
      await assert.rejects(withGeminiRetry(async () => {
        calls++
        throw Object.assign(new Error("permanent"), { status })
      }, options()))
      assert.equal(calls, 1)
    })
  }
  await t.test("exhaustion respects default and configured total attempts", async () => {
    for (const limit of [3, 2]) {
      if (limit === 2) process.env.GEMINI_INGESTION_MAX_ATTEMPTS = "2"
      let calls = 0
      delays.length = 0
      await assert.rejects(withGeminiRetry(async () => {
        calls++
        throw Object.assign(new Error("busy"), { status: 503 })
      }, options()))
      assert.equal(calls, limit)
      assert.deepEqual(delays, limit === 3 ? [1500, 3000] : [1500])
    }
    delete process.env.GEMINI_INGESTION_MAX_ATTEMPTS
  })
  await t.test("SDK fetch adapter preserves Retry-After seconds and dates", async st => {
    for (const retryAfter of ["5", new Date(Date.now() + 10000).toUTCString()]) {
      delays.length = 0
      let calls = 0
      st.mock.method(globalThis, "fetch", async () => ++calls === 1
        ? new Response("sensitive provider error", { status: 429, headers: { "Retry-After": retryAfter } })
        : new Response("OK"))
      await withGeminiRetry(() => geminiIngestionFetch("https://gemini.invalid"), options())
      assert.equal(calls, 2)
      assert.ok(delays[0] >= (retryAfter === "5" ? 5000 : 8000))
    }
  })
  await t.test("known network failures retry, generic SDK errors do not", async () => {
    const network = new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })
    assert.equal(isTransientGeminiError(network), true)
    assert.equal(isTransientGeminiError(new TypeError("invalid configuration")), false)
    let calls = 0
    await withGeminiRetry(async () => { if (++calls === 1) throw network }, options())
    assert.equal(calls, 2)
  })
  await t.test("expired deadline and Retry-After beyond budget do not start another attempt", async () => {
    let calls = 0
    const operation = async () => {
      calls++
      throw Object.assign(new Error("busy"), { status: 503, retryAfter: "300" })
    }
    await assert.rejects(withGeminiRetry(operation, { ...options(), deadline: Date.now() - 1 }), { name: "TimeoutError" })
    assert.equal(calls, 0)
    await assert.rejects(withGeminiRetry(operation, options()), { name: "TimeoutError" })
    assert.equal(calls, 1)
  })
  await t.test("deadline expiring during an operation stops retries", async st => {
    let now = Date.now()
    const settings = { ...options(), deadline: now + 100 }
    st.mock.method(Date, "now", () => now)
    let calls = 0
    await assert.rejects(withGeminiRetry(async () => {
      calls++
      now += 200
      throw Object.assign(new Error("busy"), { status: 503 })
    }, settings), { name: "TimeoutError" })
    assert.equal(calls, 1)
  })
  await t.test("cancellation interrupts backoff without a new attempt", async () => {
    const controller = new AbortController()
    let calls = 0
    const pending = withGeminiRetry(async () => {
      calls++
      realSetTimeout(() => controller.abort(), 0)
      throw Object.assign(new Error("busy"), { status: 503 })
    }, { ...options(), signal: controller.signal })
    await assert.rejects(pending, { name: "AbortError" })
    assert.equal(calls, 1)
  })
  await t.test("an attempt timeout aborts the request and retries with a fresh signal", async () => {
    let calls = 0
    const signals: AbortSignal[] = []
    const [result] = await Promise.all([
      withGeminiRetry(async signal => {
        signals.push(signal)
        if (++calls === 1) await new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
        return "success"
      }, { ...options(), attemptTimeoutMs: 5 }),
      new Promise(resolve => realSetTimeout(resolve, 30)),
    ])
    assert.equal(result, "success")
    assert.equal(calls, 2)
    assert.notEqual(signals[0], signals[1])
    assert.equal(signals[0].aborted, true)
  })
  assert.ok(warnings.length > 0)
  assert.ok(!warnings.join().includes("secret content"))
  for (const line of warnings) {
    const entry = JSON.parse(line)
    assert.equal(typeof entry.attempt, "number")
    assert.equal(typeof entry.retryDelayMs, "number")
    assert.ok("status" in entry)
  }
})
