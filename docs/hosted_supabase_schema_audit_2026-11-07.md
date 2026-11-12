# Hosted Supabase schema metadata audit — 2026-11-07
**READ-ONLY EVIDENCE — NOT AN EXECUTABLE MIGRATION OR HISTORICAL BOOTSTRAP.**
Source: Supabase PostgreSQL system catalogs queried with read-only SELECT statements; no application table rows, documents, user data, or secrets. PostgreSQL 17.11. No hosted writes.

## Critical limitations
- This is an evidence snapshot, not an executable bootstrap, data backup, or Supabase schema migration.
- Postgres catalog exposes current column/constraint definitions but not exact historical CREATE TABLE statements.
- The four existing migration SQL files must be inspected; first three local and hosted migration versions differ.
- Functions other than check_project_document_limit and match_chunks_hybrid_rrf are identified by name but their full bodies are NOT included here; existing incremental migrations may define them.
- Supabase-managed schemas such as auth and storage should be furnished by local Supabase CLI, not copied wholesale from hosted.
- The existing recover-document-ingestion Cron job and Storage dispatch trigger must never reach production or ngrok from local tests.
- No hosted writes, auth.users rows, project rows, documents, interactions, secrets, or Vault secret values were retrieved.

## Migration version discrepancy
| Migration | Local version | Hosted version |
|---|---|---|
| `harden_access_and_ingestion` | `202610280001` | `20261104093632` |
| `automatic_ingestion_recovery` | `202611040001` | `20261104093711` |
| `align_storage_webhook` | `202611040002` | `20261104093923` |
| `restrict_cleanup_trigger_execution` | `20261104094738` | `20261104094738` |

## Installed extensions
- `pg_cron` v1.6.4
- `pg_net` v0.20.4
- `pgcrypto` v1.3
- `supabase_vault` v0.3.1
- `uuid-ossp` v1.1
- `vector` v0.8.2

## Table `public.projects` — current catalog columns
| Column | Type | Nullability | Default or generation expression |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` |
| `user_id` | `uuid` | NOT NULL | `—` |
| `created_at` | `timestamp with time zone` | NOT NULL | `timezone('utc'::text, now())` |
| `name` | `text` | NOT NULL | `'Untitled Project'::text` |
| `suggested_queries` | `jsonb` | nullable | `'[]'::jsonb` |

**Current constraints:**
```sql
-- projects_pkey
PRIMARY KEY (id);
-- projects_user_id_fkey
FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
```
**Current index definitions:**
```sql
CREATE INDEX idx_projects_user_id ON public.projects USING btree (user_id)
CREATE UNIQUE INDEX projects_pkey ON public.projects USING btree (id)
```
**Current row-level security policies (catalog expressions):**
- **Projects tenant isolation policy** — PERMISSIVE, ALL, roles `{public}`
```sql
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid())
```
- **owner_access** — PERMISSIVE, ALL, roles `{authenticated}`
```sql
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid())
```
- **owner_boundary** — RESTRICTIVE, ALL, roles `{public}`
```sql
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid())
```

## Table `public.documents` — current catalog columns
| Column | Type | Nullability | Default or generation expression |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` |
| `project_id` | `uuid` | NOT NULL | `—` |
| `storage_path` | `text` | NOT NULL | `—` |
| `status` | `text` | NOT NULL | `—` |
| `created_at` | `timestamp with time zone` | NOT NULL | `timezone('utc'::text, now())` |
| `expected_size` | `bigint` | nullable | `—` |
| `ingestion_lease` | `uuid` | nullable | `—` |
| `lease_expires_at` | `timestamp with time zone` | nullable | `—` |
| `ingestion_attempts` | `integer` | NOT NULL | `0` |
| `next_ingestion_attempt_at` | `timestamp with time zone` | nullable | `now()` |
| `ingestion_dispatched_at` | `timestamp with time zone` | nullable | `—` |
| `last_ingestion_error` | `text` | nullable | `—` |

**Current constraints:**
```sql
-- documents_ingestion_attempts_check
CHECK (ingestion_attempts >= 0);
-- documents_pkey
PRIMARY KEY (id);
-- documents_project_id_fkey
FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
-- documents_status_check
CHECK (status = ANY (ARRAY['pending_upload'::text, 'uploaded'::text, 'processing'::text, 'indexed'::text, 'failed'::text]));
```
**Current index definitions:**
```sql
CREATE INDEX documents_ingestion_recovery ON public.documents USING btree (next_ingestion_attempt_at, lease_expires_at) WHERE (status = ANY (ARRAY['pending_upload'::text, 'uploaded'::text, 'processing'::text]))
CREATE UNIQUE INDEX documents_pkey ON public.documents USING btree (id)
CREATE UNIQUE INDEX documents_storage_path_unique ON public.documents USING btree (storage_path)
CREATE INDEX idx_documents_project_id ON public.documents USING btree (project_id)
```
**Current row-level security policies (catalog expressions):**
- **Documents tenant isolation policy** — PERMISSIVE, ALL, roles `{public}`
```sql
USING (EXISTS ( SELECT 1
   FROM projects
  WHERE ((projects.id = documents.project_id) AND (projects.user_id = auth.uid()))))
WITH CHECK (EXISTS ( SELECT 1
   FROM projects
  WHERE ((projects.id = documents.project_id) AND (projects.user_id = auth.uid()))))
```
- **owner_boundary** — RESTRICTIVE, ALL, roles `{public}`
```sql
USING (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = documents.project_id) AND (p.user_id = auth.uid()))))
WITH CHECK (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = documents.project_id) AND (p.user_id = auth.uid()))))
```
- **owner_document_delete** — PERMISSIVE, DELETE, roles `{authenticated}`
```sql
USING true
-- WITH CHECK: absent
```
- **owner_read** — PERMISSIVE, SELECT, roles `{authenticated}`
```sql
USING true
-- WITH CHECK: absent
```

## Table `public.document_chunks` — current catalog columns
| Column | Type | Nullability | Default or generation expression |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` |
| `document_id` | `uuid` | NOT NULL | `—` |
| `project_id` | `uuid` | NOT NULL | `—` |
| `content` | `text` | NOT NULL | `—` |
| `metadata` | `jsonb` | NOT NULL | `'{}'::jsonb` |
| `embedding` | `vector(1536)` | NOT NULL | `—` |
| `created_at` | `timestamp with time zone` | NOT NULL | `timezone('utc'::text, now())` |
| `fts` | `tsvector` | nullable | `GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED` |

**Current constraints:**
```sql
-- document_chunks_document_id_fkey
FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE;
-- document_chunks_pkey
PRIMARY KEY (id);
-- document_chunks_project_id_fkey
FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
```
**Current index definitions:**
```sql
CREATE UNIQUE INDEX document_chunks_pkey ON public.document_chunks USING btree (id)
CREATE INDEX idx_document_chunks_document_id ON public.document_chunks USING btree (document_id)
CREATE INDEX idx_document_chunks_embedding_hnsw ON public.document_chunks USING hnsw (embedding vector_cosine_ops) WITH (m='32', ef_construction='128')
CREATE INDEX idx_document_chunks_fts ON public.document_chunks USING gin (fts)
CREATE INDEX idx_document_chunks_project_id ON public.document_chunks USING btree (project_id)
```
**Current row-level security policies (catalog expressions):**
- **Tenant chunks isolation policy** — PERMISSIVE, ALL, roles `{public}`
```sql
USING (EXISTS ( SELECT 1
   FROM projects
  WHERE ((projects.id = document_chunks.project_id) AND (projects.user_id = auth.uid()))))
WITH CHECK (EXISTS ( SELECT 1
   FROM projects
  WHERE ((projects.id = document_chunks.project_id) AND (projects.user_id = auth.uid()))))
```
- **owner_boundary** — RESTRICTIVE, ALL, roles `{public}`
```sql
USING (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = document_chunks.project_id) AND (p.user_id = auth.uid()))))
WITH CHECK (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = document_chunks.project_id) AND (p.user_id = auth.uid()))))
```
- **owner_read** — PERMISSIVE, SELECT, roles `{authenticated}`
```sql
USING true
-- WITH CHECK: absent
```

## Table `public.interactions` — current catalog columns
| Column | Type | Nullability | Default or generation expression |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` |
| `project_id` | `uuid` | NOT NULL | `—` |
| `user_id` | `uuid` | NOT NULL | `—` |
| `query_text` | `text` | NOT NULL | `—` |
| `retrieved_chunk_ids` | `uuid[]` | nullable | `'{}'::uuid[]` |
| `response_markdown` | `text` | NOT NULL | `—` |
| `token_counts` | `jsonb` | nullable | `'{}'::jsonb` |
| `latency_ms` | `integer` | NOT NULL | `—` |
| `rating` | `text` | nullable | `—` |
| `issue_tag` | `text` | nullable | `—` |
| `user_comment` | `text` | nullable | `—` |
| `created_at` | `timestamp with time zone` | NOT NULL | `timezone('utc'::text, now())` |
| `feedback` | `jsonb` | nullable | `—` |

**Current constraints:**
```sql
-- interactions_pkey
PRIMARY KEY (id);
-- interactions_project_id_fkey
FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
-- interactions_rating_check
CHECK (rating = ANY (ARRAY['thumbs_up'::text, 'thumbs_down'::text]));
-- interactions_user_id_fkey
FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
```
**Current index definitions:**
```sql
CREATE INDEX idx_interactions_project_id ON public.interactions USING btree (project_id)
CREATE INDEX idx_interactions_user_id ON public.interactions USING btree (user_id)
CREATE UNIQUE INDEX interactions_pkey ON public.interactions USING btree (id)
```
**Current row-level security policies (catalog expressions):**
- **Interactions tenant isolation policy** — PERMISSIVE, ALL, roles `{public}`
```sql
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid())
```
- **owner_boundary** — RESTRICTIVE, ALL, roles `{public}`
```sql
USING (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = interactions.project_id) AND (p.user_id = auth.uid()))))
WITH CHECK (EXISTS ( SELECT 1
   FROM projects p
  WHERE ((p.id = interactions.project_id) AND (p.user_id = auth.uid()))))
```
- **owner_feedback_update** — PERMISSIVE, UPDATE, roles `{authenticated}`
```sql
USING true
WITH CHECK true
```
- **owner_read** — PERMISSIVE, SELECT, roles `{authenticated}`
```sql
USING true
-- WITH CHECK: absent
```

## Authenticated client privileges
| Table | anon | authenticated | service_role |
|---|---|---|---|
| `projects` | None | SELECT, INSERT, UPDATE, DELETE | SELECT, INSERT, UPDATE, DELETE |
| `documents` | None | SELECT, DELETE | SELECT, INSERT, UPDATE, DELETE |
| `document_chunks` | None | SELECT | SELECT, INSERT, UPDATE, DELETE |
| `interactions` | None | SELECT, UPDATE(feedback) | SELECT, INSERT, UPDATE, DELETE |

## Application-relevant triggers
```sql
CREATE TRIGGER delete_document_children BEFORE DELETE ON documents FOR EACH ROW EXECUTE FUNCTION delete_document_children();
CREATE TRIGGER enforce_document_quota BEFORE INSERT OR UPDATE OF status, project_id ON documents FOR EACH ROW EXECUTE FUNCTION enforce_document_quota();
CREATE TRIGGER trg_enforce_project_document_limit BEFORE INSERT ON documents FOR EACH ROW EXECUTE FUNCTION check_project_document_limit();
CREATE TRIGGER delete_project_children BEFORE DELETE ON projects FOR EACH ROW EXECUTE FUNCTION delete_project_children();
CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();
CREATE TRIGGER "storage.objects.insert" AFTER INSERT ON storage.objects FOR EACH ROW EXECUTE FUNCTION dispatch_document_ingestion();
CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();
```

## Exact current `pg_get_functiondef` definitions included

### `public.check_project_document_limit`
```sql
CREATE OR REPLACE FUNCTION public.check_project_document_limit()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    active_count INTEGER;
BEGIN
    -- Count existing documents excluding failed uploads
    SELECT COUNT(*) INTO active_count
    FROM public.documents
    WHERE project_id = NEW.project_id
      AND status != 'failed';

    IF active_count >= 10 THEN
        RAISE EXCEPTION 'Project document limit reached: maximum 10 documents allowed.'
        USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$function$
```

### `public.match_chunks_hybrid_rrf`
```sql
CREATE OR REPLACE FUNCTION public.match_chunks_hybrid_rrf(query_embedding vector, query_text text, target_project_id uuid, match_count integer DEFAULT 5, rrf_k integer DEFAULT 60)
 RETURNS TABLE(id uuid, document_id uuid, project_id uuid, content text, metadata jsonb, similarity double precision, rrf_score double precision)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
    RETURN QUERY
    WITH dense_candidates AS (
        -- 1. Dense Semantic Search (Cosine distance via HNSW index)
        SELECT
            dc.id,
            ROW_NUMBER() OVER (ORDER BY dc.embedding <=> query_embedding) AS dense_rank,
            (1 - (dc.embedding <=> query_embedding))::float AS dense_similarity
        FROM public.document_chunks dc
        WHERE dc.project_id = target_project_id
        ORDER BY dc.embedding <=> query_embedding
        LIMIT 50
    ),
    sparse_candidates AS (
        -- 2. Sparse Lexical Search (tsvector matching using 'simple' dictionary)
        SELECT
            dc.id,
            ROW_NUMBER() OVER (
                ORDER BY ts_rank_cd(dc.fts, plainto_tsquery('simple', query_text)) DESC
            ) AS sparse_rank
        FROM public.document_chunks dc
        WHERE dc.project_id = target_project_id
          AND dc.fts @@ plainto_tsquery('simple', query_text)
        ORDER BY ts_rank_cd(dc.fts, plainto_tsquery('simple', query_text)) DESC
        LIMIT 50
    ),
    fused_scores AS (
        -- 3. Reciprocal Rank Fusion calculation
        SELECT
            COALESCE(d.id, s.id) AS chunk_id,
            (
                COALESCE(1.0 / (rrf_k + d.dense_rank), 0.0) +
                COALESCE(1.0 / (rrf_k + s.sparse_rank), 0.0)
            )::float AS combined_rrf_score,
            COALESCE(d.dense_similarity, 0.0) AS final_similarity
        FROM dense_candidates d
        FULL OUTER JOIN sparse_candidates s ON d.id = s.id
    )
    -- 4. Final join back to document_chunks to return full payloads
    SELECT
        dc.id,
        dc.document_id,
        dc.project_id,
        dc.content,
        dc.metadata,
        f.final_similarity AS similarity,
        f.combined_rrf_score AS rrf_score
    FROM fused_scores f
    JOIN public.document_chunks dc ON dc.id = f.chunk_id
    ORDER BY f.combined_rrf_score DESC
    LIMIT match_count;
END;
$function$
```

## Other hosted functions identified (full DDL not bundled)
- `public.claim_document_ingestion`
- `public.delete_document_children`
- `public.delete_project_children`
- `public.dispatch_document_ingestion`
- `public.enforce_document_quota`
- `public.fail_document_ingestion`
- `public.finish_document_ingestion`
- `public.recover_document_ingestion`

## Explicit instruction to Codex
Use this artifact as **current hosted schema evidence**. Compare it with local migrations. Do **not** present any inferred historical pre-hardening DDL as exact; when uncertain, report the missing definition and block. Do not run hosted writes or modify production migration history.
