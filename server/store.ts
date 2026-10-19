import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { isSubmissionId } from '../src/submission-id.ts';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ASSESSMENT, QUESTIONS, calculateAllScores, isValidAnswer, type Answers } from '../src/index.ts';
import type { SavedResult } from '../src/result.ts';
import { loadResultCipher } from './result-cipher.ts';
import { initializeResults, scoreColumns, scoreValues } from './result-schema.ts';
import { createDingtalkOutbox } from './dingtalk-outbox.ts';

export class RequestError extends Error {
  status: number;
  retryAfter?: number;
  constructor(message: string, status = 400, retryAfter?: number) { super(message); this.status = status; this.retryAfter = retryAfter; }
}

export function createResultStore(filename: string, baseUrl = '', dingtalk?: { baseId: string; sheetId: string; maxPending?: number }) {
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
      throw new Error('BASE_URL 必须是有效的 http 或 https 网页地址。');
    }
  }
  const base = baseUrl.replace(/\/+$/, '');
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const cipher = loadResultCipher(filename);
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
  const mappingFile = `${filename}.legacy-links.json`;
  const legacyLinks: Record<string, string> = filename !== ':memory:' && existsSync(mappingFile)
    ? JSON.parse(readFileSync(mappingFile, 'utf8')) : {};
  try { initializeResults(db, filename, cipher, base, legacyLinks, mappingFile); }
  catch (error) { db.close(); throw error; }
  // Technical receipts are separate from the five domain scores and submission metadata.
  db.exec(`CREATE TABLE IF NOT EXISTS submission_receipts (
    request_id TEXT PRIMARY KEY,
    request_fingerprint TEXT NOT NULL,
    result_id INTEGER NOT NULL REFERENCES results(id) ON DELETE CASCADE
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS submission_receipts_result_idx ON submission_receipts(result_id);`);
  const outbox = createDingtalkOutbox(db);
  return {
    outbox,
    create(payload: unknown, shareOrigin?: string, beforeInsert?: () => void): SavedResult {
      if (!payload || typeof payload !== 'object') throw new RequestError('提交内容格式不正确。');
      const { answers, submissionId, assessmentId } = payload as Record<string, unknown>;
      if (assessmentId !== undefined && assessmentId !== ASSESSMENT.id) throw new RequestError('题库版本已更新，请刷新后重新作答。', 409);
      if (!isSubmissionId(submissionId)) {
        throw new RequestError('提交编号不正确。');
      }
      if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length !== QUESTIONS.length) {
        throw new RequestError(`请完成全部 ${QUESTIONS.length} 道题后提交。`);
      }
      const normalized: Answers = {};
      for (const q of QUESTIONS) {
        const value = (answers as Record<number, unknown>)[q.id];
        if (!isValidAnswer(value)) throw new RequestError(`第 ${q.id} 题的答案不正确。`);
        normalized[q.id] = value;
      }
      const requestId = submissionId.toLowerCase();
      const fingerprint = createHash('sha256').update(JSON.stringify({ assessmentId: ASSESSMENT.id, answers: normalized })).digest('hex');
      // Serialize the lookup and both writes across connections; never deduplicate by score.
      db.exec('BEGIN IMMEDIATE');
      try {
        const receipt = db.prepare('SELECT request_fingerprint, result_id FROM submission_receipts WHERE request_id = ?').get(requestId);
        if (receipt) {
          if (receipt.request_fingerprint !== fingerprint) throw new RequestError('该提交编号已用于其他答案，请重新开始测评。', 409);
          const row = db.prepare('SELECT result_link FROM results WHERE id = ?').get(receipt.result_id as number);
          if (!row) throw new RequestError('该提交记录已被清除，请重新开始测评。', 410);
          const link = String(row.result_link);
          const token = new URL(link, 'http://localhost').hash.slice(1);
          const result = { ...cipher.decrypt(token, base), shareUrl: link };
          db.exec('COMMIT');
          return result;
        }
        if (dingtalk && db.prepare('SELECT 1 FROM dingtalk_outbox WHERE synced_at IS NULL LIMIT 1 OFFSET ?').get((dingtalk.maxPending ?? 500) - 1)) {
          throw new RequestError('同步任务较多，请稍后重新提交，答案会保留。', 503, 30);
        }
        beforeInsert?.();
        const scores = calculateAllScores(normalized);
        const now = new Date().toISOString();
        const result = cipher.encrypt(scores, ASSESSMENT.id, base);
        const inserted = db.prepare(`INSERT INTO results (${scoreColumns.join(', ')}, result_link, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(...scoreValues(scores), result.shareUrl, now, now);
        db.prepare('INSERT INTO submission_receipts (request_id, request_fingerprint, result_id) VALUES (?, ?, ?)')
          .run(requestId, fingerprint, inserted.lastInsertRowid);
        if (dingtalk) {
          const shareUrl = new URL(result.shareUrl, base || shareOrigin).href;
          if (!/^https?:\/\//.test(shareUrl)) throw new RequestError('结果分享地址不正确。');
          outbox.enqueue(inserted.lastInsertRowid, requestId, dingtalk.baseId, dingtalk.sheetId, shareUrl);
        }
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    get(id: string): SavedResult | undefined {
      if (!Object.hasOwn(legacyLinks, id)) return undefined;
      return cipher.decrypt(legacyLinks[id]!, base);
    },
    decode(token: unknown): SavedResult {
      if (typeof token !== 'string' || token.length > 2048) throw new RequestError('结果链接格式不正确。');
      try { return cipher.decrypt(token, base); }
      catch { throw new RequestError('结果链接无效、已被修改，或无法使用当前密钥解密。'); }
    },
    close() { db.close(); },
  };
}
