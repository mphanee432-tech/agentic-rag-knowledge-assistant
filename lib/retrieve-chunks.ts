import type { SupabaseClient } from "@supabase/supabase-js"
import { withTimeout } from "@/lib/with-timeout"

export interface RagChunk { id: string; content: string; metadata: Record<string, unknown> }

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
        const query = { query_embedding: queryEmbedding, query_text: userQuery }
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
