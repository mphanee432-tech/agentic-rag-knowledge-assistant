import type { SupabaseClient } from "@supabase/supabase-js"
import { withTimeout } from "@/lib/with-timeout"

export interface RagChunk { id: string; content: string; metadata: Record<string, unknown> }

const PERSONAL_SPARSE_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "by", "as", "at", "from", "into",
  "is", "are", "was", "were", "be", "what", "which", "when", "where", "who", "whom", "why", "how", "below",
  "under", "over", "does", "do", "did", "should", "could", "would", "can", "may", "must", "system", "document",
  "documents", "blueprint", "production", "rag", "recommend", "recommended", "list", "listed", "according",
  "tell", "me", "my", "your", "our", "their", "its", "that", "this", "these", "those", "both", "two", "three",
  "five", "single", "exact", "multi", "multiple", "chunk", "chunks", "count", "number",
])

/**
 * Personal `search_rag_chunks` uses `plainto_tsquery('simple', query_text)` (AND-matching every
 * unstemmed token). For verbose multi-word queries (7+ words), keep up to 3 distinctive domain terms
 * so sparse full-text matching does not collapse to 0 hits when meta-nouns or stopwords are absent.
 */
export function toPersonalSparseQueryText(queryText: string): string {
  const words = queryText.trim().split(/\s+/).filter(Boolean)
  if (words.length <= 6) return queryText

  const scored: Array<{ score: number; index: number; token: string }> = []
  const seen = new Set<string>()
  let rawIdx = 0
  for (const rawWord of words) {
    const subtokens = rawWord.match(/[A-Za-z0-9_]+/g) ?? []
    for (const sub of subtokens) {
      const idx = rawIdx++
      const low = sub.toLowerCase()
      if (low.length < 3 || PERSONAL_SPARSE_STOPWORDS.has(low) || seen.has(low)) continue
      seen.add(low)
      const isTechnicalCase = (idx > 0 && /[A-Z]/.test(sub)) || (sub.length >= 2 && sub === sub.toUpperCase() && /[A-Z]/.test(sub))
      const hasDigit = /\d/.test(sub)
      const score = (isTechnicalCase ? 10 : 0) + (hasDigit ? 8 : 0) + Math.min(low.length, 12)
      scored.push({ score, index: idx, token: low })
    }
  }
  if (!scored.length) return queryText
  const top = [...scored]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .sort((a, b) => a.index - b.index)
  return top.map(item => item.token).join(" ")
}

export async function retrieveVerifiedChunks(
  supabase: SupabaseClient, projectId: string | null, queryEmbedding: number[], userQuery: string,
  signal: AbortSignal, telemetry: { retries: { retrieval: number }; errors: string[]; rrf_rpc_ms?: number | null; chunk_verify_ms?: number | null },
  enterprise = false, organizationId: string | null = null,
): Promise<RagChunk[]> {
  telemetry.rrf_rpc_ms = telemetry.chunk_verify_ms = null
  const rpcStart = performance.now()
  let rankedIds: string[] = []
  try {
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        const rpcQueryText = enterprise || organizationId ? userQuery : toPersonalSparseQueryText(userQuery)
        const query = { query_embedding: queryEmbedding, query_text: rpcQueryText }
        const search = organizationId
          ? supabase.rpc("search_enterprise_chunks", { ...query, target_organization_id: organizationId })
          : supabase.rpc("search_rag_chunks", { ...query, target_project_id: projectId?.trim() })
        const { data, error } = await withTimeout(Promise.resolve(
          search.select(enterprise ? "id,content" : "id")
            .abortSignal(AbortSignal.any([signal, AbortSignal.timeout(15000)]))
            .overrideTypes<Array<{ id: string; content: string }>, { merge: false }>(),
        ), 15000, "Supabase Hybrid Search RPC")
        if (error) throw new Error(error.message)
        if (enterprise) {
          return (data ?? []).map((chunk: { id: string; content: string }) => ({
            id: chunk.id, content: chunk.content, metadata: {},
          }))
        }
        rankedIds = (Array.isArray(data) ? data : []).map((chunk: { id: string }) => chunk.id)
        break
      } catch (error) {
        if (attempt < 1) telemetry.retries.retrieval++
        else {
          telemetry.errors.push(`Retrieval RPC: ${error instanceof Error ? error.message : "Request failed"}`)
          throw error
        }
      }
    }
  } finally {
    telemetry.rrf_rpc_ms = performance.now() - rpcStart
  }
  if (!projectId || !rankedIds.length) return []

  // Personal citations use the owner's existing RLS path for source metadata.
  const verifyStart = performance.now()
  let verification
  try {
    verification = await supabase.from("document_chunks")
      .select("id, content, metadata, documents!inner(status)").eq("project_id", projectId.trim())
      .eq("documents.project_id", projectId.trim()).eq("documents.status", "indexed").in("id", rankedIds)
      .abortSignal(AbortSignal.any([signal, AbortSignal.timeout(15000)]))
  } finally {
    telemetry.chunk_verify_ms = performance.now() - verifyStart
  }
  const { data: allowed, error } = verification
  if (error) throw error
  const verified = new Map(((allowed || []) as RagChunk[]).map(chunk => [chunk.id, chunk]))
  return rankedIds.map(id => verified.get(id)).filter((chunk): chunk is RagChunk => Boolean(chunk))
}
