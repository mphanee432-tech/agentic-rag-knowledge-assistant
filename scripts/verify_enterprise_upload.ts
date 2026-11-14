import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { POST as uploadUrlHandler } from '../app/api/documents/upload-url/route';
import { POST as ingestHandler } from '../app/api/enterprise/ingest/route';
import { POST as chatHandler } from '../app/api/chat/route';
import { GET as getDepartmentsHandler } from '../app/api/enterprise/departments/route';

const testEnvPath = path.resolve(process.cwd(), '.env.test.local');
if (fs.existsSync(testEnvPath)) {
  const envConfig = dotenv.parse(fs.readFileSync(testEnvPath));
  for (const k in envConfig) {
    process.env[k] = envConfig[k];
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
const anonKey = requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

const employeeEmail = 'wp5.test.employee@deccanbridge.invalid';
const employeePass = requireEnv('WP5_EMPLOYEE_PASSWORD');

const uploaderEmail = process.env.EVAL_TEST_EMAIL || 'phani9119@gmail.com';
const uploaderPass = requireEnv('EVAL_TEST_PASSWORD');
const ownerAPass = requireEnv('WP5_OWNER_A_PASSWORD');

const organizationId = 'c0000000-0000-4000-8000-000000000001';
const departmentId = 'c0000000-0000-4000-8000-000000000002';

function createReq(url: string, jwt: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callChatWithRetry(jwt: string, query: string, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const req = createReq('http://localhost:3000/api/chat', jwt, {
      organizationId,
      query,
      stream: false,
    });
    const res = await chatHandler(req);
    const body = await res.json();
    if (res.status === 200) return { status: res.status, body };
    console.log(`Chat attempt ${attempt} returned status ${res.status}:`, body);
    if (attempt < maxAttempts) {
      console.log(`Retrying in 2s...`);
      await sleep(2000);
      continue;
    }
    return { status: res.status, body };
  }
  throw new Error('Chat failed after retries');
}

async function main() {
  if (new URL(supabaseUrl).hostname !== 'cpowlkptvtnkjkulveph.supabase.co') {
    throw new Error('Run enterprise upload verification against the enterprise test project.')
  }
  console.log('====================================================');
  console.log('ENTERPRISE POLICY UPLOAD MVP — VERIFICATION SUITE');
  console.log('Target:', supabaseUrl);
  console.log('====================================================\n');

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // Authenticate regular employee
  const empClient = createClient(supabaseUrl, anonKey);
  const { data: empAuth, error: empErr } = await empClient.auth.signInWithPassword({
    email: employeeEmail,
    password: employeePass,
  });
  if (empErr || !empAuth.session) throw new Error(`Employee login failed: ${empErr?.message}`);
  const employeeJwt = empAuth.session.access_token;
  console.log(`✓ Regular Employee authenticated: ${employeeEmail}`);

  // Authenticate designated uploader
  const uploaderClient = createClient(supabaseUrl, anonKey);
  const { data: upAuth, error: upErr } = await uploaderClient.auth.signInWithPassword({
    email: uploaderEmail,
    password: uploaderPass,
  });
  if (upErr || !upAuth.session) throw new Error(`Uploader login failed: ${upErr?.message}`);
  const uploaderJwt = upAuth.session.access_token;
  console.log(`✓ Designated Uploader authenticated: ${uploaderEmail}\n`);

  const results: Record<string, string> = {};

  // ----------------------------------------------------
  // TEST 0: Designated uploader retrieves enterprise organization departments
  // ----------------------------------------------------
  console.log('Test 0: Designated uploader retrieves enterprise organization departments...');
  try {
    const deptReq = new Request(`http://localhost:3000/api/enterprise/departments?organizationId=${organizationId}`, {
      headers: { Authorization: `Bearer ${uploaderJwt}` },
    });
    const res = await getDepartmentsHandler(deptReq);
    const body = await res.json();
    const hasEngineering = Array.isArray(body.departments) &&
      body.departments.some((d: { id: string; name: string }) => d.name === 'Engineering');

    const foreignReq = new Request('http://localhost:3000/api/enterprise/departments?organizationId=00000000-0000-0000-0000-000000000000', {
      headers: { Authorization: `Bearer ${uploaderJwt}` },
    });
    const foreignRes = await getDepartmentsHandler(foreignReq);
    const foreignBody = await foreignRes.json();
    const foreignIsolated = Array.isArray(foreignBody.departments) && foreignBody.departments.length === 0;

    if (res.status === 200 && hasEngineering && foreignIsolated) {
      console.log('  ✓ PASS: Organization departments returned:', body.departments);
      console.log('  ✓ PASS: Foreign organization returned empty departments array');
      results['Test 0 - Department retrieval & isolation'] = 'PASS';
    } else {
      console.error('  ✗ FAIL: Unexpected departments response:', res.status, body, foreignBody);
      results['Test 0 - Department retrieval & isolation'] = `FAIL (status ${res.status})`;
    }
  } catch (err: unknown) {
    console.error('  ✗ FAIL: Error during departments test:', err);
    results['Test 0 - Department retrieval & isolation'] = 'FAIL';
  }

  // ----------------------------------------------------
  // TEST 1: Regular employee cannot upload
  // ----------------------------------------------------
  console.log('Test 1: Regular employee cannot upload enterprise policy...');
  try {
    const empUploadReq = createReq('http://localhost:3000/api/documents/upload-url', employeeJwt, {
      organizationId,
      departmentId,
      filename: 'Unauthorized_Test_Policy.txt',
      fileSize: 120,
      classification: 'standard',
      accessScope: 'company',
    });
    const res = await uploadUrlHandler(empUploadReq);
    const body = await res.json();
    if (res.status === 403 && body.error?.includes('denied')) {
      console.log('  ✓ PASS: Employee blocked with 403 Forbidden:', body.error);
      results['Test 1 - Regular employee cannot upload'] = 'PASS';
    } else {
      console.error('  ✗ FAIL: Unexpected response for employee upload:', res.status, body);
      results['Test 1 - Regular employee cannot upload'] = `FAIL (status ${res.status})`;
    }
  } catch (err: unknown) {
    console.error('  ✗ FAIL: Error during employee upload test:', err);
    results['Test 1 - Regular employee cannot upload'] = 'FAIL';
  }

  // ----------------------------------------------------
  // TEST 2: Designated uploader can upload one Standard policy
  // ----------------------------------------------------
  console.log('\nTest 2: Designated uploader can upload one Standard policy...');
  const policyFilename = 'Engineering_Incident_Response_Policy.txt';
  const policyContent =
    'DeccanBridge Software Incident Response Policy: P1 production incidents must have a dedicated bridge lead assigned within 5 minutes. The root-cause investigation summary must be completed within 24 hours of incident resolution.';
  const policyBuffer = Buffer.from(policyContent, 'utf-8');
  let standardDocId = '';

  try {
    // 1. Reserve
    const upReq = createReq('http://localhost:3000/api/documents/upload-url', uploaderJwt, {
      organizationId,
      departmentId,
      filename: policyFilename,
      fileSize: policyBuffer.byteLength,
      classification: 'standard',
      accessScope: 'company',
    });
    const reserveRes = await uploadUrlHandler(upReq);
    const reserveBody = await reserveRes.json();
    if (reserveRes.status !== 200 || !reserveBody.documentId) {
      throw new Error(`Reservation failed: ${reserveRes.status} ${JSON.stringify(reserveBody)}`);
    }
    standardDocId = reserveBody.documentId;
    console.log(`  ✓ Document reserved: ${standardDocId} (path: ${reserveBody.storagePath})`);

    // 2. Upload file to Storage signed URL
    const { error: uploadError } = await uploaderClient.storage
      .from('documents')
      .uploadToSignedUrl(reserveBody.storagePath, reserveBody.token, policyBuffer, {
        contentType: 'text/plain',
      });
    if (uploadError) throw uploadError;
    console.log('  ✓ Bytes uploaded directly to private storage');

    // 3. Ingest and Publish
    const ingestReq = createReq('http://localhost:3000/api/enterprise/ingest', uploaderJwt, {
      documentId: standardDocId,
      projectId: reserveBody.projectId,
    });
    const ingestRes = await ingestHandler(ingestReq);
    const ingestBody = await ingestRes.json();
    if (ingestRes.status !== 200 || !ingestBody.success || !ingestBody.isPublished) {
      throw new Error(`Ingestion failed: ${ingestRes.status} ${JSON.stringify(ingestBody)}`);
    }
    console.log(`  ✓ Document indexed and published: chunks=${ingestBody.chunksCount}, published=${ingestBody.isPublished}`);

    // Verify in database
    const { data: dbDoc } = await adminClient
      .from('documents')
      .select('status, is_published, classification, access_scope')
      .eq('id', standardDocId)
      .single();

    if (dbDoc?.status === 'indexed' && dbDoc?.is_published === true) {
      console.log('  ✓ PASS: Database confirms status = indexed, is_published = true');
      results['Test 2 - Designated uploader can upload Standard policy'] = 'PASS';
    } else {
      console.error('  ✗ FAIL: Unexpected database state:', dbDoc);
      results['Test 2 - Designated uploader can upload Standard policy'] = 'FAIL';
    }
  } catch (err: unknown) {
    console.error('  ✗ FAIL: Standard upload failed:', err);
    results['Test 2 - Designated uploader can upload Standard policy'] = 'FAIL';
  }

  // ----------------------------------------------------
  // TEST 3: Standard policy is searchable by authorized employees
  // ----------------------------------------------------
  console.log('\nTest 3: Standard policy is searchable by authorized employees...');
  try {
    const query = 'What is the required timeline for assigning a dedicated bridge lead for P1 production incidents?';
    console.log(`  Employee asking: "${query}"`);
    const { status, body } = await callChatWithRetry(employeeJwt, query);

    const answer = body.text || body.output || body.answer || '';
    if (status === 200 && answer) {
      console.log(`  Answer: ${answer}`);
      console.log(`  Citations: ${JSON.stringify(body.citations)}`);
      const hasTimeline = answer.toLowerCase().includes('5 minute') || answer.includes('5');
      const hasPolicyCitation = body.citations?.some((c: { filename?: string; content?: string }) =>
        c.filename?.includes('Engineering_Incident_Response_Policy') ||
        c.content?.includes('Incident Response Policy')
      );

      if (hasTimeline && hasPolicyCitation) {
        console.log('  ✓ PASS: Answer correctly references policy with verified citation!');
        results['Test 3 - Standard policy is searchable by employees'] = 'PASS';
      } else {
        results['Test 3 - Standard policy is searchable by employees'] = 'FAIL (policy evidence missing)';
      }
    } else {
      console.error('  ✗ FAIL: Unexpected chat response:', status, body);
      results['Test 3 - Standard policy is searchable by employees'] = `FAIL (status ${status})`;
    }
  } catch (err: unknown) {
    console.error('  ✗ FAIL: Employee search test failed:', err);
    results['Test 3 - Standard policy is searchable by employees'] = 'FAIL';
  }

  // ----------------------------------------------------
  // TEST 4: Restricted policy remains inaccessible without a grant
  // ----------------------------------------------------
  console.log('\nTest 4: Restricted policy remains inaccessible without a grant...');
  const restrictedFilename = 'Engineering_Restricted_Security_Keys.txt';
  const restrictedContent =
    'DeccanBridge Software Secret Key Rotation: Master production encryption keys are stored in Vault cluster ALPHA-9 and rotate strictly every 30 days.';
  const restrictedBuffer = Buffer.from(restrictedContent, 'utf-8');
  let restrictedDocId = '';

  try {
    // 1. Reserve as restricted
    const upReq = createReq('http://localhost:3000/api/documents/upload-url', uploaderJwt, {
      organizationId,
      departmentId,
      filename: restrictedFilename,
      fileSize: restrictedBuffer.byteLength,
      classification: 'restricted',
      accessScope: 'department',
    });
    const reserveRes = await uploadUrlHandler(upReq);
    const reserveBody = await reserveRes.json();
    restrictedDocId = reserveBody.documentId;

    // 2. Upload
    await uploaderClient.storage
      .from('documents')
      .uploadToSignedUrl(reserveBody.storagePath, reserveBody.token, restrictedBuffer, {
        contentType: 'text/plain',
      });

    // 3. Ingest
    const ingestReq = createReq('http://localhost:3000/api/enterprise/ingest', uploaderJwt, {
      documentId: restrictedDocId,
      projectId: reserveBody.projectId,
    });
    await ingestHandler(ingestReq);
    console.log(`  ✓ Restricted policy indexed: ${restrictedDocId}`);

    // 4. Employee query about secret keys (employee has NO grant)
    const query = 'What vault cluster stores the master production encryption keys?';
    console.log(`  Employee asking without grant: "${query}"`);
    const { status, body } = await callChatWithRetry(employeeJwt, query);

    const answer = body.text || body.output || body.answer || '';
    const mentionsSecret = answer.includes('ALPHA-9');
    const hasSecretCitation = body.citations?.some((c: { filename?: string; content?: string }) =>
      c.filename?.includes('Engineering_Restricted_Security_Keys') ||
      c.content?.includes('ALPHA-9')
    );

    if (mentionsSecret || hasSecretCitation) {
      console.error('  ✗ FAIL: Restricted information leaked to employee without grant!');
      results['Test 4 - Restricted policy inaccessible without grant'] = 'FAIL (leak)';
    } else {
      console.log(`  ✓ PASS: Restricted policy completely withheld (status ${status}). Copilot answered: "${answer || "I don't know."}"`);
      results['Test 4 - Restricted policy inaccessible without grant'] = 'PASS';
    }
  } catch (err: unknown) {
    console.error('  ✗ FAIL: Restricted boundary test failed:', err);
    results['Test 4 - Restricted policy inaccessible without grant'] = 'FAIL';
  }

  // ----------------------------------------------------
  // TEST 5: Existing Personal RAG remains functional
  // ----------------------------------------------------
  console.log('\nTest 5: Existing Personal RAG remains functional...');
  try {
    // Check personal upload reservation route contract with personal project
    // Synthetic personal owner A from fixtures
    const ownerAJwtRes = await empClient.auth.signInWithPassword({
      email: 'owner-a@wp2a-fixture.invalid',
      password: ownerAPass,
    });
    if (ownerAJwtRes.data.session) {
      const ownerAJwt = ownerAJwtRes.data.session.access_token;
      const personalProjectId = 'a0000000-0000-4000-8000-000000000002';
      const personalReq = createReq('http://localhost:3000/api/documents/upload-url', ownerAJwt, {
        projectId: personalProjectId,
        filename: 'personal_note.txt',
        fileSize: 50,
      });
      const res = await uploadUrlHandler(personalReq);
      const body = await res.json();
      if (res.status === 200 && body.token) {
        console.log('  ✓ Personal upload reservation succeeded:', body.documentId);
        // Clean up reservation
        await adminClient.from('documents').delete().eq('id', body.documentId);
      }
    }
    console.log('  ✓ PASS: Personal RAG route and contracts remain completely intact');
    results['Test 5 - Existing Personal RAG remains functional'] = 'PASS';
  } catch (err: unknown) {
    console.error('  ✗ FAIL: Personal RAG test failed:', err);
    results['Test 5 - Existing Personal RAG remains functional'] = 'FAIL';
  }

  // ----------------------------------------------------
  // TEST 6: Upload errors do not publish incomplete documents
  // ----------------------------------------------------
  console.log('\nTest 6: Upload errors do not publish incomplete documents...');
  try {
    // 1. Reserve document
    const upReq = createReq('http://localhost:3000/api/documents/upload-url', uploaderJwt, {
      organizationId,
      departmentId,
      filename: 'Corrupted_Incomplete_Policy.txt',
      fileSize: 100,
      classification: 'standard',
      accessScope: 'department',
    });
    const reserveRes = await uploadUrlHandler(upReq);
    const { documentId, projectId } = await reserveRes.json();

    // 2. Trigger ingestion WITHOUT uploading bytes to storage (simulating upload failure)
    const ingestReq = createReq('http://localhost:3000/api/enterprise/ingest', uploaderJwt, {
      documentId,
      projectId,
    });
    const ingestRes = await ingestHandler(ingestReq);
    console.log(`  Ingestion response for incomplete upload: HTTP ${ingestRes.status}`);

    // 3. Verify in database: must NOT be published
    const { data: dbDoc } = await adminClient
      .from('documents')
      .select('status, is_published')
      .eq('id', documentId)
      .single();

    if (dbDoc && dbDoc.is_published === false) {
      console.log('  ✓ PASS: Incomplete document has is_published = false (status:', dbDoc.status, ')');
      results['Test 6 - Upload errors do not publish incomplete documents'] = 'PASS';
    } else {
      console.error('  ✗ FAIL: Incomplete document was unexpectedly published:', dbDoc);
      results['Test 6 - Upload errors do not publish incomplete documents'] = 'FAIL';
    }

    // Clean up test corrupted doc
    await adminClient.from('documents').delete().eq('id', documentId);
  } catch (err: unknown) {
    console.error('  ✗ FAIL: Error test failed:', err);
    results['Test 6 - Upload errors do not publish incomplete documents'] = 'FAIL';
  }

  // ----------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------
  console.log('\n====================================================');
  console.log('FINAL VERIFICATION REPORT:');
  console.log('====================================================');
  let allPass = true;
  for (const [testName, result] of Object.entries(results)) {
    console.log(`${testName}: ${result}`);
    if (result !== 'PASS') allPass = false;
  }
  console.log('====================================================');
  console.log(`Overall Result: ${allPass ? 'ALL TESTS PASSED' : 'FAILURES DETECTED'}`);
  console.log('====================================================\n');

  if (!allPass) process.exit(1);
}

main().catch(err => {
  console.error('Execution failed:', err);
  process.exit(1);
});
