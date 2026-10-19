import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDingtalkClient, dingtalkFields, dingtalkSettings, DingtalkError, type DingtalkDelivery } from '../server/dingtalk.ts';

const settings = { appKey: 'app-key-private', appSecret: 'app-secret-private', operatorId: 'operator-union' };
const record: DingtalkDelivery = {
  openness: 0, conscientiousness: 25, extraversion: 50, agreeableness: 75, neuroticism: 100,
  created_at: '2026-10-19T01:02:03.000Z', updated_at: '2026-10-19T02:03:04.000Z',
  share_url: 'https://example.com/results/view#e1_example', base_id: 'base-id', sheet_id: '测评记录', client_token: randomUUID(),
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const auth = () => response({ accessToken: 'private-token', expireIn: 7200 });

test('maps dates to epoch milliseconds, five integer scores and a full URL object', () => {
  assert.deepEqual(dingtalkFields(record), {
    写入时间: 1792371723000, 开放性: 0, 尽责性: 25, 外向性: 50, 宜人性: 75, 神经质: 100,
    链接: { text: '查看测评结果', link: record.share_url }, 更新时间: 1792375384000,
  });
  for (const bad of [{ openness: 0.5 }, { openness: 101 }, { openness: -1 }, { created_at: 'bad' }, { share_url: '/results/view#abc' }, { share_url: 'javascript:alert(1)' }]) {
    assert.throws(() => dingtalkFields({ ...record, ...bad }));
  }
});

test('requires complete application configuration but permits queuing while the operator is missing', () => {
  assert.equal(dingtalkSettings({}), undefined);
  assert.throws(() => dingtalkSettings({ DINGTALK_APP_KEY: 'key' }), /DINGTALK_APP_SECRET/);
  const config = dingtalkSettings({ DINGTALK_APP_KEY: 'key', DINGTALK_APP_SECRET: 'secret', DINGTALK_BASE_ID: 'base', DINGTALK_SHEET_ID_OR_NAME: 'sheet' });
  assert.equal(config?.operatorId, '');
});

test('caches access tokens, shares concurrent refreshes and refreshes before expiry', async () => {
  let requests = 0, now = 0;
  const client = createDingtalkClient(settings, { now: () => now, fetch: async (_url, init) => {
    requests++;
    assert.deepEqual(JSON.parse(String(init?.body)), { appKey: settings.appKey, appSecret: settings.appSecret });
    return auth();
  } });
  await Promise.all(Array.from({ length: 8 }, () => client.accessToken()));
  assert.equal(requests, 1);
  now = 7100000;
  await client.accessToken(); assert.equal(requests, 1);
  now = 7200000;
  await client.accessToken(); assert.equal(requests, 2);
});

test('uses the exact stored fields and stable UUID as DingTalk clientToken, refreshing on 401', async () => {
  let tokenRequests = 0, inserts = 0;
  const client = createDingtalkClient(settings, { fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/accessToken')) { tokenRequests++; return auth(); }
    inserts++;
    assert.equal(decodeURIComponent(url.pathname), '/v1.0/notable/bases/base-id/sheets/测评记录/records');
    assert.equal(url.searchParams.get('operatorId'), 'operator-union');
    assert.equal(url.searchParams.get('clientToken'), record.client_token);
    assert.equal(new Headers(init?.headers).get('x-acs-dingtalk-access-token'), 'private-token');
    assert.deepEqual(JSON.parse(String(init?.body)), { records: [{ fields: dingtalkFields(record) }] });
    return inserts === 1 ? response({ code: 'InvalidAuthentication' }, 401) : response({ value: [{ id: 'record-id' }] });
  } });
  assert.equal(await client.insert(record), 'record-id');
  assert.equal(tokenRequests, 2); assert.equal(inserts, 2);
});

test('does not mark malformed or failed remote responses as successful, and never logs sensitive bodies', async () => {
  for (const value of [{}, { value: [] }, { value: [{}] }]) {
    const client = createDingtalkClient(settings, { fetch: async url => String(url).endsWith('accessToken') ? auth() : response(value) });
    await assert.rejects(client.insert(record), /InvalidInsertResponse/);
  }
  const client = createDingtalkClient(settings, { fetch: async () => response({ code: 'Forbidden', message: settings.appSecret, accessToken: 'private-token' }, 403) });
  await assert.rejects(client.accessToken(), error => {
    assert.ok(error instanceof DingtalkError);
    assert.equal(error.message.includes(settings.appSecret), false);
    assert.equal(error.message.includes('private-token'), false);
    return true;
  });
});

test('resolves unionId from a real auth code or user ID without inventing an operator identity', async () => {
  const paths: string[] = [];
  const client = createDingtalkClient(settings, { fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/accessToken')) return auth();
    paths.push(url.pathname);
    assert.equal(url.searchParams.get('access_token'), 'private-token');
    const body = JSON.parse(String(init?.body));
    if (url.pathname.endsWith('getuserinfo')) assert.deepEqual(body, { code: 'real-auth-code' });
    else assert.deepEqual(body, { userid: 'real-user-id' });
    return response({ errcode: 0, result: { unionid: 'real-union-id' } });
  } });
  assert.equal(await client.resolveUnionId({ authCode: 'real-auth-code' }), 'real-union-id');
  assert.equal(await client.resolveUnionId({ userId: 'real-user-id' }), 'real-union-id');
  assert.deepEqual(paths, ['/topapi/v2/user/getuserinfo', '/topapi/v2/user/get']);
});


test('network timeouts fail without leaking credentials or accepting a false success', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const client = createDingtalkClient(settings, { timeoutMs: 10, fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error(settings.appSecret)), { once: true });
    }) });
    await assert.rejects(client.accessToken(), error => error instanceof DingtalkError && error.code === 'NetworkOrTimeout' && !error.message.includes(settings.appSecret));
  } finally { clearTimeout(keepAlive); }
});


test('duplicateClientToken recovers the original remote ID only after matching link, dates and all five scores', async () => {
  let lookupCount = 0;
  const client = createDingtalkClient(settings, { fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/accessToken')) return auth();
    if (!url.pathname.endsWith('/list')) return response({ code: 'invalidRequest.duplicateClientToken' }, 400);
    lookupCount++;
    const body = JSON.parse(String(init?.body));
    assert.equal(url.searchParams.has('clientToken'), false);
    assert.deepEqual(body.filter.conditions, ['开放性', '尽责性', '外向性', '宜人性', '神经质'].map((field, index) => ({ field, operator: 'equal', value: [index * 25] })));
    if (!body.nextToken) return response({ records: [{ id: 'different-submission', fields: { ...dingtalkFields(record), 链接: { link: 'https://example.com/other' } } }], hasMore: true, nextToken: 'page-two' });
    return response({ records: [{ id: 'original-id', fields: { ...dingtalkFields(record), 开放性: '0', 尽责性: '25' } }], hasMore: false });
  } });
  assert.equal(await client.insert(record), 'original-id');
  assert.equal(lookupCount, 2);
});

test('duplicate token alone never acknowledges a missing, changed or ambiguous remote record', async () => {
  for (const records of [[], [{ id: 'changed', fields: { ...dingtalkFields(record), 开放性: 1 } }],
    [{ id: 'null-score', fields: { ...dingtalkFields(record), 开放性: null } }],
    [{ id: 'first', fields: dingtalkFields(record) }, { id: 'second', fields: dingtalkFields(record) }]]) {
    const client = createDingtalkClient(settings, { fetch: async url => String(url).endsWith('accessToken') ? auth()
      : new URL(String(url)).pathname.endsWith('/list') ? response({ records, hasMore: false }) : response({ code: 'invalidRequest.duplicateClientToken' }, 400) });
    await assert.rejects(client.insert(record), /DuplicateRecord/);
  }
});
