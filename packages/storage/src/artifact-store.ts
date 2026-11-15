import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ArtifactMetadataSchema,
  MindchestraError,
  sha256Hex,
  type ArtifactMetadata
} from '@mindchestra/contracts';
import type { SqliteDatabase } from './database.js';

export const DEFAULT_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
export const DEFAULT_RETENTION_DAYS = 30;

export interface PutArtifactInput {
  missionId: string;
  content: Buffer | string;
  contentType?: string;
  pinned?: boolean;
  retentionDays?: number;
  nowIso?: string;
}

export class ArtifactStore {
  private readonly rootDir: string;
  private readonly blobsDir: string;
  private readonly tmpDir: string;
  private readonly maxBytes: number;

  constructor(
    private readonly db: SqliteDatabase,
    storageRoot: string,
    options?: { maxArtifactBytes?: number }
  ) {
    mkdirSync(storageRoot, { recursive: true });
    this.rootDir = realpathSync(storageRoot);
    this.blobsDir = path.join(this.rootDir, 'blobs');
    this.tmpDir = path.join(this.rootDir, 'tmp');
    mkdirSync(this.blobsDir, { recursive: true });
    mkdirSync(this.tmpDir, { recursive: true });
    this.maxBytes = options?.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  }

  private assertSafeSubpath(targetPath: string, baseDir: string): string {
    const resolved = path.resolve(targetPath);
    if (!resolved.startsWith(baseDir + path.sep)) {
      throw new MindchestraError('FORBIDDEN', 'Path traversal rejected in artifact store');
    }
    return resolved;
  }

  putArtifact(input: PutArtifactInput): ArtifactMetadata {
    const buffer = typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : input.content;
    if (buffer.byteLength > this.maxBytes) {
      throw new MindchestraError('INVALID_INPUT', `Artifact exceeds size limit of ${this.maxBytes} bytes`);
    }

    const sha256 = sha256Hex(buffer);
    const prefix = sha256.slice(0, 2);
    const relPath = path.join(prefix, sha256);
    const blobSubdir = this.assertSafeSubpath(path.join(this.blobsDir, prefix), this.blobsDir);
    const finalBlobPath = this.assertSafeSubpath(path.join(this.blobsDir, relPath), this.blobsDir);
    mkdirSync(blobSubdir, { recursive: true });

    const tmpPath = this.assertSafeSubpath(path.join(this.tmpDir, `${randomUUID()}.tmp`), this.tmpDir);
    try {
      writeFileSync(tmpPath, buffer);
      const written = readFileSync(tmpPath);
      if (written.byteLength !== buffer.byteLength || sha256Hex(written) !== sha256) {
        throw new MindchestraError('INTERNAL', 'Artifact integrity check failed during staging');
      }
      renameSync(tmpPath, finalBlobPath);
    } catch (error) {
      rmSync(tmpPath, { force: true });
      throw error;
    }

    const nowDate = input.nowIso ? new Date(input.nowIso) : new Date();
    const createdAt = nowDate.toISOString();
    const retentionDays = input.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const expiresAt =
      retentionDays > 0
        ? new Date(nowDate.getTime() + retentionDays * 24 * 60 * 60 * 1000).toISOString()
        : undefined;

    const id = randomUUID();
    const contentType = input.contentType ?? 'application/octet-stream';
    const pinned = input.pinned ?? false;

    this.db.connection
      .prepare(
        `INSERT INTO artifacts (id, mission_id, sha256, size_bytes, content_type, blob_rel_path, pinned, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.missionId,
        sha256,
        buffer.byteLength,
        contentType,
        relPath,
        pinned ? 1 : 0,
        expiresAt ?? null,
        createdAt
      );

    return ArtifactMetadataSchema.parse({
      id,
      missionId: input.missionId,
      sha256,
      sizeBytes: buffer.byteLength,
      contentType,
      pinned,
      createdAt,
      ...(expiresAt ? { expiresAt } : {})
    });
  }

  getArtifactMetadata(artifactId: string): ArtifactMetadata {
    const row = this.db.connection
      .prepare(
        'SELECT id, mission_id, sha256, size_bytes, content_type, pinned, expires_at, created_at FROM artifacts WHERE id = ?'
      )
      .get(artifactId) as
      | {
          id: string;
          mission_id: string;
          sha256: string;
          size_bytes: number;
          content_type: string;
          pinned: number;
          expires_at: string | null;
          created_at: string;
        }
      | undefined;

    if (!row) {
      throw new MindchestraError('NOT_FOUND', `Artifact ${artifactId} not found`);
    }

    return ArtifactMetadataSchema.parse({
      id: row.id,
      missionId: row.mission_id,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
      contentType: row.content_type,
      pinned: row.pinned === 1,
      createdAt: row.created_at,
      ...(row.expires_at ? { expiresAt: row.expires_at } : {})
    });
  }

  readArtifactBlob(artifactId: string): { metadata: ArtifactMetadata; data: Buffer } {
    const row = this.db.connection
      .prepare('SELECT blob_rel_path FROM artifacts WHERE id = ?')
      .get(artifactId) as { blob_rel_path: string } | undefined;

    if (!row) {
      throw new MindchestraError('NOT_FOUND', `Artifact ${artifactId} not found`);
    }

    const metadata = this.getArtifactMetadata(artifactId);
    const fullPath = this.assertSafeSubpath(path.join(this.blobsDir, row.blob_rel_path), this.blobsDir);
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new MindchestraError('FORBIDDEN', 'Symlink or non-regular file rejected in artifact store');
    }

    const realFile = realpathSync(fullPath);
    if (!realFile.startsWith(this.blobsDir + path.sep)) {
      throw new MindchestraError('FORBIDDEN', 'Artifact symlink escape detected');
    }

    const data = readFileSync(realFile);
    if (sha256Hex(data) !== metadata.sha256) {
      throw new MindchestraError('CONFLICT', `Artifact ${artifactId} hash mismatch on disk`);
    }

    return { metadata, data };
  }

  verifyArtifactIntegrity(artifactId: string): { valid: boolean; expectedSha256: string; actualSha256?: string } {
    const row = this.db.connection
      .prepare('SELECT sha256, blob_rel_path FROM artifacts WHERE id = ?')
      .get(artifactId) as { sha256: string; blob_rel_path: string } | undefined;

    if (!row) {
      return { valid: false, expectedSha256: '' };
    }

    try {
      const fullPath = this.assertSafeSubpath(path.join(this.blobsDir, row.blob_rel_path), this.blobsDir);
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return { valid: false, expectedSha256: row.sha256 };
      }
      const data = readFileSync(fullPath);
      const actualSha256 = sha256Hex(data);
      return {
        valid: actualSha256 === row.sha256,
        expectedSha256: row.sha256,
        actualSha256
      };
    } catch {
      return { valid: false, expectedSha256: row.sha256 };
    }
  }

  listArtifactsByMission(missionId: string, limit = 50, offset = 0): ArtifactMetadata[] {
    const bounded = Math.max(1, Math.min(limit, 200));
    const rows = this.db.connection
      .prepare(
        `SELECT id, mission_id, sha256, size_bytes, content_type, pinned, expires_at, created_at
         FROM artifacts WHERE mission_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?`
      )
      .all(missionId, bounded, Math.max(0, offset)) as Array<{
      id: string;
      mission_id: string;
      sha256: string;
      size_bytes: number;
      content_type: string;
      pinned: number;
      expires_at: string | null;
      created_at: string;
    }>;

    return rows.map((row) =>
      ArtifactMetadataSchema.parse({
        id: row.id,
        missionId: row.mission_id,
        sha256: row.sha256,
        sizeBytes: row.size_bytes,
        contentType: row.content_type,
        pinned: row.pinned === 1,
        createdAt: row.created_at,
        ...(row.expires_at ? { expiresAt: row.expires_at } : {})
      })
    );
  }

  pinArtifact(artifactId: string, pinned: boolean): void {
    const result = this.db.connection
      .prepare('UPDATE artifacts SET pinned = ? WHERE id = ?')
      .run(pinned ? 1 : 0, artifactId);
    if (result.changes === 0) {
      throw new MindchestraError('NOT_FOUND', `Artifact ${artifactId} not found`);
    }
  }

  pruneExpiredArtifacts(nowIso = new Date().toISOString()): number {
    return this.db.transaction(() => {
      const expired = this.db.connection
        .prepare('SELECT id, blob_rel_path FROM artifacts WHERE pinned = 0 AND expires_at IS NOT NULL AND expires_at <= ?')
        .all(nowIso) as Array<{ id: string; blob_rel_path: string }>;

      for (const item of expired) {
        this.db.connection.prepare('DELETE FROM artifacts WHERE id = ?').run(item.id);
        const refCount = this.db.connection
          .prepare('SELECT COUNT(*) AS cnt FROM artifacts WHERE blob_rel_path = ?')
          .get(item.blob_rel_path) as { cnt: number };
        if (refCount.cnt === 0) {
          const fullPath = this.assertSafeSubpath(path.join(this.blobsDir, item.blob_rel_path), this.blobsDir);
          rmSync(fullPath, { force: true });
        }
      }

      return expired.length;
    });
  }
}
