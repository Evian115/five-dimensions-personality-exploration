import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RequestError } from './store.ts';

const cookieName = 'bigfive_session';
const defaults = {
  MAX_CONNECTIONS: 128, MAX_CONCURRENT_REQUESTS: 32, REQUESTS_PER_SECOND: 100,
  API_REQUESTS_PER_MINUTE: 180, SUBMISSIONS_PER_IP_MINUTE: 30,
  SUBMISSIONS_PER_SESSION_MINUTE: 5, SUBMISSIONS_PER_MINUTE: 60,
  LIMITER_MAX_KEYS: 10000, BODY_TIMEOUT_MS: 10000, HEADERS_TIMEOUT_MS: 10000,
  REQUEST_TIMEOUT_MS: 15000, MAX_PENDING_SYNC: 500,
};
type Settings = { [K in keyof typeof defaults]: number };

function ipv6Parts(address: string) {
  const [left = '', right = ''] = address.split('::');
  const a = left ? left.split(':') : [], b = right ? right.split(':') : [];
  return address.includes('::') ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
}
export function normalizeAddress(value: string): string | undefined {
  if (isIP(value) === 4) return value;
  if (isIP(value) !== 6 || value.includes('%')) return;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const parts = ipv6Parts(canonical).map(part => parseInt(part, 16));
  if (parts.slice(0, 5).every(part => part === 0) && parts[5] === 0xffff) {
    return [parts[6]! >> 8, parts[6]! & 255, parts[7]! >> 8, parts[7]! & 255].join('.');
  }
  return canonical;
}
function sourceKey(address: string) {
  // IPv6 privacy addresses in the same /64 share an allowance.
  return isIP(address) === 6 ? ipv6Parts(address).slice(0, 4).map(part => parseInt(part, 16).toString(16)).join(':') + '::/64' : address;
}

export function createRequestGuard(env: NodeJS.ProcessEnv, now = Date.now) {
  const settings = {} as Settings;
  for (const [name, fallback] of Object.entries(defaults)) {
    const raw = env[`APP_${name}`]?.trim();
    const value = raw ? Number(raw) : fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw new Error(`APP_${name} 必须是 1–1000000 的整数。`);
    settings[name as keyof Settings] = value;
  }
  if (settings.HEADERS_TIMEOUT_MS > settings.REQUEST_TIMEOUT_MS) throw new Error('APP_HEADERS_TIMEOUT_MS 不能大于 APP_REQUEST_TIMEOUT_MS。');
  const proxies = new BlockList();
  for (const entry of (env.APP_TRUSTED_PROXIES || '').split(',').map(value => value.trim()).filter(Boolean)) {
    const [raw = '', prefix, extra] = entry.split('/');
    const address = normalizeAddress(raw);
    if (!address || extra !== undefined) throw new Error('APP_TRUSTED_PROXIES 必须是逗号分隔的 IP 或 CIDR。');
    const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) proxies.addAddress(address, family);
    else {
      const bits = Number(prefix);
      if (!/^\d+$/.test(prefix) || bits < 0 || bits > (family === 'ipv4' ? 32 : 128)) throw new Error('APP_TRUSTED_PROXIES 的 CIDR 前缀无效。');
      proxies.addSubnet(address, bits, family);
    }
  }
  const trusted = (address: string) => Boolean(isIP(address)) && proxies.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
  function clientAddress(req: Pick<IncomingMessage, 'socket' | 'headers'>) {
    let address = normalizeAddress(req.socket.remoteAddress || '') || 'unknown';
    const header = req.headers['x-forwarded-for'];
    if (!trusted(address) || !header) return address;
    if (typeof header !== 'string' || header.length > 2048) throw new RequestError('来源地址格式不正确。');
    const chain = header.split(',');
    if (chain.length > 16) throw new RequestError('来源地址层级过多。');
    for (let i = chain.length - 1; i >= 0 && trusted(address); i--) {
      const next = normalizeAddress(chain[i]!.trim());
      if (!next) throw new RequestError('来源地址格式不正确。');
      address = next;
    }
    return address;
  }

  const buckets = new Map<string, { used: number; expires: number }>();
  let lastSweep = -Infinity;
  function take(items: { key: string; limit: number; window: number }[]) {
    const time = now();
    if (time - lastSweep >= 1000 && buckets.size >= settings.LIMITER_MAX_KEYS / 2) {
      for (const [key, value] of buckets) if (value.expires <= time) buckets.delete(key);
      lastSweep = time;
    }
    let missing = 0;
    for (const item of items) {
      const previous = buckets.get(item.key);
      if (!previous) missing++;
      if (previous && previous.expires > time && previous.used >= item.limit) {
        throw new RequestError('访问过于频繁，请稍后再试。', 429, Math.max(1, Math.ceil((previous.expires - time) / 1000)));
      }
    }
    if (buckets.size + missing > settings.LIMITER_MAX_KEYS) throw new RequestError('服务繁忙，请稍后再试。', 503, 1);
    for (const item of items) {
      const previous = buckets.get(item.key);
      if (previous && previous.expires > time) previous.used++;
      else buckets.set(item.key, { used: 1, expires: time + item.window });
    }
  }
  const secret = randomBytes(32);
  const sign = (id: string) => createHmac('sha256', secret).update(id).digest('base64url');
  function session(req: IncomingMessage, res: ServerResponse) {
    const raw = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (raw && /^[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/.test(raw)) {
      const [id = '', signature = ''] = raw.split('.');
      if (timingSafeEqual(Buffer.from(signature), Buffer.from(sign(id)))) return id;
    }
    const id = randomBytes(18).toString('base64url');
    const direct = normalizeAddress(req.socket.remoteAddress || '') || 'unknown';
    const secure = Boolean((req.socket as typeof req.socket & { encrypted?: boolean }).encrypted)
      || trusted(direct) && req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${cookieName}=${id}.${sign(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure ? '; Secure' : ''}`);
    return id;
  }
  return {
    settings, clientAddress,
    admit(req: IncomingMessage, res: ServerResponse) {
      take([{ key: 'all', limit: settings.REQUESTS_PER_SECOND, window: 1000 }]);
      let pathname: string;
      try { pathname = new URL(req.url || '/', 'http://localhost').pathname; }
      catch { throw new RequestError('请求地址格式不正确。'); }
      const address = sourceKey(clientAddress(req));
      if (pathname.startsWith('/api/')) take([{ key: `api:${address}`, limit: settings.API_REQUESTS_PER_MINUTE, window: 60000 }]);
      if (req.method !== 'POST' || pathname !== '/api/results') return undefined;
      const id = session(req, res);
      return () => take([
        { key: 'submissions', limit: settings.SUBMISSIONS_PER_MINUTE, window: 60000 },
        { key: `ip:${address}`, limit: settings.SUBMISSIONS_PER_IP_MINUTE, window: 60000 },
        { key: `session:${id}`, limit: settings.SUBMISSIONS_PER_SESSION_MINUTE, window: 60000 },
      ]);
    },
  };
}
