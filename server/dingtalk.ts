export interface DingtalkSettings {
  appKey: string; appSecret: string; baseId: string; sheetId: string; operatorId: string;
}
export interface DingtalkRecord {
  openness: number; conscientiousness: number; extraversion: number; agreeableness: number; neuroticism: number;
  created_at: string; updated_at: string; share_url: string;
}
export interface DingtalkDelivery extends DingtalkRecord {
  base_id: string; sheet_id: string; client_token: string;
}

export function dingtalkSettings(env: NodeJS.ProcessEnv): DingtalkSettings | undefined {
  const names = ['DINGTALK_APP_KEY', 'DINGTALK_APP_SECRET', 'DINGTALK_BASE_ID', 'DINGTALK_SHEET_ID_OR_NAME'] as const;
  const values = names.map(name => env[name]?.trim() || '');
  if (values.every(value => !value)) return;
  const missing = names.filter((_, index) => !values[index]);
  if (missing.length) throw new Error(`钉钉配置缺少：${missing.join('、')}`);
  return { appKey: values[0]!, appSecret: values[1]!, baseId: values[2]!, sheetId: values[3]!, operatorId: env.DINGTALK_OPERATOR_ID?.trim() || '' };
}

export function dingtalkFields(record: DingtalkRecord) {
  const created = Date.parse(record.created_at), updated = Date.parse(record.updated_at);
  if (!Number.isFinite(created) || !Number.isFinite(updated)) throw new Error('钉钉记录的时间无效。');
  for (const score of [record.openness, record.conscientiousness, record.extraversion, record.agreeableness, record.neuroticism]) {
    if (!Number.isInteger(score) || score < 0 || score > 100) throw new Error('钉钉分数必须是 0–100 的整数。');
  }
  const url = new URL(record.share_url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('钉钉结果链接必须是完整的网页地址。');
  return {
    写入时间: created, 开放性: record.openness, 尽责性: record.conscientiousness, 外向性: record.extraversion,
    宜人性: record.agreeableness, 神经质: record.neuroticism,
    链接: { text: '查看测评结果', link: record.share_url }, 更新时间: updated,
  };
}

export class DingtalkError extends Error {
  code: string;
  constructor(code: string) {
    // Do not echo upstream response bodies, token URLs, user data or credentials into logs.
    const safe = /^[A-Za-z0-9_.-]{1,120}$/.test(code) ? code : 'RequestFailed';
    super(`钉钉请求失败（${safe}）`); this.code = safe;
  }
}

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export function createDingtalkClient(
  settings: Pick<DingtalkSettings, 'appKey' | 'appSecret' | 'operatorId'>,
  options: { fetch?: typeof fetch; now?: () => number; apiOrigin?: string; timeoutMs?: number } = {},
) {
  const request = options.fetch ?? fetch, now = options.now ?? Date.now;
  const apiOrigin = options.apiOrigin ?? 'https://api.dingtalk.com';
  let token: { value: string; expires: number } | undefined;
  let refreshing: Promise<string> | undefined;
  async function json(url: string, init: RequestInit, signal?: AbortSignal): Promise<Json> {
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 10000);
      response = await request(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch { throw new DingtalkError('NetworkOrTimeout'); }
    let value: unknown;
    try { value = await response.json(); } catch { throw new DingtalkError('InvalidResponse'); }
    if (!object(value)) throw new DingtalkError('InvalidResponse');
    if (!response.ok) throw new DingtalkError(response.status === 401 ? 'Unauthorized' : typeof value.code === 'string' ? value.code : `Http${response.status}`);
    if (typeof value.errcode === 'number' && value.errcode !== 0) throw new DingtalkError(`Api${value.errcode}`);
    return value;
  }
  async function accessToken(signal?: AbortSignal) {
    if (token && token.expires > now()) return token.value;
    if (!refreshing) {
      refreshing = (async () => {
        const result = await json(`${apiOrigin}/v1.0/oauth2/accessToken`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appKey: settings.appKey, appSecret: settings.appSecret }),
        }, signal);
        if (typeof result.accessToken !== 'string' || !result.accessToken || typeof result.expireIn !== 'number' || result.expireIn <= 0) throw new DingtalkError('InvalidTokenResponse');
        const duration = result.expireIn * 1000;
        token = { value: result.accessToken, expires: now() + duration - Math.min(60000, duration / 10) };
        return token.value;
      })().finally(() => { refreshing = undefined; });
    }
    return refreshing;
  }
  async function topApi(path: string, body: Json) {
    const url = new URL(`https://oapi.dingtalk.com/topapi/v2/user/${path}`);
    url.searchParams.set('access_token', await accessToken());
    return json(url.href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  async function recoverDuplicate(url: URL, expected: ReturnType<typeof dingtalkFields>, signal?: AbortSignal) {
    const lookup = new URL(url);
    lookup.pathname += '/list';
    lookup.searchParams.delete('clientToken');
    let nextToken: string | undefined;
    const seen = new Set<string>();
    const matches: string[] = [];
    do {
      const page = await json(lookup.href, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': await accessToken(signal) },
        body: JSON.stringify({ maxResults: 100, fieldIdOrNames: Object.keys(expected), nextToken,
          // DingTalk currently does not support URL-field filters. Narrow by the five
          // numeric scores, then verify the unique encrypted link and both dates locally.
          filter: { combination: 'and', conditions: ['开放性', '尽责性', '外向性', '宜人性', '神经质'].map(field => ({
            field, operator: 'equal', value: [expected[field as keyof typeof expected]],
          })) } }),
      }, signal);
      if (!Array.isArray(page.records)) throw new DingtalkError('InvalidListResponse');
      for (const record of page.records) {
        if (!object(record) || typeof record.id !== 'string' || !record.id || !object(record.fields)) continue;
        const actual = record.fields;
        if (!object(actual.链接) || actual.链接.link !== expected.链接.link) continue;
        const numericMatch = Object.entries(expected).filter(([name]) => name !== '链接').every(([name, value]) => {
          const field = actual[name];
          return (typeof field === 'number' || typeof field === 'string' && field.trim() !== '') && Number(field) === value;
        });
        if (numericMatch) matches.push(record.id);
      }
      if (!page.hasMore) break;
      if (typeof page.nextToken !== 'string' || !page.nextToken || seen.has(page.nextToken)) throw new DingtalkError('InvalidListResponse');
      nextToken = page.nextToken; seen.add(nextToken);
    } while (true);
    if (matches.length !== 1) throw new DingtalkError(matches.length ? 'DuplicateRecordAmbiguous' : 'DuplicateRecordNotFound');
    return matches[0]!;
  }
  return {
    accessToken,
    async resolveUnionId(identity: { authCode: string } | { userId: string }) {
      const value = 'authCode' in identity ? await topApi('getuserinfo', { code: identity.authCode }) : await topApi('get', { userid: identity.userId });
      if (!object(value.result) || typeof value.result.unionid !== 'string' || !value.result.unionid) throw new DingtalkError('MissingUnionId');
      return value.result.unionid;
    },
    async insert(record: DingtalkDelivery, signal?: AbortSignal) {
      if (!settings.operatorId) throw new DingtalkError('MissingOperatorId');
      const fields = dingtalkFields(record);
      const deadline = AbortSignal.timeout(45000);
      signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const url = new URL(`${apiOrigin}/v1.0/notable/bases/${encodeURIComponent(record.base_id)}/sheets/${encodeURIComponent(record.sheet_id)}/records`);
      url.searchParams.set('operatorId', settings.operatorId);
      url.searchParams.set('clientToken', record.client_token);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const value = await json(url.href, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': await accessToken(signal) },
            body: JSON.stringify({ records: [{ fields }] }),
          }, signal);
          const first: unknown = Array.isArray(value.value) ? value.value[0] : undefined;
          if (!object(first) || typeof first.id !== 'string' || !first.id) throw new DingtalkError('InvalidInsertResponse');
          return first.id;
        } catch (error) {
          if (error instanceof DingtalkError && error.code === 'invalidRequest.duplicateClientToken') return recoverDuplicate(url, fields, signal);
          if (attempt === 0 && error instanceof DingtalkError && ['Unauthorized', 'InvalidAuthentication', 'InvalidAccessToken', 'AccessToken.Expired'].includes(error.code)) { token = undefined; continue; }
          throw error;
        }
      }
      throw new DingtalkError('RequestFailed');
    },
  };
}
