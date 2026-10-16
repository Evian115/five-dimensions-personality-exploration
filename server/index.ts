import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createResultStore, RequestError } from './store.ts';

const dev = process.argv.includes('--dev');
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '127.0.0.1';
const store = createResultStore(resolve(process.env.DATABASE_PATH || './data/bigfive.sqlite'), process.env.BASE_URL || '');
const vite = dev ? await (await import('vite')).createServer({ server: { middlewareMode: true }, appType: 'spa' }) : undefined;
const dist = resolve('dist');
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8' };

function json(res: ServerResponse, status: number, body: unknown) {
  const content = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(content), 'Cache-Control': 'no-store' });
  res.end(content);
}

async function body(req: IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 16_384) throw new RequestError('提交内容过大。', 413);
  }
  try { return JSON.parse(text); } catch { throw new RequestError('提交内容不是有效的 JSON。'); }
}

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const pathname = requestUrl.pathname;
    if (/^\/test(?:\/|\/index\.html)?$/.test(pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(308, { Location: `/assessment${requestUrl.search}`, 'Cache-Control': 'no-cache' });
      res.end();
      return;
    }
    if (pathname === '/api/results/decode' && req.method === 'GET') {
      json(res, 200, store.decode(requestUrl.searchParams.get('token')));
      return;
    }
    if (pathname === '/api/results/decode' && req.method === 'POST') {
      if (!req.headers['content-type']?.includes('application/json')) throw new RequestError('请使用 JSON 格式提交。', 415);
      const payload = await body(req);
      json(res, 200, store.decode(payload && typeof payload === 'object' ? (payload as Record<string, unknown>).token : undefined));
      return;
    }
    if (pathname === '/api/results' && req.method === 'POST') {
      if (!req.headers['content-type']?.includes('application/json')) throw new RequestError('请使用 JSON 格式提交。', 415);
      json(res, 201, store.create(await body(req)));
      return;
    }
    const match = /^\/api\/results\/([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.exec(pathname);
    if (match && req.method === 'GET') {
      const result = store.get(match[1]!);
      json(res, result ? 200 : 404, result || { error: '这份测试结果不存在或已被删除。' });
      return;
    }
    if (pathname.startsWith('/api/')) { json(res, 404, { error: '接口不存在。' }); return; }
    const appPage = /^\/(?:assessment\/?|results\/[^/]+\/?)$/.test(pathname);
    if (vite) {
      if (appPage) req.url = '/assessment/index.html';
      vite.middlewares(req, res); return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const page = pathname === '/' || appPage;
    const file = page ? resolve(dist, appPage ? 'assessment/index.html' : 'index.html') : resolve(dist, `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(`${dist}${sep}`)) { res.writeHead(404); res.end(); return; }
    try {
      const content = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': page ? 'no-cache' : 'public, max-age=3600' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch { res.writeHead(404); res.end('Not found'); }
  } catch (error) {
    if (!(error instanceof RequestError)) console.error(error);
    json(res, error instanceof RequestError ? error.status : 500, { error: error instanceof RequestError ? error.message : '保存或读取结果失败，请稍后重试。' });
  }
});
server.listen(port, host, () => {
  const address = server.address();
  console.log(`Big Five: http://${host}:${typeof address === 'object' && address ? address.port : port}/`);
});
async function stop() {
  server.close();
  await vite?.close();
  store.close();
  process.exit(0);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
