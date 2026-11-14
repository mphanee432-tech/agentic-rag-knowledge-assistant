import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

const testEnvPath = path.resolve(process.cwd(), '.env.test.local');
if (fs.existsSync(testEnvPath)) {
  const envConfig = dotenv.parse(fs.readFileSync(testEnvPath));
  for (const k in envConfig) {
    process.env[k] = envConfig[k];
  }
} else {
  throw new Error('Missing .env.test.local configuration');
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const uploaderEmail = process.env.EVAL_TEST_EMAIL || 'phani9119@gmail.com';
const uploaderPassword = requireEnv('EVAL_TEST_PASSWORD');
const pgPassword = requireEnv('PGPASSWORD');

if (!supabaseUrl.includes('cpowlkptvtnkjkulveph')) {
  throw new Error(`SAFETY ERROR: Expected test project cpowlkptvtnkjkulveph, got ${supabaseUrl}`);
}

async function main() {
  console.log('Target project verified:', supabaseUrl);
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Find or create the uploader user in auth.users
  const { data: userList, error: listErr } = await adminClient.auth.admin.listUsers();
  if (listErr) throw listErr;

  let uploaderUser = userList.users.find(u => u.email === uploaderEmail);
  if (!uploaderUser) {
    console.log(`Creating auth user for ${uploaderEmail}...`);
    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email: uploaderEmail,
      password: uploaderPassword,
      email_confirm: true,
    });
    if (createErr) throw createErr;
    uploaderUser = created.user;
    console.log(`User created with UID: ${uploaderUser.id}`);
  } else {
    console.log(`Existing user found with UID: ${uploaderUser.id}`);
  }

  const uploaderUid = uploaderUser.id;

  // 2. Prepare SQL for manager assignment and functions
  const sql = `
BEGIN;

-- 1. Ensure uploader is an active manager in DeccanBridge Software Engineering
INSERT INTO public.organization_employees (organization_id, user_id, department_id, role, is_active)
VALUES (
  'c0000000-0000-4000-8000-000000000001',
  '${uploaderUid}',
  'c0000000-0000-4000-8000-000000000002',
  'manager',
  true
)
ON CONFLICT (organization_id, user_id)
DO UPDATE SET
  department_id = EXCLUDED.department_id,
  role = 'manager',
  is_active = true;

-- 2. Authorization check function
CREATE OR REPLACE FUNCTION public.can_upload_enterprise_policy(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    JOIN public.organization_employees e
      ON e.organization_id = p.organization_id
      AND e.user_id = (SELECT auth.uid())
      AND e.is_active = true
      AND e.role IN ('manager', 'cxo')
    JOIN auth.users u
      ON u.id = e.user_id
    WHERE p.id = p_project_id
      AND p.organization_id IS NOT NULL
      AND u.email = '${uploaderEmail}'
  );
$$;

REVOKE ALL ON FUNCTION public.can_upload_enterprise_policy(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.can_upload_enterprise_policy(uuid) TO authenticated, service_role;

-- 3. Document reservation function
CREATE OR REPLACE FUNCTION public.reserve_enterprise_document(
  p_project_id uuid,
  p_document_id uuid,
  p_storage_path text,
  p_expected_size bigint,
  p_classification text,
  p_access_scope text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_doc_id uuid;
BEGIN
  IF NOT public.can_upload_enterprise_policy(p_project_id) THEN
    RAISE EXCEPTION 'Enterprise upload authorization denied' USING errcode = '42501';
  END IF;

  IF p_classification NOT IN ('standard', 'restricted') THEN
    RAISE EXCEPTION 'Invalid classification: must be standard or restricted' USING errcode = '22023';
  END IF;

  IF p_classification = 'restricted' AND p_access_scope <> 'department' THEN
    RAISE EXCEPTION 'Restricted documents cannot have company-wide access scope' USING errcode = '22023';
  END IF;

  IF p_access_scope NOT IN ('department', 'company') THEN
    RAISE EXCEPTION 'Invalid access scope: must be department or company' USING errcode = '22023';
  END IF;

  INSERT INTO public.documents (
    id,
    project_id,
    storage_path,
    status,
    expected_size,
    is_published,
    classification,
    access_scope
  )
  VALUES (
    p_document_id,
    p_project_id,
    p_storage_path,
    'pending_upload',
    p_expected_size,
    false, -- Default to unpublished
    p_classification,
    p_access_scope
  )
  RETURNING id INTO v_doc_id;

  RETURN v_doc_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_enterprise_document(uuid, uuid, text, bigint, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reserve_enterprise_document(uuid, uuid, text, bigint, text, text) TO authenticated, service_role;

-- 4. Document publication function (enforces status = indexed and chunk existence)
CREATE OR REPLACE FUNCTION public.publish_enterprise_document(p_document_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_doc record;
BEGIN
  SELECT d.id, d.project_id, d.status
  INTO v_doc
  FROM public.documents d
  WHERE d.id = p_document_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document not found' USING errcode = 'P0002';
  END IF;

  IF NOT public.can_upload_enterprise_policy(v_doc.project_id) THEN
    RAISE EXCEPTION 'Enterprise publish authorization denied' USING errcode = '42501';
  END IF;

  IF v_doc.status <> 'indexed' THEN
    RAISE EXCEPTION 'Cannot publish incomplete or non-indexed document' USING errcode = '55000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.document_chunks WHERE document_id = p_document_id) THEN
    RAISE EXCEPTION 'Cannot publish document with zero indexed chunks' USING errcode = '55000';
  END IF;

  UPDATE public.documents
  SET is_published = true
  WHERE id = p_document_id;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_enterprise_document(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.publish_enterprise_document(uuid) TO authenticated, service_role;

COMMIT;
`;

  const scratchSqlPath = path.resolve(process.cwd(), 'scripts', 'enterprise_upload_schema.sql');
  fs.writeFileSync(scratchSqlPath, sql, 'utf-8');
  console.log('SQL saved to', scratchSqlPath);

  console.log('Applying SQL to cpowlkptvtnkjkulveph...');
  const env = {
    ...process.env,
    PGPASSWORD: pgPassword,
  };
  const psqlArgs = [
    '-h', 'aws-1-ap-northeast-1.pooler.supabase.com',
    '-p', '5432',
    '-d', 'postgres',
    '-U', 'postgres.cpowlkptvtnkjkulveph',
    '-f', scratchSqlPath
  ];

  const psqlPath = 'C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe';
  const out = execFileSync(psqlPath, psqlArgs, { env, encoding: 'utf-8' });
  console.log('psql output:', out);
  console.log('Setup successfully completed!');
}

main().catch(err => {
  console.error('Setup error:', err);
  process.exit(1);
});

