export interface EnterpriseUploadReservation { documentId: string; projectId: string }

export async function waitForEnterpriseIndexing(
  reservation: EnterpriseUploadReservation,
  onStatus: (message: string) => void,
  callerSignal: AbortSignal,
): Promise<void> {
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(300000)])
  const deadline = Date.now() + 300000
  // Observe the automatic Storage worker without claiming again or bypassing document backoff.
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const query = new URLSearchParams({ documentId: reservation.documentId, projectId: reservation.projectId })
    const status = await fetch(`/api/enterprise/ingest?${query}`, { signal, cache: "no-store" })
    const data = await status.json()
    if (!status.ok) throw new Error(data.error || "Unable to load document status.")
    if (!data.document || !["pending_upload", "uploaded", "processing", "indexed", "failed"].includes(data.document.status)) {
      throw new Error("Unable to load document status.")
    }
    if (data.document.status === "indexed") return
    if (data.document.status === "failed") throw new Error(data.document.last_ingestion_error || "Document indexing failed.")
    onStatus(data.document.status === "uploaded"
      ? "Uploaded — waiting for automatic ingestion recovery."
      : "Processing — extracting text and generating embeddings...")
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return }
      const onAbort = () => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve() }, 3000)
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }
  throw new Error("The document is still processing. Retry checking its status; do not re-upload it.")
}
