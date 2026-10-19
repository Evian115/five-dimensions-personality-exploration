import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createResultStore, RequestError } from './store.ts';
import { createDingtalkClient, dingtalkSettings } from './dingtalk.ts';
import { createDingtalkSynchronizer } from './dingtalk-outbox.ts';
import { createRequestGuard } from './request-guard.ts';

const dev = process.argv.includes('--dev');
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '127.0.0.1';
const dingtalk = dingtalkSettings(process.env);
const guard = createRequestGuard(process.env);
const limits = guard.settings;
const store = createResultStore(resolve(process.env.DATABASE_PATH || './data/bigfive.sqlite'), process.env.BASE_URL || '', dingtalk && { ...dingtalk, maxPending: limits.MAX_PENDING_SYNC });
const synchronizer = dingtalk?.operatorId ? createDingtalkSynchronizer(store.outbox, createDingtalkClient(dingtalk, {
  apiOrigin: process.env.NODE_ENV === 'test' ? process.env.DINGTALK_TEST_API_ORIGIN : undefined,
})) : undefined;
if (dingtalk && !synchronizer) console.warn('钉钉同步等待配置操作人 unionId；新提交先进入持久队列。');
synchronizer?.wake();
const vite = dev ? await (await import('vite')).createServer({ server: { middlewareMode: true }, appType: 'spa' }) : undefined;
const dist = resolve('dist');
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8' };

function json(res: ServerResponse, status: number, body: unknown) {
  const content = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(content), 'Cache-Control': 'no-store' });
  res.end(content);
}

async function body(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers['content-length']) > 16_384) throw new RequestError('提交内容过大。', 413);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 16_384) throw new RequestError('提交内容过大。', 413);
      chunks.push(bytes);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new RequestError('提交内容不是有效的 JSON。'); }
  };
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RequestError('请求接收超时，请重新提交。', 408)), limits.BODY_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

function rejectRequest(req: IncomingMessage, res: ServerResponse, error: unknown) {
  if ((req.destroyed && !req.complete) || res.destroyed) return;
  if (!(error instanceof RequestError)) console.error(error);
  if (error instanceof RequestError && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
  if (!req.complete) {
    res.setHeader('Connection', 'close');
    res.once('finish', () => { req.socket.destroySoon(); });
  }
  json(res, error instanceof RequestError ? error.status : 500, { error: error instanceof RequestError ? error.message : '保存或读取结果失败，请稍后重试。' });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, beforeInsert?: () => void) {
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
      const origin = req.headers.origin || `http://${req.headers.host || 'localhost'}`;
      const result = store.create(await body(req), origin, beforeInsert);
      json(res, 201, result);
      synchronizer?.wake();
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
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); } catch { throw new RequestError('请求地址格式不正确。'); }
    const file = page ? resolve(dist, appPage ? 'assessment/index.html' : 'index.html') : resolve(dist, `.${decoded}`);
    if (!file.startsWith(`${dist}${sep}`)) { res.writeHead(404); res.end(); return; }
    try {
      const content = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': page ? 'no-cache' : 'public, max-age=3600' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch { res.writeHead(404); res.end('Not found'); }
  } catch (error) {
    rejectRequest(req, res, error);
  }
}
let stopping = false;
const inFlight = new Set<Promise<void>>();
const responses = new Set<ServerResponse>();
const server = createServer({
  maxHeaderSize: 8192, headersTimeout: limits.HEADERS_TIMEOUT_MS,
  requestTimeout: limits.REQUEST_TIMEOUT_MS, connectionsCheckingInterval: 1000,
  keepAliveTimeout: 5000,
}, (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (stopping) {
    res.writeHead(503, { Connection: 'close', 'Retry-After': '1' });
    res.end();
    return;
  }
  let beforeInsert: (() => void) | undefined;
  try {
    if ((req.url?.length ?? 0) > 4096) throw new RequestError('请求地址过长。', 414);
    if (responses.size >= limits.MAX_CONCURRENT_REQUESTS) throw new RequestError('服务繁忙，请稍后再试。', 503, 1);
    beforeInsert = guard.admit(req, res);
  } catch (error) { rejectRequest(req, res, error); return; }
  responses.add(res);
  res.once('close', () => { responses.delete(res); });
  const task = handleRequest(req, res, beforeInsert);
  inFlight.add(task);
  void task.finally(() => { inFlight.delete(task); });
});
server.maxConnections = limits.MAX_CONNECTIONS;
server.maxRequestsPerSocket = 100;
server.setTimeout(limits.REQUEST_TIMEOUT_MS, socket => { socket.destroy(); });
server.listen(port, host, () => {
  const address = server.address();
  console.log(`Big Five: http://${host}:${typeof address === 'object' && address ? address.port : port}/`);
});
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const res of responses) {
    res.shouldKeepAlive = false;
    if (!res.headersSent) res.setHeader('Connection', 'close');
  }
  const configured = Number(process.env.SHUTDOWN_TIMEOUT_MS || 15000);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 15000;
  const timeout = setTimeout(() => {
    console.warn('关停等待超时，正在关闭未完成的连接；未收到结果的提交可使用原编号重试。');
    server.closeAllConnections();
  }, timeoutMs);
  try {
    await Promise.all([
      new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
      synchronizer?.stop(),
    ]);
    await Promise.allSettled([...inFlight]);
    await vite?.close();
    store.close();
  } finally { clearTimeout(timeout); }
  process.exit(0);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
