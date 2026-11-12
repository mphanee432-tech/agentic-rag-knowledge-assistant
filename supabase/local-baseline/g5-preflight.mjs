// Read-only G5 diagnostics; never starts services, creates fixtures, or reads app credentials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));

const docker = 'C:/Users/User/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe';
const engine = 'npipe:////./pipe/dockerDesktopLinuxEngine';
const project = 'rag-baseline-20261107-01a1b3be';
const networkName = `${project}-internal`;
const db = `supabase_db_${project}`;
const runtime = path.join(directory, 'runtime');
function localDocker(args, input) {
  return execFileSync(docker, ['--host', engine, ...args], {
    input, encoding: 'utf8', timeout: 20000, windowsHide: true,
  });
}
function inspect(name) { return JSON.parse(localDocker(['inspect', name]))[0]; }
const network = JSON.parse(localDocker(['network', 'inspect', networkName]))[0];
assert.equal(network.Internal, true);
assert.equal(network.Labels['rag.local-baseline'], '20261107-01a1b3be');
assert.equal(Object.keys(network.Containers).length, 5);
for (const id of Object.keys(network.Containers)) {
  const member = inspect(id);
  assert.equal(member.State.Running, true);
  assert.equal(member.Config.Labels['com.supabase.cli.project'], project);
  assert.deepEqual(Object.keys(member.NetworkSettings.Networks), [networkName]);
}
const migration = path.join(directory, '../migrations/20261107054356_s1_p3_interactions_owner_policies.sql');
const digest = createHash('sha256').update(fs.readFileSync(migration)).digest('hex');
assert.equal(digest, '01a702832d8845f2945e2f9342a7045c902af5639c08989a4f898dc91489b350');

// A raw real HTTP request through the documented Docker-exec/nc transport.
// No credentials are required at the isolated Auth service's internal health/token endpoints.
function request(host, port, method, endpoint, payload) {
  const body = payload ? JSON.stringify(payload) : '';
  const wire = `${method} ${endpoint} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  const raw = localDocker(['exec', '-i', db, 'nc', host, String(port)], wire);
  const split = raw.indexOf('\r\n\r\n');
  assert.ok(split > 0, 'Missing actual HTTP response');
  const headers = raw.slice(0, split);
  const status = Number(headers.match(/^HTTP\/1\.[01] (\d{3})/)?.[1]);
  assert.ok(status >= 100 && status <= 599);
  let text = raw.slice(split + 4);
  if (/transfer-encoding: chunked/i.test(headers)) {
    let decoded = '';
    while (text.length) {
      const end = text.indexOf('\r\n');
      const size = parseInt(text.slice(0, end), 16);
      assert.ok(Number.isFinite(size));
      if (!size) break;
      decoded += text.slice(end + 2, end + 2 + size);
      text = text.slice(end + 2 + size + 2);
    }
    text = decoded;
  }
  return { status, body: JSON.parse(text) };
}
const health = request('auth', 9999, 'GET', '/health');
assert.equal(health.status, 200);
const settings = request('auth', 9999, 'GET', '/settings');
const password = request('auth', 9999, 'POST', '/token?grant_type=password', {
  email: 'g5-probe@example.invalid', password: 'Disposable-G5-probe-only!2026',
});
assert.ok(!password.body.access_token && !password.body.refresh_token, 'Unexpected session; stop and inspect');
const auth = inspect(`supabase_auth_${project}`);
const emailEnabled = auth.Config.Env.find(value => value.startsWith('GOTRUE_EXTERNAL_EMAIL_ENABLED='));
const evidence = {
  project, network: networkName, internal: true, migrationSha256: digest,
  health, emailProviderSetting: emailEnabled,
  authSettings: { status: settings.status, emailEnabled: settings.body.external?.email },
  passwordGrant: password, fixtureWrites: 0, nextServerStarted: false,
};
fs.writeFileSync(path.join(runtime, 'g5-connectivity.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
