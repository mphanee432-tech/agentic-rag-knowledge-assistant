// Local test transport only; the containers remain on an internal Docker network.
// shortcut: Docker exec adds latency, remove when internal-network ports work on Docker Desktop.
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const docker = 'C:/Users/User/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe';
const engine = 'npipe:////./pipe/dockerDesktopLinuxEngine';
const project = 'rag-baseline-20261107-01a1b3be';
const network = `${project}-internal`;
const info = JSON.parse(execFileSync(docker, ['--host', engine, 'network', 'inspect', network]));
assert.equal(info[0].Internal, true);
assert.equal(info[0].Labels['rag.local-baseline'], '20261107-01a1b3be');
const children = new Set();
const sockets = new Set();
let stopping = false;
const servers = [[57432, 'db', 5432], [57431, 'kong', 8000]].map(([port, service, targetPort]) => {
  let ready;
  let preparing;
  const waiting = [];
  function connect(socket, child) {
    sockets.add(socket);
    child.on('exit', () => socket.destroy());
    child.stdin.on('error', () => socket.destroy());
    socket.on('error', () => child.kill());
    socket.on('close', () => { sockets.delete(socket); child.kill(); });
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    socket.resume();
  }
  // Keep one local transport ready so CLI connection deadlines exclude Docker exec startup.
  function prepare() {
    if (stopping || ready || preparing) return;
    const host = service === 'db' ? '127.0.0.1' : 'kong';
    const child = spawn(docker, ['--host', engine, 'exec', '-i', `supabase_db_${project}`,
      'sh', '-c', `echo ready >&2; exec nc ${host} ${targetPort}`],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    preparing = child;
    children.add(child);
    child.on('error', () => child.kill());
    child.stdin.on('error', () => {});
    child.stderr.once('data', data => {
      if (!data.toString().startsWith('ready')) return;
      preparing = undefined;
      ready = child;
      const socket = waiting.shift();
      if (socket) { ready = undefined; connect(socket, child); prepare(); }
    });
    child.on('exit', () => {
      children.delete(child);
      if (ready === child) ready = undefined;
      if (preparing === child) preparing = undefined;
      if (!stopping) setTimeout(prepare, 1000);
    });
  }
  const server = net.createServer(socket => {
    socket.pause();
    // Open HTTP transport on demand; an idle preconnection can expire before its first request.
    if (service === 'kong') {
      const child = spawn(docker, ['--host', engine, 'exec', '-i', `supabase_db_${project}`,
        'nc', 'kong', String(targetPort)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      children.add(child);
      child.on('exit', () => children.delete(child));
      child.on('error', () => socket.destroy());
      connect(socket, child);
      return;
    }
    if (ready) { const child = ready; ready = undefined; connect(socket, child); prepare(); }
    else { waiting.push(socket); socket.on('close', () => { const i = waiting.indexOf(socket); if (i >= 0) waiting.splice(i, 1); }); }
  });
  server.on('error', error => { console.error(`Loopback bridge failed: ${error.code}`); process.exitCode = 1; shutdown(); });
  server.listen(port, '127.0.0.1', () => {
    assert.equal(server.address().address, '127.0.0.1');
    console.log(`Local-only bridge listening on 127.0.0.1:${port}`);
    if (service === 'db') prepare();
  });
  return server;
});
function shutdown() {
  stopping = true;
  for (const socket of sockets) socket.destroy();
  for (const child of children) child.kill();
  for (const server of servers) server.close();
  process.exit();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('data', chunk => { if (chunk.toString().includes('quit') || chunk.includes(3)) shutdown(); });
