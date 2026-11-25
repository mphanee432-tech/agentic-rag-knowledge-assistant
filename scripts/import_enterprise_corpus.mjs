/**
 * One-time DeccanBridge Software D01-D12 portfolio corpus import.
 * Uses source Supabase read-only operations and destination service-role writes.
 * Usage (Windows CMD, from the NEW agentic repository):
 *   node --env-file=.env.local --env-file=.env.migration.local scripts/import_enterprise_corpus.mjs
 *   node --env-file=.env.local --env-file=.env.migration.local scripts/import_enterprise_corpus.mjs --apply
 *
 * Create .env.migration.local (gitignored) containing
 *   SOURCE_ENTERPRISE_SUPABASE_SERVICE_ROLE_KEY=<original v1 WP2A test project service_role key>
 * and configure ENTERPRISE_SUPABASE_SECRET_KEY or ENTERPRISE_SUPABASE_SERVICE_ROLE_KEY
 * in .env.local for the new destination project.
 * Neither document text nor keys are logged.
 */
import { createClient } from '@supabase/supabase-js';
import { randomUUID, createHash } from 'node:crypto';

const SOURCE_URL = 'https://cpowlkptvtnkjkulveph.supabase.co';
const DEST_URL = 'https://ldkxyleqfbovqpkpoyek.supabase.co';
const SOURCE_KEY = process.env.SOURCE_ENTERPRISE_SUPABASE_SERVICE_ROLE_KEY;
const DEST_KEY = process.env.ENTERPRISE_SUPABASE_SECRET_KEY ?? process.env.ENTERPRISE_SUPABASE_SERVICE_ROLE_KEY;
const DEST_CONFIGURED_URL = process.env.NEXT_PUBLIC_ENTERPRISE_SUPABASE_URL;
const APPLY = process.argv.includes('--apply');

if (!SOURCE_KEY || !DEST_KEY) {
  throw new Error('Missing source or destination server key. See comments at top of file; never paste keys into chat or code.');
}
if (DEST_CONFIGURED_URL !== DEST_URL) {
  throw new Error('Destination Supabase URL mismatch. Aborting to prevent cross-project writes.');
}
const client = (url, key) => createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
});
const source = client(SOURCE_URL, SOURCE_KEY);
const dest = client(DEST_URL, DEST_KEY);
const failOnError = (result, context) => {
  if (result.error) throw new Error(`${context}: ${result.error.message}`);
  return result.data;
};

// Only published indexed documents matching D01..D12 from the synthetic enterprise organization.
const documents = failOnError(await source.from('documents')
  .select('id,project_id,storage_path,status,is_published,classification,access_scope,projects!inner(id,name,organization_id,department_id,is_d12)')
  .eq('status', 'indexed').eq('is_published', true)
  .eq('projects.organization_id', 'c0000000-0000-4000-8000-000000000001'), 'Read source corpus');

const selected = new Map();
for (const doc of documents ?? []) {
  const filename = doc.storage_path.split('/').at(-1);
  const match = /^D(0[1-9]|1[0-2])_/.exec(filename ?? '');
  if (!match) continue;
  const id = `D${match[1]}`;
  if (selected.has(id)) throw new Error(`Multiple published policies found for ${id}. Resolve ambiguity before import.`);
  selected.set(id, { ...doc, code: id, filename });
}
const expected = Array.from({ length: 12 }, (_, i) => `D${String(i + 1).padStart(2, '0')}`);
const missing = expected.filter(code => !selected.has(code));
if (missing.length) throw new Error(`Published policy file(s) absent from source: ${missing.join(', ')}. No changes made.`);

// Prevent accidental import into a differently seeded organization.
const org = failOnError(await dest.from('organizations').select('id,name')
  .eq('id', 'c0000000-0000-4000-8000-000000000001').single(), 'Check destination organization');
if (org.name !== 'DeccanBridge Software') throw new Error('Destination organization mismatch.');
const targetProjects = failOnError(await dest.from('projects').select('id,organization_id,department_id,is_d12')
  .eq('organization_id', org.id), 'Check destination projects');
const projectsById = new Map(targetProjects.map(p => [p.id, p]));
for (const code of expected) {
  const doc = selected.get(code);
  const target = projectsById.get(doc.project_id);
  if (!target || target.department_id !== doc.projects.department_id || target.is_d12 !== doc.projects.is_d12)
    throw new Error(`Missing/inconsistent destination project for ${code}; aborting.`);
}
console.log(`Validated ${expected.length} published policies (${expected.join(', ')}) and matching destination departments.`);
const destDocs = failOnError(await dest.from('documents').select('id,storage_path').limit(1000), 'Check existing destination documents');
if (destDocs.length > 0) throw new Error('Destination enterprise documents table is not empty; aborting to prevent duplicates or overwrites.');
if (!APPLY) {
  console.log('DRY RUN ONLY: no files or database records changed. Re-run with --apply to import.');
  process.exit(0);
}

for (const code of expected) {
  const doc = selected.get(code);
  // One policy at a time. Fail closed if source download or indexed chunks are incomplete.
  const blob = failOnError(await source.storage.from('documents').download(doc.storage_path), `Download ${code}`);
  const fileBytes = new Uint8Array(await blob.arrayBuffer());
  if (!fileBytes.length || fileBytes.length > 25 * 1024 * 1024) throw new Error(`${code}: invalid size`);
  const sourceChunks = [];
  for (let start = 0; ; start += 200) {
    const rows = failOnError(await source.from('document_chunks')
      .select('content,metadata,embedding').eq('document_id', doc.id)
      .order('id', { ascending: true }).range(start, start + 199), `Read ${code} chunks`);
    sourceChunks.push(...rows);
    if (rows.length < 200) break;
  }
  if (!sourceChunks.length) throw new Error(`${code}: no indexed chunks; not importing.`);
  const id = randomUUID();
  const path = `enterprise/${doc.project_id}/${id}/${doc.filename}`;
  const contentType = doc.filename.endsWith('.pdf') ? 'application/pdf'
    : doc.filename.endsWith('.html') ? 'text/html' : 'text/plain';
  failOnError(await dest.storage.from('documents').upload(path, fileBytes,
    { contentType, upsert: false }), `Upload ${code}`);
  // Existing bytes are identical. Destination record and embeddings use a new UUID but preserve corpus content.
  try {
    failOnError(await dest.from('documents').insert({
      id, project_id: doc.project_id, storage_path: path,
      status: 'uploaded', expected_size: fileBytes.byteLength,
      classification: doc.classification, access_scope: doc.access_scope,
      is_published: false
    }), `Reserve ${code}`);
    for (let start = 0; start < sourceChunks.length; start += 50) {
      const rows = sourceChunks.slice(start, start + 50).map(c => ({
        document_id: id, project_id: doc.project_id,
        content: c.content, metadata: c.metadata ?? {}, embedding: c.embedding
      }));
      failOnError(await dest.from('document_chunks').insert(rows), `Copy ${code} indexed chunks`);
    }
    failOnError(await dest.from('documents').update({ status: 'indexed', is_published: true })
      .eq('id', id).eq('status', 'uploaded'), `Publish ${code}`);
    console.log(`${code}: imported original file + ${sourceChunks.length} indexed chunks (${fileBytes.byteLength} bytes, SHA256 ${createHash('sha256').update(fileBytes).digest('hex').slice(0,12)})`);
  } catch (error) {
    console.error(`${code}: partial import possible. Do not blindly rerun; inspect destination records and clean up partial state first.`);
    throw error;
  }
}
console.log('All 12 source policies imported. Verify permissions with separate employee accounts before enabling chat.');
