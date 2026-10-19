import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { isSubmissionId } from '../src/submission-id.ts';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { ASSESSMENT, QUESTIONS, calculateAllScores, isValidAnswer, type Answers } from '../src/index.ts';
import { encodeResult } from '../src/result-link.ts';
import type { Scores } from '../src/scoring.ts';
import type { SavedResult } from '../src/result.ts';
import { loadResultCipher } from './result-cipher.ts';

export class RequestError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export function createResultStore(filename: string, baseUrl = '') {
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
  const schema = `CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    result_json TEXT NOT NULL,
    result_link TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  const columns = db.prepare('PRAGMA table_info(results)').all();
  const hasSequence = columns.some(column => column.name === 'id' && column.type === 'INTEGER' && column.pk === 1);
  if (columns.length && !hasSequence) {
    if (filename !== ':memory:') {
      const backupDirectory = join(dirname(filename), 'backups');
      mkdirSync(backupDirectory, { recursive: true });
      const backupFile = join(backupDirectory, `${basename(filename)}.before-sequence-id-${Date.now()}.sqlite`);
      db.exec(`VACUUM INTO '${backupFile.replaceAll("'", "''")}'`);
    }
    const rows = db.prepare('SELECT * FROM results ORDER BY created_at, rowid').all();
    const migrated = rows.map(row => {
      const value = row.result_json ? JSON.parse(String(row.result_json)) : {
        assessmentId: String(row.assessment_id || 'ipip-50-v1'),
        scores: JSON.parse(String(row.scores_json)) as Scores,
      };
      if (!row.result_json) legacyLinks[String(row.id)] = encodeResult(value.scores, value.assessmentId);
      return {
        json: row.result_json ? String(row.result_json) : JSON.stringify(value),
        link: row.result_link ? String(row.result_link) : cipher.encrypt(value.scores, value.assessmentId, base).shareUrl,
        created: String(row.created_at),
        updated: String(row.updated_at ?? row.created_at),
      };
    });
    // Compatibility mappings contain only old IDs and result tokens.
    if (filename !== ':memory:' && columns.some(column => column.name === 'scores_json')) writeFileSync(mappingFile, JSON.stringify(legacyLinks));
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('ALTER TABLE results RENAME TO results_before_sequence');
      db.exec(schema);
      const insert = db.prepare('INSERT INTO results (result_json, result_link, created_at, updated_at) VALUES (?, ?, ?, ?)');
      for (const row of migrated) insert.run(row.json, row.link, row.created, row.updated);
      db.exec('DROP TABLE results_before_sequence; COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  db.exec(schema);
  // Technical receipts are separate from the five-field submission record.
  db.exec(`CREATE TABLE IF NOT EXISTS submission_receipts (
    request_id TEXT PRIMARY KEY,
    request_fingerprint TEXT NOT NULL,
    result_id INTEGER NOT NULL REFERENCES results(id) ON DELETE CASCADE
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS submission_receipts_result_idx ON submission_receipts(result_id);`);
  // Upgrade stored links by record ID without combining submissions or changing timestamps.
  const updateLink = db.prepare('UPDATE results SET result_link = ? WHERE id = ?');
  for (const row of db.prepare('SELECT id, result_json, result_link FROM results').all()) {
    if (String(row.result_link).includes('/results/view#e1_')) continue;
    const value = JSON.parse(String(row.result_json));
    updateLink.run(cipher.encrypt(value.scores, value.assessmentId, base).shareUrl, row.id as number);
  }



  return {
    create(payload: unknown): SavedResult {
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
        const scores = calculateAllScores(normalized);
        const resultJson = JSON.stringify({ assessmentId: ASSESSMENT.id, scores });
        const now = new Date().toISOString();
        const result = cipher.encrypt(scores, ASSESSMENT.id, base);
        const inserted = db.prepare('INSERT INTO results (result_json, created_at, updated_at, result_link) VALUES (?, ?, ?, ?)')
          .run(resultJson, now, now, result.shareUrl);
        db.prepare('INSERT INTO submission_receipts (request_id, request_fingerprint, result_id) VALUES (?, ?, ?)')
          .run(requestId, fingerprint, inserted.lastInsertRowid);
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
