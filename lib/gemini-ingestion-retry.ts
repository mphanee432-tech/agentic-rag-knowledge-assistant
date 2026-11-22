async function sleep(ms: number, signal: AbortSignal) {
  signal.throwIfAborted()
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
  const { status } = error as { status?: unknown }
  return typeof status === "number" ? status : undefined
}

export function isAbortOrTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
}

export function isTransientGeminiError(error: unknown): boolean {
  const status = getGeminiErrorStatus(error)
  if (status !== undefined) return [429, 500, 502, 503, 504].includes(status)
  if (isAbortOrTimeoutError(error)) return true
  if (!error || typeof error !== "object") return false
  const network = error as { code?: unknown; cause?: { code?: unknown } }
  return ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]
    .includes(String(network.cause?.code ?? network.code))
}

// The SDK's ApiError drops response headers; preserve Retry-After without retaining its body.
export const geminiIngestionFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  if (response.ok) return response
  const error = Object.assign(new Error("Gemini HTTP request failed."), {
    status: response.status, retryAfter: response.headers.get("retry-after"),
  })
  await response.body?.cancel().catch(() => {})
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
