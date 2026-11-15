import { MindchestraError, sha256Hex, type MissionSpec } from '@mindchestra/contracts';

export type CallerRole = 'user' | 'agent';

export interface CallerIdentity {
  role: CallerRole;
  actorId: string;
  missionId?: string;
  runId?: string;
  depth: number;
}

export const MVP_MAX_RECURSION_DEPTH = 1;

export class RecursiveGuard {
  private readonly activeObjectives = new Set<string>();

  computeObjectiveHash(spec: Pick<MissionSpec, 'workspace' | 'mode' | 'objective'>): string {
    return sha256Hex(`${spec.workspace}:${spec.mode}:${spec.objective.trim()}`);
  }

  assertCallerAllowed(caller: CallerIdentity): void {
    if (caller.role === 'agent') {
      throw new MindchestraError('FORBIDDEN', 'Managed agents cannot recursively start missions');
    }
    if (caller.depth >= MVP_MAX_RECURSION_DEPTH) {
      throw new MindchestraError('FORBIDDEN', `Mission nesting exceeds maxDepth=${MVP_MAX_RECURSION_DEPTH}`);
    }
  }

  assertObjectiveNotActive(spec: Pick<MissionSpec, 'workspace' | 'mode' | 'objective'>): string {
    const objectiveHash = this.computeObjectiveHash(spec);
    if (this.activeObjectives.has(objectiveHash)) {
      throw new MindchestraError('CONFLICT', 'Identical active mission objective is already running');
    }
    return objectiveHash;
  }

  assertCanStartMission(caller: CallerIdentity, spec: Pick<MissionSpec, 'workspace' | 'mode' | 'objective'>): string {
    this.assertCallerAllowed(caller);
    return this.assertObjectiveNotActive(spec);
  }

  assertCanDecideApproval(caller: CallerIdentity): void {
    if (caller.role !== 'user') {
      throw new MindchestraError('FORBIDDEN', 'Only authenticated user sessions may decide approvals');
    }
  }

  registerActiveObjective(hash: string): void {
    this.activeObjectives.add(hash);
  }

  releaseActiveObjective(hash: string): void {
    this.activeObjectives.delete(hash);
  }
}
