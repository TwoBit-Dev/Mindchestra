import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class SqliteDatabase {
  readonly connection: DatabaseSync;
  readonly dbPath: string;
  private txDepth = 0;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.connection = new DatabaseSync(dbPath);
    this.connection.exec('PRAGMA journal_mode = WAL;');
    this.connection.exec('PRAGMA synchronous = NORMAL;');
    this.connection.exec('PRAGMA foreign_keys = ON;');
    this.connection.exec('PRAGMA busy_timeout = 5000;');
  }

  transaction<T>(fn: () => T): T {
    const isRoot = this.txDepth === 0;
    const savepointName = `sp_${this.txDepth}`;
    if (isRoot) {
      this.connection.exec('BEGIN IMMEDIATE;');
    } else {
      this.connection.exec(`SAVEPOINT ${savepointName};`);
    }
    this.txDepth += 1;
    try {
      const result = fn();
      this.txDepth -= 1;
      if (isRoot) {
        this.connection.exec('COMMIT;');
      } else {
        this.connection.exec(`RELEASE SAVEPOINT ${savepointName};`);
      }
      return result;
    } catch (error) {
      this.txDepth -= 1;
      if (isRoot) {
        try {
          this.connection.exec('ROLLBACK;');
        } catch {
          
        }
      } else {
        try {
          this.connection.exec(`ROLLBACK TO SAVEPOINT ${savepointName};`);
          this.connection.exec(`RELEASE SAVEPOINT ${savepointName};`);
        } catch {
          
        }
      }
      throw error;
    }
  }

  close(): void {
    this.connection.close();
  }
}
