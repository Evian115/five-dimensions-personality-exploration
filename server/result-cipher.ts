import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { RESULT_VERSIONS } from '../src/assessment-versions.ts';
import { decodeResult, encodeResult } from '../src/result-link.ts';
import { normalizeScore, type Scores, type Level } from '../src/scoring.ts';
import type { SavedResult } from '../src/result.ts';

const domains = ['O', 'C', 'E', 'A', 'N'] as const;
const versions: readonly string[] = RESULT_VERSIONS;
const levels: Level[] = ['low', 'medium', 'high'];
const prefix = 'e1_';
const aad = Buffer.from('bigfive-result-link:e1');

// The key lives beside SQLite in the persistent data volume, never in the client bundle.
export function loadResultCipher(filename: string) {
  let key: Buffer;
  if (filename === ':memory:') key = randomBytes(32);
  else {
    const keyFile = `${filename}.link-key`;
    if (!existsSync(keyFile)) {
      // Provision only new/unencrypted databases. Never replace the key of existing links.
      if (existsSync(filename)) {
        const existing = new DatabaseSync(filename, { readOnly: true });
        try {
          const columns = existing.prepare('PRAGMA table_info(results)').all();
          const encrypted = columns.some(column => column.name === 'result_link')
            && existing.prepare("SELECT 1 FROM results WHERE instr(result_link, '/results/view#e1_') > 0 LIMIT 1").get();
          const receipts = existing.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'submission_receipts'").get()
            && existing.prepare('SELECT 1 FROM submission_receipts LIMIT 1').get();
          if (encrypted || receipts) throw new Error(`已有加密结果但缺少密钥 ${keyFile}。请从备份恢复原密钥，禁止自动生成替代密钥。`);
        } finally { existing.close(); }
      }
      try { writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    key = readFileSync(keyFile);
  }
  const cipher = createResultCipher(key);
  // Verify every existing encrypted record before opening the store for writes.
  // Checking only one row would miss a database already containing mixed keys.
  if (filename !== ':memory:' && existsSync(filename)) {
    const existing = new DatabaseSync(filename, { readOnly: true });
    try {
      const columns = existing.prepare('PRAGMA table_info(results)').all();
      if (columns.some(column => column.name === 'result_link')) {
        const rows = existing.prepare("SELECT result_link FROM results WHERE instr(result_link, '/results/view#e1_') > 0");
        for (const row of rows.iterate()) {
          try { cipher.decrypt(new URL(String(row.result_link), 'http://localhost').hash.slice(1)); }
          catch { throw new Error('密钥与已有加密结果不匹配，或已有链接损坏。请恢复配套的数据库与原密钥，已停止启动。'); }
        }
      }
    } finally { existing.close(); }
  }
  return cipher;
}

export function createResultCipher(key: Buffer) {
  if (key.length !== 32) throw new Error('结果链接加密密钥必须为 32 字节。');
  function withToken(result: SavedResult, token: string, base: string): SavedResult {
    const relativePath = `/results/view#${token}`;
    return { ...result, id: token, relativePath, shareUrl: `${base}${relativePath}` };
  }
  function encrypt(scores: Scores, assessmentId: string, base = ''): SavedResult {
    const result = decodeResult(encodeResult(scores, assessmentId));
    const version = versions.indexOf(assessmentId);
    if (version < 0) throw new Error('不支持的量表版本。');
    const values: number[] = [];
    let bits = 0;
    let bitCount = 0;
    function put(value: number, width: number) {
      bits = (bits << width) | value;
      bitCount += width;
      while (bitCount >= 8) { bitCount -= 8; values.push((bits >> bitCount) & 255); }
      bits &= (1 << bitCount) - 1;
    }
    for (const domain of domains) {
      const d = result.scores[domain];
      if (version === 2) { put(d.rawScore, 6); put(d.score, 7); put(levels.indexOf(d.level), 2); }
      else for (const facet of d.facets!) put(facet.rawScore - (version === 3 ? 2 : 4), version === 3 ? 4 : 5);
    }
    if (bitCount) values.push((bits << (8 - bitCount)) & 255);
    const plaintext = Buffer.from([version, ...values]);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const token = prefix + Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64url');
    return withToken(result, token, base);
  }
  function decrypt(token: string, base = ''): SavedResult {
    if (!token.startsWith(prefix)) {
      const legacy = decodeResult(token);
      return encrypt(legacy.scores, legacy.assessmentId, base);
    }
    if (!/^e1_[A-Za-z0-9_-]{40,100}$/.test(token)) throw new Error('结果链接无效或已损坏。');
    const bytes = Buffer.from(token.slice(prefix.length), 'base64url');
    if (bytes.toString('base64url') !== token.slice(prefix.length)) throw new Error('结果链接无效或已损坏。');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(aad);
    decipher.setAuthTag(bytes.subarray(-16));
    const plain = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
    const version = plain[0]!;
    const assessmentId = versions[version];
    if (!assessmentId || plain.length !== (version === 2 ? 11 : version === 3 ? 16 : 20)) throw new Error('结果链接版本不正确。');
    let offset = 8;
    function take(width: number) {
      let value = 0;
      for (let i = 0; i < width; i++, offset++) value = (value << 1) | ((plain[offset >> 3]! >> (7 - offset % 8)) & 1);
      return value;
    }
    const facetCount = version === 3 ? 2 : 4;
    const domainCount = facetCount * 6;
    const scores = Object.fromEntries(domains.map(domain => {
      if (version === 2) return [domain, { rawScore: take(6), score: take(7), level: levels[take(2)] }];
      const facets = Array.from({ length: 6 }, (_, i) => {
        const rawScore = take(version === 3 ? 4 : 5) + facetCount;
        return { facet: i + 1, rawScore, count: facetCount, score: normalizeScore(rawScore, facetCount), level: (rawScore < facetCount * 3 ? 'low' : rawScore > facetCount * 3 ? 'high' : 'medium') as Level };
      });
      const rawScore = facets.reduce((sum, f) => sum + f.rawScore, 0);
      return [domain, { rawScore, count: domainCount, score: normalizeScore(rawScore, domainCount), level: rawScore < domainCount * 3 ? 'low' : rawScore > domainCount * 3 ? 'high' : 'medium', facets }];
    })) as Scores;
    return withToken(decodeResult(encodeResult(scores, assessmentId)), token, base);
  }
  return { encrypt, decrypt };
}
