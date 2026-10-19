import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, copyFileSync, chmodSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { encodeResult } from '../src/result-link.ts';
import type { Scores } from '../src/scoring.ts';
import type { loadResultCipher } from './result-cipher.ts';

export const scoreColumns = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'] as const;
const domains = ['O', 'C', 'E', 'A', 'N'] as const;

export function scoreValues(scores: unknown): number[] {
  if (!scores || typeof scores !== 'object') throw new Error('历史结果缺少五维分数，迁移已停止。');
  return domains.map(domain => {
    const value = (scores as Record<string, { score?: unknown }>)[domain]?.score;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
      throw new Error(`历史结果 ${domain} 的分数无效，迁移已停止。`);
    }
    return value;
  });
}

const schema = `CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ${scoreColumns.map(column => `${column} INTEGER NOT NULL CHECK (typeof(${column}) = 'integer' AND ${column} BETWEEN 0 AND 100)`).join(',\n  ')},
  result_link TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

/** One-time schema migration; normal startup and result decoding never rewrite records. */
export function initializeResults(
  db: DatabaseSync, filename: string, cipher: ReturnType<typeof loadResultCipher>, base: string,
  legacyLinks: Record<string, string>, mappingFile: string,
) {
  const columns = () => db.prepare('PRAGMA table_info(results)').all();
  const needsMigration = () => {
    const info = columns();
    if (!info.length) return false;
    const hasSequence = info.some(column => column.name === 'id' && column.type === 'INTEGER' && column.pk === 1);
    return !hasSequence || info.some(column => column.name === 'result_json' || column.name === 'scores_json');
  };
  if (!needsMigration()) { db.exec(schema); return; }

  if (filename !== ':memory:') {
    const directory = join(dirname(filename), 'backups');
    mkdirSync(directory, { recursive: true });
    const backup = join(directory, `${basename(filename)}.before-domain-scores-${Date.now()}-${randomUUID()}.sqlite`);
    db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    chmodSync(backup, 0o600);
    for (const suffix of ['.link-key', '.legacy-links.json']) {
      if (!existsSync(filename + suffix)) continue;
      copyFileSync(filename + suffix, backup + suffix);
      chmodSync(backup + suffix, 0o600);
    }
  }
  // Rebuild the parent table without renaming the old parent: receipt foreign keys
  // must continue to reference results, and dropping it must not cascade-delete them.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      // A second process may have completed this migration while we waited for the lock.
      if (!needsMigration()) { db.exec('COMMIT'); return; }
      const hasSequence = columns().some(column => column.name === 'id' && column.type === 'INTEGER' && column.pk === 1);
      const hasSequenceTable = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get();
      const oldSequence = hasSequence && hasSequenceTable ? db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'results'").get()?.seq : 0;
      const rows = db.prepare(`SELECT * FROM results ORDER BY ${hasSequence ? 'id' : 'created_at, rowid'}`).all();
      const dependents = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'results' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all();
      db.exec(schema.replace('results (', 'results_next ('));
      const insert = db.prepare(`INSERT INTO results_next (id, ${scoreColumns.join(', ')}, result_link, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      let mappingChanged = false;
      for (const [index, row] of rows.entries()) {
        const value = row.result_json ? JSON.parse(String(row.result_json)) : {
          assessmentId: String(row.assessment_id || 'ipip-50-v1'),
          scores: JSON.parse(String(row.scores_json)) as Scores,
        };
        const values = scoreValues(value.scores);
        const link = row.result_link ? String(row.result_link) : cipher.encrypt(value.scores, value.assessmentId, base).shareUrl;
        if (!row.result_json) {
          legacyLinks[String(row.id)] = encodeResult(value.scores, value.assessmentId);
          mappingChanged = true;
        }
        insert.run(hasSequence ? row.id! : index + 1, ...values, link, String(row.created_at), String(row.updated_at ?? row.created_at));
      }
      db.exec('DROP TABLE results; ALTER TABLE results_next RENAME TO results');
      // Preserve the high-water mark even when the largest prior IDs were deleted.
      if (typeof oldSequence === 'number' && oldSequence > 0) {
        const current = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'results'").get();
        if (current) db.prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'results'").run(oldSequence);
        else db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('results', ?)").run(oldSequence);
      }
      for (const dependent of dependents) db.exec(String(dependent.sql));
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('迁移后的提交回执关联异常，已停止迁移。');
      if (mappingChanged && filename !== ':memory:') {
        const temporary = `${mappingFile}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify(legacyLinks), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, mappingFile);
      }
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  } finally { db.exec('PRAGMA foreign_keys = ON'); }
}
