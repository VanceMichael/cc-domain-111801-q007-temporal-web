import { createServer } from 'node:http';

export async function fixtureSource(fixture, options = {}) {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('来源监听端口无效');
  // 静态条目深拷贝保持实例隔离；函数型条目（动态 timegate）原样保留。
  const resources = {};
  for (const [path, entry] of Object.entries(fixture.resources)) {
    resources[path] = typeof entry === 'function' ? entry : structuredClone(entry);
  }
  const accesses = [];
  const faults = new Map();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    accesses.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    const fault = faults.get(url.pathname);
    if (fault?.remaining > 0) {
      fault.remaining -= 1;
      response.writeHead(fault.status); response.end(JSON.stringify({ error: '来源暂时不可用' })); return;
    }
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'ready', resources: Object.keys(resources) }));
      return;
    }
    if (request.method !== 'GET' || !Object.hasOwn(resources, url.pathname)) {
      response.writeHead(404); response.end(JSON.stringify({ error: '来源资料不存在' })); return;
    }
    const entry = resources[url.pathname];
    const resolved = typeof entry === 'function'
      ? entry({ path: url.pathname, query: Object.fromEntries(url.searchParams), url })
      : entry;
    if (resolved?.delayMs) await new Promise(resolve => setTimeout(resolve, resolved.delayMs));
    response.writeHead(resolved?.status ?? 200, { 'content-type': resolved?.mediaType ?? 'application/json; charset=utf-8', ...(resolved?.headers ?? {}) });
    response.end(resolved?.bytes ?? JSON.stringify(resolved?.body));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    accesses,
    replace(path, entry) { resources[path] = typeof entry === 'function' ? entry : structuredClone(entry); },
    fail(path, status = 503, remaining = 1) { faults.set(path, { status, remaining }); },
    close() { return new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }); },
  };
}
