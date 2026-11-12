// Real local Auth -> Next.js HTTP -> PostgREST -> PostgreSQL integration; no mocked boundaries.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createBrowserClient, createChunks, combineChunks } from '@supabase/ssr';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const runtime = path.join(directory, 'runtime');
const project = 'rag-baseline-20261107-01a1b3be';
const docker = 'C:/Users/User/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe';
const engine = 'npipe:////./pipe/dockerDesktopLinuxEngine';
const apiUrl = 'http://127.0.0.1:57431';
const evidence = { cases: [], connectivity: [], fixtures: [], cleanup: {}, status: 'BLOCKED' };
const evidenceFile = path.join(runtime, 'g5-http-results.json');
const save = () => fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
function localDocker(args, input) {
  return execFileSync(docker, ['--host', engine, ...args],
    { input, encoding: 'utf8', timeout: 30000, windowsHide: true });
}
function sql(query) {
  const result = localDocker(['exec', '-i', '--user', 'postgres', `supabase_db_${project}`,
    'psql', '-X', '-qAt', '-h', '127.0.0.1', '-U', 'supabase_admin', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1'], query);
  return result.trim();
}
const quoteId = value => { assert.match(value, /^[0-9a-f-]{36}$/i); return `'${value}'`; };
function snapshot() {
  return JSON.parse(sql(`select jsonb_build_object(
    'projects',(select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]'::jsonb) from public.projects p),
    'interactions',(select coalesce(jsonb_agg(to_jsonb(i) order by id),'[]'::jsonb) from public.interactions i));`));
}
const clients = [];
const cookies = new Map();
let admin;
let server;
let port;
let logFile;
let mirror;
let fixturesWritten = false;
try {
  execFileSync('pwsh.exe', ['-NoProfile', '-File', path.join(directory, 's1-p3.ps1'), '-Action', 'Verify'],
    { stdio: 'pipe', timeout: 60000, windowsHide: true });
  assert.equal(sql('select system_identifier::text from pg_control_system();'), '7705292890393960481');
  assert.equal(sql('show server_version;'), '17.11');
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261107054356_s1_p3_interactions_owner_policies.sql'));
  assert.equal(createHash('sha256').update(migration).digest('hex'), '01a702832d8845f2945e2f9342a7045c902af5639c08989a4f898dc91489b350');
  const gateway = localDocker(['exec', `supabase_kong_${project}`, 'cat', '/home/kong/kong.yml']);
  const tokens = [...new Set(gateway.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g))];
  const localKey = role => {
    const token = tokens.find(value => JSON.parse(Buffer.from(value.split('.')[1], 'base64url')).role === role);
    assert.ok(token, `Missing local ${role} credential`);
    return token;
  };
  const anon = localKey('anon');
  const localFetch = (input, init = {}) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(target.origin, apiUrl, 'Refusing non-local Supabase endpoint');
    return fetch(input, { ...init, signal: AbortSignal.timeout(30000) });
  };
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: 57431 }, () => { socket.destroy(); resolve(); });
    socket.setTimeout(5000, () => socket.destroy(new Error('Local TCP timeout')));
    socket.on('error', reject);
  });
  evidence.connectivity.push({ layer: 'TCP', target: '127.0.0.1:57431', result: 'PASSED' });
  evidence.proxyVariableNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY'].filter(name => !!process.env[name]);
  for (let index = 0; index < 3; index++) {
    for (const endpoint of ['/auth/v1/health', '/rest/v1/']) {
      const response = await localFetch(apiUrl + endpoint, { headers: { apikey: anon } });
      assert.equal(response.status, 200);
      await response.text();
      evidence.connectivity.push({ endpoint, attempt: index + 1, status: response.status });
    }
  }
  const settingsResponse = await localFetch(`${apiUrl}/auth/v1/settings`, { headers: { apikey: anon } });
  assert.equal(settingsResponse.status, 200);
  assert.equal((await settingsResponse.json()).external.email, true);
  console.log('PASSED: repeated native fetch Auth/PostgREST connectivity and enabled local email provider');
  admin = createClient(apiUrl, localKey('service_role'), {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: localFetch },
  });
  for (const actor of ['A', 'B']) {
    const email = `g5-${actor.toLowerCase()}-${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString('base64url');
    const fixture = { actor, email, projectId: randomUUID(), interactionId: randomUUID() };
    evidence.fixtures.push(fixture);
    save();
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    assert.ok(!created.error, `Local Auth admin createUser failed: ${created.error?.status} ${created.error?.code}`);
    fixture.userId = created.data.user.id;
    save();
    const jar = new Map();
    const client = createBrowserClient(apiUrl, anon, { isSingleton: false,
      cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: items => items.forEach(({ name, value }) => value ? jar.set(name, value) : jar.delete(name)) },
      global: { fetch: localFetch },
    });
    clients.push(client);
    const signedIn = await client.auth.signInWithPassword({ email, password });
    assert.ok(!signedIn.error && signedIn.data.session, `Password sign-in failed: ${signedIn.error?.status} ${signedIn.error?.code}`);
    const verified = await client.auth.getUser();
    assert.equal(verified.error, null);
    assert.equal(verified.data.user.id, fixture.userId);
    assert.equal(signedIn.data.session.user.role, 'authenticated');
    assert.ok(jar.size > 0, 'SSR SDK did not create real session cookies');
    fixture.cookieNames = [...jar.keys()];
    fixture.authVerified = true;
    cookies.set(actor, [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
    console.log(`PASSED: real password sign-in, SSR session cookies and Auth getUser for ${actor}`);
  }
  const [a, b] = evidence.fixtures;
  const insert = evidence.fixtures.map(fixture => `
    insert into public.projects(id,user_id,name) values(${quoteId(fixture.projectId)},${quoteId(fixture.userId)},'G5 synthetic ${fixture.actor}');
    insert into public.interactions(id,project_id,user_id,query_text,response_markdown,latency_ms)
      values(${quoteId(fixture.interactionId)},${quoteId(fixture.projectId)},${quoteId(fixture.userId)},'Synthetic G5','Synthetic response',1);`).join('\n');
  sql(`begin; ${insert} commit;`);
  fixturesWritten = true;
  assert.equal(snapshot().interactions.length, 2);

  // Mirror the unmodified application so Next's generated files cannot touch the working app.
  mirror = path.join(runtime, `g5-next-${Date.now()}`);
  fs.mkdirSync(mirror);
  for (const name of ['app', 'components', 'lib']) fs.cpSync(path.join(root, name), path.join(mirror, name), { recursive: true });
  for (const name of ['package.json', 'tsconfig.json', 'next.config.ts', 'proxy.ts', 'next-env.d.ts']) {
    if (fs.existsSync(path.join(root, name))) fs.copyFileSync(path.join(root, name), path.join(mirror, name));
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(mirror, 'node_modules'), 'junction');
  const protectedPaths = ['app/api/feedback/route.ts', 'lib/auth.ts', 'lib/supabase/server.ts', 'proxy.ts'];
  for (const filename of protectedPaths) assert.deepEqual(fs.readFileSync(path.join(root, filename)), fs.readFileSync(path.join(mirror, filename)));
  assert.ok(!fs.readdirSync(mirror).some(name => name.startsWith('.env')));
  const portProbe = net.createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const cleanEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC']) {
    if (process.env[name]) cleanEnv[name] = process.env[name];
  }
  Object.assign(cleanEnv, { NEXT_PUBLIC_SUPABASE_URL: apiUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: anon,
    NEXT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', NODE_ENV: 'development' });
  const require = createRequire(import.meta.url);
  logFile = fs.openSync(path.join(runtime, 'g5-next.log'), 'w');
  server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', mirror, '--webpack', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: mirror, env: cleanEnv, stdio: ['ignore', logFile, logFile], windowsHide: true });
  evidence.server = { pid: server.pid, hostname: '127.0.0.1', port, mirror, environment: 'OS allowlist + local anonymous key only', protectedMirrorVerified: true };
  save();
  let ready = false;
  for (let attempt = 0; attempt < 240; attempt++) {
    assert.equal(server.exitCode, null, 'Temporary Next.js process exited before readiness');
    const contents = fs.readFileSync(path.join(runtime, 'g5-next.log'), 'utf8');
    if (/Ready in/.test(contents)) { ready = true; break; }
    if (attempt > 0 && attempt % 30 === 0) console.log(`Waiting for temporary Next.js startup (${attempt}s)`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(ready, 'Temporary Next.js server readiness timeout');
  console.log('PASSED: separate localhost-only Next.js server ready with local-only configuration');
  const valid = { rating: 'thumbs_up', issueTag: 'g5', comment: 'Synthetic feedback A' };
  async function check(id, cookie, body, expectedStatus, target) {
    const before = snapshot();
    const response = await fetch(`http://127.0.0.1:${port}/api/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(300000),
    });
    const result = { id, status: response.status, body: await response.json(), result: 'FAILED' };
    evidence.cases.push(result);
    save();
    try {
      assert.equal(response.status, expectedStatus);
      const after = snapshot();
      if (expectedStatus === 200) {
        assert.deepEqual(Object.keys(result.body).sort(), ['feedback', 'success']);
        assert.equal(result.body.success, true);
        const feedback = result.body.feedback;
        assert.equal(feedback.rating, body.rating);
        assert.equal(feedback.issue_tag, body.issueTag || null);
        assert.equal(feedback.comment, body.comment || null);
        assert.ok(!Number.isNaN(Date.parse(feedback.updated_at)));
        const expected = structuredClone(before);
        const row = expected.interactions.find(value => value.id === target.interactionId);
        assert.ok(row);
        row.feedback = feedback;
        assert.deepEqual(after, expected);
      } else {
        assert.equal(typeof result.body.error, 'string');
        assert.equal(result.body.success, undefined);
        assert.deepEqual(after, before);
      }
      result.result = 'PASSED';
      result.persistence = 'Full snapshot matched expected feedback-only update or zero mutation';
    } catch (error) { result.failure = error.message; }
    save();
    console.log(`${result.result}: ${id} HTTP ${response.status}`);
  }
  await check('G5-H01', cookies.get('A'), { interactionId: a.interactionId, ...valid }, 200, a);
  await check('G5-H02', cookies.get('B'), { interactionId: b.interactionId, rating: 'thumbs_down', comment: 'Synthetic feedback B' }, 200, b);
  await check('G5-H03', cookies.get('A'), { interactionId: b.interactionId, ...valid }, 404);
  await check('G5-H04', cookies.get('B'), { interactionId: a.interactionId, ...valid }, 404);
  await check('G5-H05', null, { interactionId: a.interactionId, ...valid }, 401);
  const cookieParts = cookies.get('A').split('; ').map(part => { const split = part.indexOf('='); return [part.slice(0, split), part.slice(split + 1)]; });
  const cookieMap = new Map(cookieParts);
  const storageKey = cookieParts[0][0].replace(/\.\d+$/, '');
  const encoded = await combineChunks(storageKey, name => cookieMap.get(name));
  assert.ok(encoded.startsWith('base64-'));
  const invalid = JSON.parse(Buffer.from(encoded.slice(7), 'base64url').toString());
  invalid.access_token = `${invalid.access_token.slice(0, -8)}invalidX`;
  invalid.refresh_token = 'invalid-local-test-refresh-token';
  const invalidCookies = createChunks(storageKey, `base64-${Buffer.from(JSON.stringify(invalid)).toString('base64url')}`)
    .map(({ name, value }) => `${name}=${value}`).join('; ');
  await check('G5-H06', invalidCookies, { interactionId: a.interactionId, ...valid }, 401);
  await check('G5-H07-nonexistent', cookies.get('A'), { interactionId: randomUUID(), ...valid }, 404);
  await check('G5-H07-invalid-type', cookies.get('A'), { interactionId: 42, ...valid }, 400);
  for (const [label, override] of [['rating', { rating: 'invalid' }], ['comment-length', { comment: 'x'.repeat(2001) }],
    ['issue-tag-length', { issueTag: 'x'.repeat(101) }], ['comment-type', { comment: 42 }], ['issue-tag-type', { issueTag: 42 }]]) {
    await check(`G5-H08-${label}`, cookies.get('A'), { interactionId: a.interactionId, ...valid, ...override }, 400);
  }
  await check('G5-H09', cookies.get('A'), { interactionId: a.interactionId, rating: 'thumbs_down', issueTag: 'replacement', comment: 'Replacement feedback A' }, 200, a);
  assert.equal(snapshot().interactions.length, 2);
  evidence.cases.push({ id: 'G5-H10', result: evidence.cases.every(value => value.result === 'PASSED') ? 'PASSED' : 'FAILED',
    detail: 'Each HTTP response compared with a full projects/interactions database snapshot; two interaction rows retained' });
  evidence.status = evidence.cases.every(value => value.result === 'PASSED') ? 'PASSED' : 'FAILED';
} catch (error) {
  evidence.error = { name: error.name, message: error.message };
  console.error('BLOCKED: local integration dependency or setup failure; see ignored evidence');
  process.exitCode = 1;
} finally {
  for (const client of clients) {
    const result = await client.auth.signOut({ scope: 'global' }).catch(() => ({ error: true }));
    if (result.error) evidence.cleanup.signOutError = true;
  }
  if (fixturesWritten) {
    sql(`begin; delete from public.interactions where id in (${evidence.fixtures.map(value => quoteId(value.interactionId)).join(',')});
      delete from public.projects where id in (${evidence.fixtures.map(value => quoteId(value.projectId)).join(',')}); commit;`);
  }
  if (admin) {
    const listed = await admin.auth.admin.listUsers();
    assert.equal(listed.error, null, 'Cannot inspect fixture cleanup');
    for (const fixture of evidence.fixtures) {
      const user = listed.data.users.find(value => value.email === fixture.email);
      if (user) {
        const removed = await admin.auth.admin.deleteUser(user.id);
        assert.equal(removed.error, null, 'Synthetic Auth user cleanup failed');
      }
    }
  }
  if (server && server.exitCode === null) {
    execFileSync('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'pipe', windowsHide: true });
    evidence.cleanup.nextProcessStopped = true;
  }
  if (logFile !== undefined) fs.closeSync(logFile);
  if (mirror) {
    const resolved = fs.realpathSync(mirror);
    assert.equal(path.dirname(resolved), fs.realpathSync(runtime), 'Refusing cleanup outside local runtime');
    assert.match(path.basename(resolved), /^g5-next-\d+$/);
    fs.unlinkSync(path.join(resolved, 'node_modules'));
    fs.rmSync(resolved, { recursive: true });
    evidence.cleanup.mirrorRemoved = true;
  }
  evidence.cleanup.database = JSON.parse(sql(`select jsonb_build_object(
    'users',(select count(*) from auth.users),'sessions',(select count(*) from auth.sessions),
    'refresh_tokens',(select count(*) from auth.refresh_tokens),'projects',(select count(*) from public.projects),
    'interactions',(select count(*) from public.interactions),'cron',current_setting('cron.launch_active_jobs'),
    'pg_net_workers',(select count(*) from pg_stat_activity where backend_type like 'pg_net%'),
    'http_queue',(select count(*) from net.http_request_queue),'http_responses',(select count(*) from net._http_response));`));
  save();
  for (const [name, count] of Object.entries(evidence.cleanup.database)) {
    assert.equal(count, name === 'cron' ? 'off' : 0, `Cleanup/isolation check failed: ${name}`);
  }
  execFileSync('pwsh.exe', ['-NoProfile', '-File', path.join(directory, 's1-p3.ps1'), '-Action', 'Verify'],
    { stdio: 'pipe', timeout: 60000, windowsHide: true });
  console.log(`G5 ${evidence.status}; local fixture cleanup and unchanged hardened catalog verified`);
  if (evidence.status !== 'PASSED') process.exitCode = 1;
}
