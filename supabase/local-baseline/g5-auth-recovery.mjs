// Auth-only local recovery; Docker configuration and local secrets stay in memory.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
const project = 'rag-baseline-20261107-01a1b3be';
const networkName = `${project}-internal`;
const name = `supabase_auth_${project}`;
const backup = `${name}-g5-original`;
const docker = 'C:/Users/User/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe';
const engine = 'npipe:////./pipe/dockerDesktopLinuxEngine';
function api(method, endpoint, value) {
  return new Promise((resolve, reject) => {
    const body = value === undefined ? '' : JSON.stringify(value);
    const req = http.request({ socketPath: '//./pipe/dockerDesktopLinuxEngine',
      path: `/v1.56${endpoint}`, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', part => { data += part; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Local Docker ${method} ${endpoint} returned ${res.statusCode}`));
        } else resolve(data ? JSON.parse(data) : null);
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('Local Docker timeout')));
    req.on('error', reject);
    req.end(body);
  });
}
const network = await api('GET', `/networks/${networkName}`);
assert.equal(network.Internal, true);
assert.equal(network.Labels['rag.local-baseline'], '20261107-01a1b3be');
assert.equal(Object.keys(network.Containers).length, 5);
for (const id of Object.keys(network.Containers)) {
  const member = await api('GET', `/containers/${id}/json`);
  assert.equal(member.Config.Labels['com.supabase.cli.project'], project);
  assert.equal(member.State.Running, true);
  assert.deepEqual(Object.keys(member.NetworkSettings.Networks), [networkName]);
}
// Reuse the existing full database/catalog/isolation guard immediately before mutation.
execFileSync('pwsh.exe', ['-NoProfile', '-File', path.join(directory, 's1-p3.ps1'), '-Action', 'Verify'],
  { stdio: 'pipe', timeout: 60000, windowsHide: true });
const original = await api('GET', `/containers/${name}/json`);
assert.equal(original.Config.Image, 'public.ecr.aws/supabase/gotrue:v2.197.0');
assert.deepEqual(original.Mounts, []);
assert.ok(original.Config.Env.includes('GOTRUE_EXTERNAL_EMAIL_ENABLED=false'));
assert.ok(original.Config.Env.includes('GOTRUE_MAILER_AUTOCONFIRM=true'));
assert.ok(original.Config.Env.includes('GOTRUE_DISABLE_SIGNUP=false'));
const originalIp = original.NetworkSettings.Networks[networkName].IPAddress;
const config = structuredClone(original.Config);
config.Env = config.Env.map(value => value === 'GOTRUE_EXTERNAL_EMAIL_ENABLED=false'
  ? 'GOTRUE_EXTERNAL_EMAIL_ENABLED=true' : value);
assert.equal(config.Env.filter((value, index) => value !== original.Config.Env[index]).length, 1);
const endpoint = { Aliases: ['auth'], IPAMConfig: { IPv4Address: originalIp } };
const payload = { ...config, HostConfig: original.HostConfig,
  NetworkingConfig: { EndpointsConfig: { [networkName]: endpoint } } };
const localConfigs = ['config.toml', 'runtime/supabase/config.toml'].map(relative => {
  const filename = path.join(directory, relative);
  const text = fs.readFileSync(filename, 'utf8');
  assert.match(text, /\[auth\.email\]\r?\nenabled = false/);
  return { filename, text };
});
const evidence = { originalId: original.Id, originalIp, image: original.Config.Image,
  setting: 'GOTRUE_EXTERNAL_EMAIL_ENABLED', before: false, after: true,
  signupDisabled: false, autoConfirm: true, otherEnvironmentEntriesPreserved: true };
fs.writeFileSync(path.join(directory, 'runtime/g5-auth-recovery.json'), JSON.stringify(evidence, null, 2));
let replacement;
try {
  await api('POST', `/containers/${original.Id}/stop?t=10`);
  await api('POST', `/containers/${original.Id}/rename?name=${backup}`);
  await api('POST', `/networks/${networkName}/disconnect`, { Container: original.Id, Force: true });
  replacement = await api('POST', `/containers/create?name=${name}`, payload);
  await api('POST', `/containers/${replacement.Id}/start`);
  for (let attempt = 0; attempt < 30; attempt++) {
    const state = (await api('GET', `/containers/${replacement.Id}/json`)).State;
    if (state.Health?.Status === 'healthy') break;
    assert.equal(state.Running, true, 'Replacement Auth stopped during startup');
    assert.notEqual(state.Health?.Status, 'unhealthy', 'Replacement Auth unhealthy');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const health = execFileSync(docker, ['--host', engine, 'exec', `supabase_db_${project}`,
    'wget', '-q', '-T', '15', '--tries=3', '-O', '-', 'http://auth:9999/health'],
  { encoding: 'utf8', timeout: 50000, windowsHide: true });
  assert.equal(JSON.parse(health).name, 'GoTrue');
  const after = await api('GET', `/containers/${name}/json`);
  assert.deepEqual(after.Config.Env, config.Env);
  assert.equal(after.NetworkSettings.Networks[networkName].IPAddress, originalIp);
  assert.deepEqual(Object.keys(after.NetworkSettings.Networks), [networkName]);
  // Preserve the local-only setting for future starts; never touch the root app config.
  for (const { filename, text } of localConfigs) {
    fs.writeFileSync(filename, text.replace(/(\[auth\.email\]\r?\nenabled = )false/, '$1true'));
  }
  await api('DELETE', `/containers/${original.Id}`);
  evidence.replacementId = after.Id;
  evidence.status = 'PASSED';
  fs.writeFileSync(path.join(directory, 'runtime/g5-auth-recovery.json'), JSON.stringify(evidence, null, 2));
  console.log('PASSED: only Auth recreated; email provider enabled; original image, IP, other environment values and internal network preserved');
} catch (error) {
  // Retain the original stopped service until the replacement is verified.
  if (replacement) await api('DELETE', `/containers/${replacement.Id}?force=true`);
  await api('POST', `/containers/${original.Id}/rename?name=${name}`);
  await api('POST', `/networks/${networkName}/connect`, { Container: original.Id, EndpointConfig: endpoint });
  await api('POST', `/containers/${original.Id}/start`);
  throw error;
}
