import { canonicalJson, computeActionHash, sha256Hex } from '@mindchestra/contracts';

export const POLICY_VERSION = 1;

export interface ToolActionFingerprintInput {
  missionId: string;
  runId?: string;
  action: 'tool_write' | 'apply_patch' | 'external_send';
  target: string;
  argumentsOrPatch: Record<string, unknown> | string;
  schemaHash: string;
  baseCommit?: string;
  policyVersion?: number;
}

export function buildToolActionHash(input: ToolActionFingerprintInput): string {
  const argsOrPatchHash =
    typeof input.argumentsOrPatch === 'string'
      ? sha256Hex(input.argumentsOrPatch)
      : sha256Hex(canonicalJson(input.argumentsOrPatch));

  return computeActionHash({
    missionId: input.missionId,
    runId: input.runId,
    action: input.action,
    target: input.target,
    argsOrPatchHash,
    schemaHash: input.schemaHash,
    policyVersion: input.policyVersion ?? POLICY_VERSION,
    baseCommit: input.baseCommit
  });
}
