import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { MindchestraError } from '@mindchestra/contracts';

const SAFE_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SHELL',
  'NODE_ENV',
  'NO_COLOR'
]);

const SENSITIVE_ENV_PATTERN = /(SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL|AUTH|COOKIE|PRIVATE)/i;

export function scrubEnvironment(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  extraAllowedKeys: readonly string[] = []
): Record<string, string> {
  const extraSet = new Set(extraAllowedKeys);
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) {
      continue;
    }
    if (SAFE_ENV_ALLOWLIST.has(key) || (extraSet.has(key) && !SENSITIVE_ENV_PATTERN.test(key))) {
      clean[key] = value;
    }
  }
  return clean;
}

export interface WorktreeHandle {
  branchName: string;
  worktreePath: string;
  baseCommit: string;
}

export class WorktreeCoordinator {
  createIsolatedWorktree(input: {
    repoPath: string;
    worktreeRoot: string;
    missionId: string;
    agentId: string;
    baseCommit: string;
  }): WorktreeHandle {
    const repoReal = realpathSync(input.repoPath);
    mkdirSync(input.worktreeRoot, { recursive: true });
    const rootReal = realpathSync(input.worktreeRoot);
    const shortMission = input.missionId.slice(0, 8);
    const branchName = `mc/${shortMission}/${input.agentId}`;
    const worktreePath = path.join(rootReal, `${shortMission}-${input.agentId}`);

    if (!worktreePath.startsWith(rootReal + path.sep)) {
      throw new MindchestraError('FORBIDDEN', 'Invalid worktree target path');
    }

    if (existsSync(worktreePath)) {
      throw new MindchestraError('CONFLICT', `Worktree path already exists: ${worktreePath}`);
    }

    const res = spawnSync('git', ['worktree', 'add', '-b', branchName, worktreePath, input.baseCommit], {
      cwd: repoReal,
      shell: false,
      encoding: 'utf8'
    });

    if (res.status !== 0) {
      throw new MindchestraError('INTERNAL', `Failed to create git worktree: ${res.stderr.trim()}`);
    }

    return {
      branchName,
      worktreePath,
      baseCommit: input.baseCommit
    };
  }

  removeCleanWorktree(repoPath: string, worktreePath: string): void {
    const statusRes = spawnSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      shell: false,
      encoding: 'utf8'
    });
    if (statusRes.status !== 0 || statusRes.stdout.trim().length > 0) {
      throw new MindchestraError('CONFLICT', 'Refusing to remove dirty worktree');
    }

    const removeRes = spawnSync('git', ['worktree', 'remove', worktreePath], {
      cwd: realpathSync(repoPath),
      shell: false,
      encoding: 'utf8'
    });
    if (removeRes.status !== 0) {
      throw new MindchestraError('INTERNAL', `Failed to remove worktree: ${removeRes.stderr.trim()}`);
    }
  }
}
