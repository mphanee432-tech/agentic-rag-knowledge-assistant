export async function sleep(ms: number, signal: AbortSignal) {
  signal.throwIfAborted()
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export function getGeminiErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const err = error as { status?: unknown; statusCode?: unknown; cause?: unknown }
  if (typeof err.status === "number") return err.status
  if (typeof err.statusCode === "number") return err.statusCode
  if (err.cause && typeof err.cause === "object") {
    const cause = err.cause as { status?: unknown; statusCode?: unknown }
    if (typeof cause.status === "number") return cause.status
    if (typeof cause.statusCode === "number") return cause.statusCode
  }
  return undefined
}

export function isAbortOrTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === "AbortError" || error.name === "TimeoutError") return true
  const cause = (error as { cause?: unknown }).cause
  return cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")
}

const TRANSIENT_NETWORK_CODES = [
  "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]

export function isTransientGeminiError(error: unknown): boolean {
  const status = getGeminiErrorStatus(error)
  if (status !== undefined) return [429, 500, 502, 503, 504].includes(status)
  if (isAbortOrTimeoutError(error)) return true
  if (!error || typeof error !== "object") return false
  const network = error as { code?: unknown; cause?: { code?: unknown } }
  return TRANSIENT_NETWORK_CODES.includes(String(network.cause?.code ?? network.code))
}

// The SDK's ApiError drops response headers; preserve Retry-After without retaining its body.
export const geminiIngestionFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  if (response.ok) return response
  const error = Object.assign(new Error("Gemini HTTP request failed."), {
    status: response.status, retryAfter: response.headers.get("retry-after"),
  })
  await response.body?.cancel().catch(() => { })
  throw error
}

function retryAfterMs(error: unknown): number {
  const value = (error as { retryAfter?: string | null })?.retryAfter
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0
}

interface RetryOptions {
  stage: "extraction" | "embedding"
  model: string
  inputBytes: number
  signal: AbortSignal
  deadline: number
  attemptTimeoutMs: number
}

export async function withGeminiRetry<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  { stage, model, inputBytes, signal, deadline, attemptTimeoutMs }: RetryOptions,
): Promise<T> {
  const configured = Number(process.env.GEMINI_INGESTION_MAX_ATTEMPTS ?? 3)
  const maxAttempts = Number.isInteger(configured) && configured >= 1 && configured <= 10 ? configured : 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signal.throwIfAborted()
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new DOMException("Ingestion deadline exhausted.", "TimeoutError")
    const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(attemptTimeoutMs, remaining))])
    const started = Date.now()
    try {
      const result = await operation(attemptSignal)
      attemptSignal.throwIfAborted()
      return result
    } catch (error) {
      const status = getGeminiErrorStatus(error)
      const transient = isTransientGeminiError(error)
      const delay = Math.max(Math.round(1000 * 2 ** (attempt - 1) * (1 + Math.random())), retryAfterMs(error))
      const eligible = !signal.aborted && transient && attempt < maxAttempts
      const willRetry = eligible && delay < deadline - Date.now()
      console.warn(JSON.stringify({
        event: "gemini_ingest_attempt_failed", stage, model, inputBytes, attempt, maxAttempts,
        status: status ?? null, durationMs: Date.now() - started,
        failureType: status !== undefined ? `http_${status}` : isAbortOrTimeoutError(error) ? "attempt_timeout" : "network_or_sdk_error",
        retryDelayMs: willRetry ? delay : 0, willRetry,
      }))
      signal.throwIfAborted()
      if (eligible && !willRetry) throw new DOMException("Ingestion deadline exhausted before retry.", "TimeoutError")
      if (!willRetry) throw error
      await sleep(delay, signal)
    }
  }
  throw new Error("Gemini attempts exhausted.")
}

export interface TransientRetryOptions {
  signal: AbortSignal
  maxAttempts: number
  attemptTimeoutMs: number
  totalTimeoutMs: number
  baseDelayMs?: number
  onRetry?: () => void
}

/**
 * Bounded retry wrapper for transient Gemini orchestration/generation calls.
 * Enforces both per-attempt timeouts and an overall ceiling, never retrying after caller cancellation.
 */
export async function withTransientGeminiRetry<T>(
  operation: (attemptSignal: AbortSignal) => Promise<T>,
  { signal, maxAttempts, attemptTimeoutMs, totalTimeoutMs, baseDelayMs = 250, onRetry }: TransientRetryOptions,
): Promise<{ result: T; retries: number }> {
  const deadline = Date.now() + totalTimeoutMs
  const attempts = Math.max(1, maxAttempts)
  for (let attempt = 1; attempt <= attempts; attempt++) {
    signal.throwIfAborted()
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new DOMException("Gemini operation deadline exhausted.", "TimeoutError")
    }
    const timeoutMs = Math.min(attemptTimeoutMs, remaining)
    const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    try {
      const result = await operation(attemptSignal)
      signal.throwIfAborted()
      return { result, retries: attempt - 1 }
    } catch (error) {
      signal.throwIfAborted()
      const timedOutAttempt = attemptSignal.aborted && !signal.aborted
      const transient = timedOutAttempt || isTransientGeminiError(error)
      const effectiveBase =
        baseDelayMs > 0 && getGeminiErrorStatus(error) === 429
          ? Math.max(baseDelayMs, 2000)
          : baseDelayMs
      const jittered = Math.round(effectiveBase * 2 ** (attempt - 1) * (1 + Math.random() * 0.25))
      const delay = Math.max(jittered, retryAfterMs(error))
      const remainingAfterAttempt = deadline - Date.now()
      const canRetry = !signal.aborted && transient && attempt < attempts && delay < remainingAfterAttempt
      if (!canRetry) throw error
      onRetry?.()
      await sleep(delay, signal)
    }
  }
  throw new Error("Gemini attempts exhausted.")
}
