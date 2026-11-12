-- LOCAL ONLY. Catalog-derived prerequisites, not an exact historical migration.
-- Evidence: docs/hosted_supabase_schema_audit_2026-11-07.md minus the four
-- existing upgrade migrations. Those migrations supply their own added objects.
begin;
set local search_path = public, extensions;
set local plpgsql.check_asserts = on;

do $$ begin
  assert current_setting('server_version_num')::integer / 10000 = 17, 'PostgreSQL 17 required';
  assert to_regclass('auth.users') is not null and to_regclass('storage.objects') is not null,
    'Real Supabase Auth and Storage schemas required';
  assert to_regclass('public.projects') is null and to_regclass('public.documents') is null
    and to_regclass('public.document_chunks') is null and to_regclass('public.interactions') is null,
    'Refusing to bootstrap an existing application database';
end $$;

create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault;

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default timezone('utc'::text, now()),
  name text not null default 'Untitled Project'::text,
  suggested_queries jsonb default '[]'::jsonb
);
create index idx_projects_user_id on public.projects(user_id);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  storage_path text not null,
  status text not null constraint documents_status_check
    check (status = any (array['pending_upload','uploaded','processing','indexed','failed']::text[])),
  created_at timestamptz not null default timezone('utc'::text, now())
);
create index idx_documents_project_id on public.documents(project_id);

create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding extensions.vector(1536) not null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  fts tsvector generated always as (to_tsvector('simple'::regconfig, content)) stored
);
create index idx_document_chunks_document_id on public.document_chunks(document_id);
create index idx_document_chunks_project_id on public.document_chunks(project_id);
create index idx_document_chunks_embedding_hnsw on public.document_chunks
  using hnsw (embedding extensions.vector_cosine_ops) with (m=32, ef_construction=128);
create index idx_document_chunks_fts on public.document_chunks using gin(fts);

create table public.interactions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  query_text text not null,
  retrieved_chunk_ids uuid[] default '{}'::uuid[],
  response_markdown text not null,
  token_counts jsonb default '{}'::jsonb,
  latency_ms integer not null,
  rating text constraint interactions_rating_check check (rating = any (array['thumbs_up','thumbs_down']::text[])),
  issue_tag text,
  user_comment text,
  created_at timestamptz not null default timezone('utc'::text, now())
);
create index idx_interactions_project_id on public.interactions(project_id);
create index idx_interactions_user_id on public.interactions(user_id);

alter table public.projects enable row level security;
alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.interactions enable row level security;
create policy "Projects tenant isolation policy" on public.projects for all to public
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "Documents tenant isolation policy" on public.documents for all to public
  using (exists (select 1 from public.projects where projects.id = documents.project_id and projects.user_id = auth.uid()))
  with check (exists (select 1 from public.projects where projects.id = documents.project_id and projects.user_id = auth.uid()));
create policy "Tenant chunks isolation policy" on public.document_chunks for all to public
  using (exists (select 1 from public.projects where projects.id = document_chunks.project_id and projects.user_id = auth.uid()))
  with check (exists (select 1 from public.projects where projects.id = document_chunks.project_id and projects.user_id = auth.uid()));
create policy "Interactions tenant isolation policy" on public.interactions for all to public
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Least-privilege local starting grants, derived from the audited current CRUD
-- grants. Historical pre-hardening grants are unknown; migration 1 sets the final grants.
revoke all on public.projects, public.documents, public.document_chunks, public.interactions from public, anon, authenticated;
grant select, insert, update, delete on public.projects to authenticated;
grant select on public.documents, public.document_chunks, public.interactions to authenticated;
grant select, insert, update, delete on public.projects, public.documents, public.document_chunks, public.interactions to service_role;

-- Synthetic local Storage prerequisite; no application rows or Vault secrets.
insert into storage.buckets(id, name, public) values ('documents', 'documents', false)
  on conflict (id) do nothing;

-- Exact audited function definitions and the legacy quota trigger follow.
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
$function$;

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
$function$;

create trigger trg_enforce_project_document_limit before insert on public.documents
  for each row execute function public.check_project_document_limit();
commit;
