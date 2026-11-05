import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  sqlite: DatabaseSync;
  private depth = 0;
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','committee','student')),finance_manage INTEGER NOT NULL DEFAULT 0,must_change_password INTEGER NOT NULL DEFAULT 1,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,profile TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('homework','affairs')),title TEXT NOT NULL,course TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',deadline TEXT,allow_late INTEGER NOT NULL DEFAULT 0,requires_submission INTEGER NOT NULL DEFAULT 1,attachment_required INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'draft',fields TEXT NOT NULL DEFAULT '[]',attachments TEXT NOT NULL DEFAULT '[]',author_id TEXT NOT NULL REFERENCES users(id),version INTEGER NOT NULL DEFAULT 1,snapshot_created INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS participants(task_id TEXT NOT NULL REFERENCES tasks(id),user_id TEXT NOT NULL REFERENCES users(id),status TEXT NOT NULL DEFAULT 'required',PRIMARY KEY(task_id,user_id));
      CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),user_id TEXT NOT NULL REFERENCES users(id),text TEXT NOT NULL DEFAULT '',answers TEXT NOT NULL DEFAULT '{}',attachments TEXT NOT NULL DEFAULT '[]',schema_snapshot TEXT NOT NULL DEFAULT '[]',task_title TEXT NOT NULL,late INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL,created_at TEXT NOT NULL,UNIQUE(task_id,user_id,version));
      CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',category TEXT NOT NULL DEFAULT '学习资料',url TEXT NOT NULL DEFAULT '',attachments TEXT NOT NULL DEFAULT '[]',pinned INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'published',version INTEGER NOT NULL DEFAULT 1,author_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resource_versions(id TEXT PRIMARY KEY,resource_id TEXT NOT NULL REFERENCES resources(id),data TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,UNIQUE(resource_id,version));
      CREATE TABLE IF NOT EXISTS timetable_templates(id TEXT PRIMARY KEY,effective_date TEXT NOT NULL UNIQUE,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS timetable_exceptions(id TEXT PRIMARY KEY,date TEXT NOT NULL,course_id TEXT NOT NULL,action TEXT NOT NULL,course TEXT,created_at TEXT NOT NULL,UNIQUE(date,course_id));
      CREATE TABLE IF NOT EXISTS fees(id TEXT PRIMARY KEY,title TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>0),deadline TEXT,user_ids TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY,fee_id TEXT NOT NULL REFERENCES fees(id),user_id TEXT NOT NULL REFERENCES users(id),amount INTEGER NOT NULL CHECK(amount>0),date TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',receipt_ids TEXT NOT NULL DEFAULT '[]',version INTEGER NOT NULL DEFAULT 1,voided INTEGER NOT NULL DEFAULT 0,idempotency_key TEXT NOT NULL UNIQUE,author_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS finance_entries(id TEXT PRIMARY KEY,type TEXT NOT NULL CHECK(type IN ('opening','income','expense')),amount INTEGER NOT NULL CHECK(amount>=0),category TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',date TEXT NOT NULL,receipt_ids TEXT NOT NULL DEFAULT '[]',public_receipt INTEGER NOT NULL DEFAULT 0,payment_id TEXT UNIQUE REFERENCES payments(id),voided INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,idempotency_key TEXT UNIQUE,author_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS finance_versions(id TEXT PRIMARY KEY,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL,reason TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,name TEXT NOT NULL,size INTEGER NOT NULL,mime TEXT NOT NULL,object_key TEXT NOT NULL UNIQUE,purpose TEXT NOT NULL,entity_id TEXT,owner_id TEXT NOT NULL REFERENCES users(id),status TEXT NOT NULL DEFAULT 'pending',scope TEXT,created_at TEXT NOT NULL,expires_at TEXT);
      CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,actor_id TEXT REFERENCES users(id),action TEXT NOT NULL,entity_id TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS submissions_task ON submissions(task_id,user_id,version);
      CREATE INDEX IF NOT EXISTS files_entity ON files(entity_id,purpose);
      INSERT OR IGNORE INTO migrations VALUES(1,datetime('now'));
    `);
  }
  get<T = any>(sql: string, ...params: any[]): T | undefined { return this.sqlite.prepare(sql).get(...params) as T | undefined; }
  all<T = any>(sql: string, ...params: any[]): T[] { return this.sqlite.prepare(sql).all(...params) as T[]; }
  run(sql: string, ...params: any[]) { return this.sqlite.prepare(sql).run(...params); }
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.sqlite.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const result = fn(); this.sqlite.exec('COMMIT'); return result; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
    finally { this.depth--; }
  }
  setting<T>(key: string, fallback: T): T { const row = this.get<{value:string}>('SELECT value FROM settings WHERE key=?', key); return row ? JSON.parse(row.value) as T : fallback; }
  setSetting(key: string, value: unknown) { this.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value)); }
  audit(actorId: string | null, action: string, entityId: string, details: unknown) { this.run('INSERT INTO audit VALUES(?,?,?,?,?,?)', randomUUID(), actorId, action, entityId, JSON.stringify(details), new Date().toISOString()); }
  close() { this.sqlite.close(); }
}
export const createStore = (path = ':memory:') => new Store(path);
