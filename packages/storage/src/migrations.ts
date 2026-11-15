import type { SqliteDatabase } from './database.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        spec_json TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        base_commit TEXT,
        parent_mission_id TEXT,
        last_seq INTEGER NOT NULL DEFAULT 0,
        retained_from_seq INTEGER NOT NULL DEFAULT 1,
        result_json TEXT,
        pending_approval_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_missions_status_created ON missions(status, created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        session_id TEXT,
        usage_json TEXT,
        summary TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_runs_mission ON runs(mission_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_runs_agent_status ON runs(agent_id, status);

      CREATE TABLE IF NOT EXISTS events (
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL UNIQUE,
        actor TEXT NOT NULL,
        type TEXT NOT NULL,
        run_id TEXT,
        correlation_id TEXT NOT NULL,
        causation_id TEXT,
        at TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        chain_hash TEXT NOT NULL,
        PRIMARY KEY (mission_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_events_mission_seq ON events(mission_id, seq);

      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        supersedes_id TEXT,
        confidence REAL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_claims_mission ON claims(mission_id, created_at);

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        claim_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        relation TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        artifact_id TEXT,
        sha256 TEXT,
        provenance TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_evidence_mission_claim ON evidence(mission_id, claim_id);

      CREATE TABLE IF NOT EXISTS verdicts (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        rubric_id TEXT NOT NULL,
        score REAL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_verdicts_mission ON verdicts(mission_id, created_at);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        sender_run_id TEXT NOT NULL,
        recipient_agent_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_mission ON messages(mission_id, created_at);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        run_id TEXT,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        risk TEXT NOT NULL,
        action_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        decision_json TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_approvals_mission_status ON approvals(mission_id, status);

      CREATE TABLE IF NOT EXISTS tool_grants (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        schema_hash TEXT NOT NULL,
        access TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        max_calls INTEGER NOT NULL,
        calls_used INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tool_grants_lookup ON tool_grants(mission_id, agent_id, server_id, tool_name);

      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        approval_id TEXT,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tool_calls_mission ON tool_calls(mission_id, created_at);

      CREATE TABLE IF NOT EXISTS agent_configs (
        id TEXT PRIMARY KEY,
        adapter_id TEXT NOT NULL,
        config_json TEXT NOT NULL,
        probe_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        transport_kind TEXT NOT NULL,
        config_json TEXT NOT NULL,
        status TEXT NOT NULL,
        tools_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        canonical_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        caller_scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (caller_scope, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        blob_rel_path TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_mission ON artifacts(mission_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_artifacts_sha256 ON artifacts(sha256);
    `
  }
];

export function runMigrations(db: SqliteDatabase, targetMigrations: readonly Migration[] = MIGRATIONS): number[] {
  const applied: number[] = [];
  db.transaction(() => {
    db.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const existingRows = db.connection
      .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
      .all() as Array<{ version: number }>;
    const appliedSet = new Set(existingRows.map((row) => row.version));

    const sorted = [...targetMigrations].sort((a, b) => a.version - b.version);
    const insertStmt = db.connection.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
    );

    for (const migration of sorted) {
      if (appliedSet.has(migration.version)) {
        continue;
      }
      db.connection.exec(migration.sql);
      insertStmt.run(migration.version, migration.name, new Date().toISOString());
      applied.push(migration.version);
    }
  });
  return applied;
}

export function getAppliedMigrationVersions(db: SqliteDatabase): number[] {
  const rows = db.connection
    .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
    .all() as Array<{ version: number }>;
  return rows.map((row) => row.version);
}
