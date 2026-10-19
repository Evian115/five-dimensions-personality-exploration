import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { DingtalkDelivery, createDingtalkClient } from './dingtalk.ts';
import { DingtalkError } from './dingtalk.ts';

export interface DingtalkJob extends DingtalkDelivery { result_id: number; attempts: number; lease_token: string; }
export function createDingtalkOutbox(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS dingtalk_outbox (
    result_id INTEGER PRIMARY KEY REFERENCES results(id) ON DELETE CASCADE,
    client_token TEXT NOT NULL UNIQUE,
    base_id TEXT NOT NULL,
    sheet_id TEXT NOT NULL,
    share_url TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    record_id TEXT,
    synced_at TEXT,
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS dingtalk_outbox_pending_idx ON dingtalk_outbox(next_attempt_at, lease_until) WHERE synced_at IS NULL;`);
  return {
    // Called only inside the result + receipt submission transaction.
    enqueue(resultId: number | bigint, clientToken: string, baseId: string, sheetId: string, shareUrl: string) {
      db.prepare('INSERT INTO dingtalk_outbox (result_id, client_token, base_id, sheet_id, share_url) VALUES (?, ?, ?, ?, ?)')
        .run(resultId, clientToken, baseId, sheetId, shareUrl);
    },
    claim(now = Date.now()): DingtalkJob | undefined {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare(`SELECT o.*, r.openness, r.conscientiousness, r.extraversion, r.agreeableness, r.neuroticism, r.created_at, r.updated_at
          FROM dingtalk_outbox o JOIN results r ON r.id = o.result_id
          WHERE o.synced_at IS NULL AND o.next_attempt_at <= ? AND o.lease_until <= ? ORDER BY o.result_id LIMIT 1`).get(now, now);
        if (!row) { db.exec('COMMIT'); return; }
        const lease = randomUUID();
        db.prepare('UPDATE dingtalk_outbox SET attempts = attempts + 1, lease_until = ?, lease_token = ? WHERE result_id = ?')
          .run(now + 60000, lease, row.result_id as number);
        db.exec('COMMIT');
        return { ...row, attempts: Number(row.attempts) + 1, lease_token: lease } as unknown as DingtalkJob;
      } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
    },
    delivered(job: DingtalkJob, recordId: string, now = Date.now()) {
      db.prepare('UPDATE dingtalk_outbox SET record_id = ?, synced_at = ?, lease_until = 0, lease_token = NULL, last_error = NULL WHERE result_id = ? AND lease_token = ?')
        .run(recordId, new Date(now).toISOString(), job.result_id, job.lease_token);
    },
    failed(job: DingtalkJob, code: string, now = Date.now()) {
      const delay = Math.min(300000, 10000 * 2 ** Math.min(job.attempts - 1, 5));
      db.prepare('UPDATE dingtalk_outbox SET next_attempt_at = ?, lease_until = 0, lease_token = NULL, last_error = ? WHERE result_id = ? AND lease_token = ?')
        .run(now + delay, code, job.result_id, job.lease_token);
    },
  };
}

export function createDingtalkSynchronizer(
  outbox: ReturnType<typeof createDingtalkOutbox>, client: Pick<ReturnType<typeof createDingtalkClient>, 'insert'>,
  options: { pollMs?: number; log?: (message: string) => void } = {},
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  const controller = new AbortController();
  const log = options.log ?? console.error;
  function schedule(delay: number) {
    if (stopped || running) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      running = drain().catch(() => { if (!stopped) log('钉钉同步队列暂时不可用，稍后重试。'); })
        .finally(() => { running = undefined; schedule(options.pollMs ?? 5000); });
    }, delay);
    timer.unref();
  }
  async function drain() {
    for (let i = 0; i < 10 && !stopped; i++) {
      const job = outbox.claim();
      if (!job) return;
      try { outbox.delivered(job, await client.insert(job, controller.signal)); }
      catch (error) {
        const code = error instanceof DingtalkError ? error.code : 'RequestFailed';
        outbox.failed(job, code);
        if (!stopped) log(`钉钉同步尚未完成，已保留任务并安排重试（${code}）。`);
      }
    }
  }
  return {
    wake() { schedule(0); },
    async stop() { stopped = true; clearTimeout(timer); controller.abort(); await running; },
  };
}
