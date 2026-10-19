import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequestGuard, normalizeAddress } from '../server/request-guard.ts';
import { RequestError } from '../server/store.ts';

function request(address = '198.51.100.1', headers: Record<string, string> = {}, path = '/api/results', method = 'POST') {
  return { socket: { remoteAddress: address }, headers, url: path, method } as IncomingMessage;
}
function response() {
  const headers: Record<string, string> = {};
  return { headers, res: { setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; } } as unknown as ServerResponse };
}
function rejected(fn: () => void, status: number) {
  assert.throws(fn, error => error instanceof RequestError && error.status === status && Boolean(error.retryAfter));
}

test('ignores untrusted forwarding headers and walks trusted proxy chains from the right', () => {
  const direct = createRequestGuard({});
  assert.equal(direct.clientAddress(request('198.51.100.1', { 'x-forwarded-for': '203.0.113.1' })), '198.51.100.1');
  const proxy = createRequestGuard({ APP_TRUSTED_PROXIES: '127.0.0.1,10.0.0.0/24' });
  assert.equal(proxy.clientAddress(request('::ffff:127.0.0.1', { 'x-forwarded-for': '192.0.2.99,203.0.113.5,10.0.0.2' })), '203.0.113.5');
  assert.equal(proxy.clientAddress(request('127.0.0.1')), '127.0.0.1');
  assert.throws(() => proxy.clientAddress(request('127.0.0.1', { 'x-forwarded-for': 'not-an-ip' })), RequestError);
  assert.equal(normalizeAddress('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(normalizeAddress('2001:0db8:0:0:0:0:0:1'), '2001:db8::1');
});

test('signed anonymous cookies enforce session quotas across source addresses without requiring login', () => {
  const guard = createRequestGuard({ APP_SUBMISSIONS_PER_SESSION_MINUTE: '1' });
  const first = response(); guard.admit(request(), first.res)!();
  const cookie = first.headers['set-cookie']!;
  assert.match(cookie, /HttpOnly; SameSite=Lax/);
  rejected(() => guard.admit(request('198.51.100.2', { cookie: cookie.split(';')[0]! }), response().res)!(), 429);
  const forged = cookie.split(';')[0]!.replace('=', '=A');
  const next = response(); guard.admit(request('198.51.100.2', { cookie: forged }), next.res)!();
  assert.ok(next.headers['set-cookie'], 'a forged signature cannot choose a trusted session');
});

test('IP and global new-submission quotas cannot be bypassed by replacing cookies or forwarding headers', () => {
  const guard = createRequestGuard({ APP_SUBMISSIONS_PER_IP_MINUTE: '1', APP_SUBMISSIONS_PER_MINUTE: '2' });
  guard.admit(request(), response().res)!();
  rejected(() => guard.admit(request('198.51.100.1', { 'x-forwarded-for': '192.0.2.100' }), response().res)!(), 429);
  guard.admit(request('198.51.100.2'), response().res)!();
  rejected(() => guard.admit(request('198.51.100.3'), response().res)!(), 429);
});

test('URL aliases use the same normalized route and cannot bypass submission quotas', () => {
  const guard = createRequestGuard({ APP_SUBMISSIONS_PER_IP_MINUTE: '1' });
  guard.admit(request('198.51.100.1', {}, '/other/../api/results'), response().res)!();
  rejected(() => guard.admit(request('198.51.100.1', {}, 'http://example.test/api/results?retry=1'), response().res)!(), 429);
});

test('IPv6 /64 address rotation and IPv4-mapped representations share their source allowance', () => {
  const guard = createRequestGuard({ APP_SUBMISSIONS_PER_IP_MINUTE: '1' });
  guard.admit(request('2001:db8::1'), response().res)!();
  rejected(() => guard.admit(request('2001:0db8:0:0:abcd::1234'), response().res)!(), 429);
  guard.admit(request('127.0.0.1'), response().res)!();
  rejected(() => guard.admit(request('::ffff:7f00:1'), response().res)!(), 429);
});

test('API and global request budgets include reads, expire, and reject excess work before body parsing', () => {
  let now = 0;
  const guard = createRequestGuard({ APP_API_REQUESTS_PER_MINUTE: '1', APP_REQUESTS_PER_SECOND: '3' }, () => now);
  guard.admit(request('198.51.100.1', {}, '/api/results/decode?token=bad', 'GET'), response().res);
  rejected(() => guard.admit(request('198.51.100.1', {}, '/api/nope', 'GET'), response().res), 429);
  guard.admit(request('198.51.100.2', {}, '/', 'GET'), response().res);
  rejected(() => guard.admit(request('198.51.100.3', {}, '/', 'GET'), response().res), 429);
  now = 60001;
  guard.admit(request(), response().res)!();
});

test('limiter state has a hard size limit, fails closed, and recovers expired entries', () => {
  let now = 0;
  const guard = createRequestGuard({ APP_LIMITER_MAX_KEYS: '3' }, () => now);
  for (const address of ['198.51.100.1', '198.51.100.2']) guard.admit(request(address, {}, '/api/nope', 'GET'), response().res);
  rejected(() => guard.admit(request('198.51.100.3', {}, '/api/nope', 'GET'), response().res), 503);
  now = 60001;
  guard.admit(request('198.51.100.3', {}, '/api/nope', 'GET'), response().res);
});

test('invalid guard configuration refuses startup instead of silently disabling protection', () => {
  for (const raw of ['0', '-1', 'NaN', '1.5', '1000001']) assert.throws(() => createRequestGuard({ APP_MAX_CONNECTIONS: raw }));
  for (const raw of ['localhost', '10.0.0.0/33', '::/129']) assert.throws(() => createRequestGuard({ APP_TRUSTED_PROXIES: raw }));
});
