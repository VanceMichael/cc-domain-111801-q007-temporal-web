import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export class Archive {
  constructor(directory) { this.directory = directory; }
  async start() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    this.database = new DatabaseSync(join(this.directory, 'receipts.sqlite'));
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
    this.database.exec(`CREATE TABLE IF NOT EXISTS evidence (
      digest TEXT PRIMARY KEY, location TEXT NOT NULL, observed_at TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (
      scope TEXT NOT NULL, business_key TEXT NOT NULL, digest TEXT NOT NULL, record TEXT NOT NULL,
      decision TEXT NOT NULL, PRIMARY KEY(scope,business_key,digest));
      CREATE TABLE IF NOT EXISTS history_negotiations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL, business_key TEXT NOT NULL, kind TEXT NOT NULL,
      requested_at TEXT NOT NULL, retrieved_at TEXT, source TEXT NOT NULL,
      outcome TEXT NOT NULL, digest TEXT, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history_packages (
      scope TEXT NOT NULL, business_key TEXT NOT NULL, package TEXT NOT NULL,
      PRIMARY KEY(scope,business_key));`);
    return this;
  }
  async preserve(document) {
    const digest = createHash('sha256').update(document.bytes).digest('hex');
    const destination = join(this.directory, 'objects', digest);
    const temporary = destination + '.' + process.pid + '.' + crypto.randomUUID();
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(document.bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, destination);
    this.database.prepare('INSERT OR IGNORE INTO evidence VALUES(?,?,?,?)').run(digest, document.location, document.observedAt, document.bytes.length);
    return digest;
  }
  put(scope, key, digest, record, decision) {
    if (!this.database.prepare('SELECT digest FROM evidence WHERE digest=?').get(digest)) throw new Error('原文尚未保存');
    this.database.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?,?,?,?)').run(scope, key, digest, JSON.stringify(record), JSON.stringify(decision));
  }
  records(scope) {
    return this.database.prepare('SELECT * FROM receipts WHERE scope=? ORDER BY business_key,digest').all(scope).map(row => ({ ...row, record: JSON.parse(row.record), decision: JSON.parse(row.decision) }));
  }
  // 历史协商轨迹只追加：每次协商（含失败）都留痕，不修改、不删除既有的任何原件或结论。
  recordNegotiation(scope, key, kind, entry) {
    this.database.prepare(
      'INSERT INTO history_negotiations(scope,business_key,kind,requested_at,retrieved_at,source,outcome,digest,detail) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(
      scope, key, kind,
      entry.gate?.requestedAt ?? entry.requestedAt ?? new Date().toISOString(),
      entry.retrievedAt ?? null,
      entry.source,
      entry.status,
      entry.digest ?? null,
      JSON.stringify(entry),
    );
  }
  negotiations(scope, key) {
    return this.database.prepare(
      'SELECT * FROM history_negotiations WHERE scope=? AND business_key=? ORDER BY id'
    ).all(scope, key).map(row => ({ ...row, detail: JSON.parse(row.detail) }));
  }
  // 历史包按业务身份落库；已存在的包不被一次失败的重新协商覆盖，需要新身份才能另存。
  savePackage(scope, key, pkg) {
    this.database.prepare('INSERT OR IGNORE INTO history_packages VALUES(?,?,?)').run(scope, key, JSON.stringify(pkg));
    return this.database.changes > 0;
  }
  package(scope, key) {
    const row = this.database.prepare('SELECT package FROM history_packages WHERE scope=? AND business_key=?').get(scope, key);
    return row ? JSON.parse(row.package) : null;
  }
  packages(scope) {
    return this.database.prepare('SELECT * FROM history_packages WHERE scope=? ORDER BY business_key').all(scope).map(row => ({ ...row, package: JSON.parse(row.package) }));
  }
  async original(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('原文摘要无效');
    const content = await readFile(join(this.directory, 'objects', digest));
    if (createHash('sha256').update(content).digest('hex') !== digest) throw new Error('原文完整性校验失败');
    return content;
  }
  close() { this.database?.close(); }
}
