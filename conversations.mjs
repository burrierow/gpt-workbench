import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function identity(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f]/.test(value)) {
    throw new Error('需要有效的' + name);
  }
  return value;
}

export function conversationKey(source, scope, conversation) {
  return createHash('sha256').update(JSON.stringify([
    source, identity(scope, '来源账号或工作区标识'), identity(conversation, '来源会话标识'),
  ])).digest('hex');
}

export class Conversations {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS conversations (
        key TEXT PRIMARY KEY,
        thread_id TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        sequence INTEGER PRIMARY KEY,
        conversation TEXT NOT NULL REFERENCES conversations(key),
        event TEXT NOT NULL,
        job_id TEXT NOT NULL UNIQUE,
        takeover INTEGER NOT NULL,
        finished INTEGER NOT NULL DEFAULT 0,
        UNIQUE (conversation, event)
      );
      CREATE INDEX IF NOT EXISTS pending_messages
        ON messages (conversation, sequence) WHERE finished = 0;
    `);
  }

  state(key) {
    const row = this.db.prepare('SELECT thread_id AS threadId FROM conversations WHERE key = ?').get(key);
    if (row?.threadId) return { state: 'bound', threadId: row.threadId };
    const queued = this.db.prepare('SELECT 1 FROM messages WHERE conversation = ? AND takeover = 1 AND finished = 0')
      .get(key);
    return { state: queued ? 'pending' : 'unbound' };
  }

  find(key, event) {
    const eventKey = createHash('sha256').update(identity(event, '来源消息标识')).digest('hex');
    return this.db.prepare('SELECT job_id AS id FROM messages WHERE conversation = ? AND event = ?')
      .get(key, eventKey)?.id;
  }

  enqueue(key, event, jobId, takeover) {
    identity(event, '来源消息标识');
    const eventKey = createHash('sha256').update(event).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT job_id AS id FROM messages WHERE conversation = ? AND event = ?')
        .get(key, eventKey);
      if (existing) {
        this.db.exec('COMMIT');
        return existing.id;
      }
      const current = this.state(key);
      if (!takeover && current.state === 'unbound') {
        throw new Error('来源会话尚未接管，请先提交明确授权的首轮派单');
      }
      this.db.prepare('INSERT OR IGNORE INTO conversations (key) VALUES (?)').run(key);
      this.db.prepare('INSERT INTO messages (conversation, event, job_id, takeover) VALUES (?, ?, ?, ?)')
        .run(key, eventKey, jobId, Number(takeover));
      this.db.exec('COMMIT');
      return jobId;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  hasJob(id) {
    return Boolean(this.db.prepare('SELECT 1 FROM messages WHERE job_id = ?').get(id));
  }

  heads() {
    return this.db.prepare(`
      SELECT m.job_id AS id, m.conversation, m.takeover
      FROM messages m
      WHERE m.sequence IN (SELECT MIN(sequence) FROM messages WHERE finished = 0 GROUP BY conversation)
      ORDER BY m.sequence
    `).all();
  }

  bind(key, threadId) {
    const result = this.db.prepare(`
      UPDATE conversations SET thread_id = ?
      WHERE key = ? AND (thread_id IS NULL OR thread_id = ?)
    `).run(threadId, key, threadId);
    if (result.changes !== 1) throw new Error('GPT 会话绑定不一致');
  }

  finish(id) {
    this.db.prepare('UPDATE messages SET finished = 1 WHERE job_id = ? AND finished = 0').run(id);
  }

  close() {
    this.db.close();
  }
}
