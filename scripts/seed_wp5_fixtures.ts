import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const apiKey = requireEnv('GOOGLE_GENERATIVE_AI_API_KEY');
const pgPassword = requireEnv('PGPASSWORD');

const ai = new GoogleGenAI({ apiKey });

async function getEmbedding(text: string): Promise<number[]> {
  const res = await ai.models.embedContent({
    model: 'gemini-embedding-2',
    contents: text,
    config: { outputDimensionality: 1536 },
  });
  const vec = res.embeddings?.[0]?.values;
  if (!vec || vec.length !== 1536) throw new Error('Failed to compute 1536d embedding');
  return vec;
}

const sopText =
  'DeccanBridge Software Engineering Code Review SOP: Every pull request requires at least two approvals from senior engineers before merging to production. Emergency deployment rollbacks must be initiated by filing an incident ticket and notifying the on-call lead.';

const restrictedText =
  'DeccanBridge Software Confidential Compensation Procedure: Executive bonus allocation is strictly capped at 15% of annual net EBITDA. Stock option grants follow a 4-year vesting schedule with a 1-year cliff.';

const d12Text =
  'DeccanBridge Software Project D12 Product Launch Playbook: Gate 4 deployment sign-off requires formal concurrence from both Product and Engineering Managers 48 hours prior to public release.';

async function main() {
  console.log('Generating embeddings via gemini-embedding-2 (1536d)...');
  const [sopEmbed, restrictedEmbed, d12Embed] = await Promise.all([
    getEmbedding(sopText),
    getEmbedding(restrictedText),
    getEmbedding(d12Text),
  ]);
  console.log('Embeddings generated successfully.');

  const sql = `
BEGIN;

-- 1. Organization
INSERT INTO public.organizations (id, name)
VALUES ('c0000000-0000-4000-8000-000000000001', 'DeccanBridge Software')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

-- 2. Department
INSERT INTO public.departments (organization_id, id, name)
VALUES ('c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'Engineering')
ON CONFLICT (organization_id, id) DO UPDATE SET name = EXCLUDED.name;

-- 3. Organization Employee
INSERT INTO public.organization_employees (organization_id, user_id, department_id, role, is_active)
VALUES ('c0000000-0000-4000-8000-000000000001', '5d14a0fa-aa42-499d-b985-a080b39c215a', 'c0000000-0000-4000-8000-000000000002', 'employee', true)
ON CONFLICT (organization_id, user_id) DO UPDATE SET is_active = true, role = 'employee', department_id = 'c0000000-0000-4000-8000-000000000002';

-- 4. Projects
INSERT INTO public.projects (id, user_id, organization_id, department_id, is_d12, name, suggested_queries)
VALUES ('c0000000-0000-4000-8000-000000000010', null, 'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', false, 'Engineering Knowledge Base', '[]'::jsonb)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, organization_id = EXCLUDED.organization_id, department_id = EXCLUDED.department_id, is_d12 = EXCLUDED.is_d12;

INSERT INTO public.projects (id, user_id, organization_id, department_id, is_d12, name, suggested_queries)
VALUES ('c0000000-0000-4000-8000-000000000020', null, 'c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', true, 'Project D12 Product Launch', '[]'::jsonb)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, organization_id = EXCLUDED.organization_id, department_id = EXCLUDED.department_id, is_d12 = EXCLUDED.is_d12;

-- 5. Documents
INSERT INTO public.documents (id, project_id, storage_path, status, is_published, classification, access_scope)
VALUES ('c0000000-0000-4000-8000-000000000100', 'c0000000-0000-4000-8000-000000000010', 'engineering/sop_review.html', 'indexed', true, 'standard', 'company')
ON CONFLICT (id) DO UPDATE SET status = 'indexed', is_published = true, classification = 'standard', access_scope = 'company';

INSERT INTO public.documents (id, project_id, storage_path, status, is_published, classification, access_scope)
VALUES ('c0000000-0000-4000-8000-000000000200', 'c0000000-0000-4000-8000-000000000010', 'finance/restricted_comp.txt', 'indexed', true, 'restricted', 'department')
ON CONFLICT (id) DO UPDATE SET status = 'indexed', is_published = true, classification = 'restricted', access_scope = 'department';

INSERT INTO public.documents (id, project_id, storage_path, status, is_published, classification, access_scope)
VALUES ('c0000000-0000-4000-8000-000000000300', 'c0000000-0000-4000-8000-000000000020', 'product/d12_playbook.pdf', 'indexed', true, 'standard', 'department')
ON CONFLICT (id) DO UPDATE SET status = 'indexed', is_published = true, classification = 'standard', access_scope = 'department';

-- 6. Document Chunks
DELETE FROM public.document_chunks WHERE id IN (
  'c0000000-0000-4000-8000-000000001001',
  'c0000000-0000-4000-8000-000000002001',
  'c0000000-0000-4000-8000-000000003001'
);

INSERT INTO public.document_chunks (id, document_id, project_id, content, metadata, embedding)
VALUES
  ('c0000000-0000-4000-8000-000000001001', 'c0000000-0000-4000-8000-000000000100', 'c0000000-0000-4000-8000-000000000010',
   $sop$${sopText}$sop$, '{"filename": "D04_Engineering_Code_Review_SOP.html"}'::jsonb, '[${sopEmbed.join(',')}]'::vector),

  ('c0000000-0000-4000-8000-000000002001', 'c0000000-0000-4000-8000-000000000200', 'c0000000-0000-4000-8000-000000000010',
   $res$${restrictedText}$res$, '{"filename": "D03_Confidential_Compensation_Procedure.txt"}'::jsonb, '[${restrictedEmbed.join(',')}]'::vector),

  ('c0000000-0000-4000-8000-000000003001', 'c0000000-0000-4000-8000-000000000300', 'c0000000-0000-4000-8000-000000000020',
   $d12$${d12Text}$d12$, '{"filename": "D12_Cross_Functional_Product_Launch_Playbook.pdf"}'::jsonb, '[${d12Embed.join(',')}]'::vector);

COMMIT;
`;

  const scratchSqlPath = path.resolve(process.cwd(), 'scripts', 'wp5_fixtures.sql');
  fs.writeFileSync(scratchSqlPath, sql, 'utf-8');
  console.log('Wrote SQL to', scratchSqlPath);

  console.log('Applying fixtures to cpowlkptvtnkjkulveph via psql...');
  const env = {
    ...process.env,
    PGPASSWORD: pgPassword,
  };
  const psqlArgs = [
    'host=aws-1-ap-northeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.cpowlkptvtnkjkulveph sslmode=verify-full sslrootcert=C:/Users/User/Downloads/prod-ca-2021.crt connect_timeout=15',
    '-f', scratchSqlPath
  ];

  const psqlPath = 'C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe';
  const out = execFileSync(psqlPath, psqlArgs, { env, encoding: 'utf-8' });
  console.log('psql output:', out);
  console.log('Fixtures seeded successfully!');
}

main().catch(err => {
  console.error('Seeding error:', err);
  process.exit(1);
});
