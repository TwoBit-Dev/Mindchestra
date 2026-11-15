import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  MindchestraError,
  SlugIdSchema,
  type WorkspaceSummary
} from '@mindchestra/contracts';
import type { StorageRepositories } from '@mindchestra/storage';

const FORBIDDEN_ROOTS = new Set([
  '/',
  '/etc',
  '/private/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/System',
  '/proc',
  '/sys',
  '/dev'
]);

export interface ResolvedWorkspace {
  id: string;
  label: string;
  canonicalPath: string;
  baseCommit?: string;
  dirty: boolean;
}

export interface WorkspaceManagerOptions {
  allowedRoots?: readonly string[];
}

function slugifyLabel(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!base || !SlugIdSchema.safeParse(base).success) {
    throw new MindchestraError('INVALID_INPUT', 'Workspace label cannot produce a valid slug ID');
  }
  return base;
}

export class WorkspaceManager {
  private readonly allowedRoots: string[];

  constructor(
    private readonly repos: StorageRepositories,
    options?: WorkspaceManagerOptions
  ) {
    this.allowedRoots = (options?.allowedRoots ?? []).map((root) => realpathSync(root));
  }

  private validateDirectory(inputPath: string): string {
    if (!path.isAbsolute(inputPath)) {
      throw new MindchestraError('INVALID_INPUT', 'Workspace registration requires an absolute directory path');
    }
    if (!existsSync(inputPath)) {
      throw new MindchestraError('INVALID_INPUT', `Workspace path does not exist: ${inputPath}`);
    }
    const canonical = realpathSync(inputPath);
    const stat = lstatSync(canonical);
    if (!stat.isDirectory()) {
      throw new MindchestraError('INVALID_INPUT', 'Workspace path must be a directory');
    }
    for (const forbidden of FORBIDDEN_ROOTS) {
      if (canonical === forbidden || (forbidden !== '/' && canonical.startsWith(forbidden + path.sep))) {
        throw new MindchestraError('FORBIDDEN', `Workspace path ${canonical} is within a protected system directory`);
      }
    }
    if (this.allowedRoots.length > 0) {
      const withinAllowlist = this.allowedRoots.some(
        (root) => canonical === root || canonical.startsWith(root + path.sep)
      );
      if (!withinAllowlist) {
        throw new MindchestraError('FORBIDDEN', 'Workspace path is outside configured allowed workspace roots');
      }
    }
    return canonical;
  }

  registerWorkspace(input: { id?: string; label: string; path: string }, nowIso = new Date().toISOString()): WorkspaceSummary {
    const id = input.id ? SlugIdSchema.parse(input.id) : slugifyLabel(input.label);
    const canonicalPath = this.validateDirectory(input.path);
    return this.repos.upsertWorkspace({
      id,
      label: input.label,
      canonicalPath,
      createdAt: nowIso
    });
  }

  listWorkspaces(): WorkspaceSummary[] {
    return this.repos.listWorkspaces();
  }

  resolveWorkspace(workspaceId: string): ResolvedWorkspace {
    const record = this.repos.getWorkspace(workspaceId);
    if (!record) {
      throw new MindchestraError('NOT_FOUND', `Workspace ${workspaceId} is not registered`);
    }
    const canonicalPath = this.validateDirectory(record.canonicalPath);
    const gitState = this.inspectGitState(canonicalPath);
    return {
      id: record.id,
      label: record.label,
      canonicalPath,
      ...(gitState.baseCommit ? { baseCommit: gitState.baseCommit } : {}),
      dirty: gitState.dirty
    };
  }

  inspectGitState(canonicalPath: string): { baseCommit?: string; dirty: boolean } {
    const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: canonicalPath,
      shell: false,
      encoding: 'utf8'
    });
    if (headResult.status !== 0) {
      return { dirty: false };
    }
    const baseCommit = headResult.stdout.trim();
    const statusResult = spawnSync('git', ['status', '--porcelain'], {
      cwd: canonicalPath,
      shell: false,
      encoding: 'utf8'
    });
    const dirty = statusResult.status === 0 && statusResult.stdout.trim().length > 0;
    return {
      baseCommit: baseCommit || undefined,
      dirty
    };
  }

  validateSourceRef(workspacePath: string, sourceRef: string): boolean {
    if (sourceRef.startsWith('https://')) {
      try {
        new URL(sourceRef);
        return true;
      } catch {
        return false;
      }
    }
    if (sourceRef.startsWith('/') || sourceRef.includes('\0')) {
      return false;
    }
    const [rawRelPath] = sourceRef.split(':');
    if (!rawRelPath) {
      return false;
    }
    const normalized = path.posix.normalize(rawRelPath);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      return false;
    }
    const rootReal = realpathSync(workspacePath);
    const candidate = path.resolve(rootReal, normalized);
    if (!candidate.startsWith(rootReal + path.sep) && candidate !== rootReal) {
      return false;
    }
    if (existsSync(candidate)) {
      const candidateReal = realpathSync(candidate);
      if (!candidateReal.startsWith(rootReal + path.sep) && candidateReal !== rootReal) {
        return false;
      }
    }
    return true;
  }
}
