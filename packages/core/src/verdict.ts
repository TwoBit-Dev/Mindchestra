import {
  VerdictSchema,
  type Claim,
  type EvidenceRef,
  type GateResult,
  type Verdict,
  type VerdictStatus
} from '@mindchestra/contracts';
import type {
  ArtifactPort,
  IdGeneratorPort,
  StoragePort,
  TrustedRunnerCheck
} from './ports.js';

export interface RubricWeights {
  accuracy: number;
  performance: number;
  maintainability: number;
  coverage: number;
  cost: number;
}

export const DEFAULT_RUBRIC_WEIGHTS: RubricWeights = {
  accuracy: 40,
  performance: 25,
  maintainability: 15,
  coverage: 10,
  cost: 10
};

export interface VerdictEvaluationInput {
  missionId: string;
  correlationId: string;
  rubricId?: string;
  candidateArtifactId?: string;
  trustedChecks: TrustedRunnerCheck[];
  outOfScopeViolations?: string[];
  measuredRubricScores?: Partial<RubricWeights> | null;
  nowIso: string;
}

export class VerdictEngine {
  constructor(
    private readonly storage: StoragePort,
    private readonly artifacts: ArtifactPort,
    private readonly ids: IdGeneratorPort
  ) {}

  evaluateMission(input: VerdictEvaluationInput): Verdict {
    const claims = this.storage.listClaimsByMission(input.missionId);
    const evidenceList = this.storage.listEvidenceByMission(input.missionId);
    const refreshedEvidence: EvidenceRef[] = [];

    for (const ev of evidenceList) {
      let currentStatus = ev.status;
      if (ev.artifactId && ev.sha256) {
        const integrity = this.artifacts.verifyArtifactIntegrity(ev.artifactId);
        if (!integrity.valid || integrity.actualSha256 !== ev.sha256) {
          currentStatus = 'stale';
        }
      }
      if (currentStatus !== ev.status) {
        this.storage.updateEvidenceStatus(ev.id, currentStatus);
      }
      refreshedEvidence.push({
        ...ev,
        status: currentStatus
      });
    }

    const scopeViolations = input.outOfScopeViolations ?? [];
    const scopeGate: GateResult = {
      gateId: 'scope',
      status: scopeViolations.length > 0 ? 'fail' : 'pass',
      evidenceIds: [],
      ...(scopeViolations.length > 0 ? { detail: scopeViolations.join('; ') } : {})
    };

    const failedTrusted = input.trustedChecks.filter((check) => !check.passed);
    const passedTrusted = input.trustedChecks.filter((check) => check.passed);
    const trustedEvidenceIds = refreshedEvidence
      .filter((ev) => ev.provenance === 'trusted_runner' || ev.provenance === 'gateway')
      .map((ev) => ev.id);

    const buildTestGate: GateResult = {
      gateId: 'build_test',
      status:
        failedTrusted.length > 0
          ? 'fail'
          : passedTrusted.length > 0
            ? 'pass'
            : 'unknown',
      evidenceIds: trustedEvidenceIds,
      ...(failedTrusted.length > 0
        ? { detail: failedTrusted.map((c) => `${c.gateId}:${c.detail ?? 'failed'}`).join('; ') }
        : {})
    };

    const staleEvidence = refreshedEvidence.filter((ev) => ev.status === 'stale');
    const verifiedSupporting = refreshedEvidence.filter(
      (ev) =>
        ev.relation === 'supports' &&
        ev.status === 'verified' &&
        (ev.provenance === 'trusted_runner' || ev.provenance === 'gateway' || ev.provenance === 'user')
    );

    const evidenceGate: GateResult = {
      gateId: 'evidence',
      status:
        staleEvidence.length > 0
          ? 'fail'
          : claims.length === 0
            ? 'unknown'
            : verifiedSupporting.length > 0
              ? 'pass'
              : 'unknown',
      evidenceIds: verifiedSupporting.map((ev) => ev.id),
      ...(staleEvidence.length > 0 ? { detail: 'Stale artifact hash detected on evidence' } : {})
    };

    const contradicting = refreshedEvidence.filter((ev) => ev.relation === 'contradicts');
    const contradictionGate: GateResult = {
      gateId: 'contradiction',
      status: contradicting.length > 0 ? 'fail' : 'pass',
      evidenceIds: contradicting.map((ev) => ev.id),
      ...(contradicting.length > 0 ? { detail: `${contradicting.length} unresolved contradiction(s)` } : {})
    };

    const gateResults = [scopeGate, buildTestGate, evidenceGate, contradictionGate];

    let overallStatus: VerdictStatus;
    let reason: string;
    if (scopeGate.status === 'fail' || buildTestGate.status === 'fail') {
      overallStatus = 'rejected';
      reason = 'Deterministic scope or build/test gate failed';
    } else if (contradictionGate.status === 'fail') {
      overallStatus = 'disputed';
      reason = 'Unresolved contradicting evidence preserved in verdict';
    } else if (evidenceGate.status === 'pass' && buildTestGate.status === 'pass') {
      overallStatus = 'verified';
      reason = 'All deterministic scope, test, and evidence gates passed';
    } else {
      overallStatus = 'provisional';
      reason = 'Insufficient verified trusted-runner or gateway evidence; claims remain provisional';
    }

    const dissent: string[] = [];
    for (const ev of contradicting) {
      const targetClaim = claims.find((c) => c.id === ev.claimId);
      dissent.push(
        `Contradiction on claim ${ev.claimId}${targetClaim ? ` (${targetClaim.text.slice(0, 120)})` : ''} via ${ev.sourceRef}`
      );
    }

    for (const claim of claims) {
      const claimEvidence = refreshedEvidence.filter((ev) => ev.claimId === claim.id);
      const hasContradiction = claimEvidence.some((ev) => ev.relation === 'contradicts');
      const hasVerifiedSupport = claimEvidence.some(
        (ev) =>
          ev.relation === 'supports' &&
          ev.status === 'verified' &&
          (ev.provenance === 'trusted_runner' || ev.provenance === 'gateway' || ev.provenance === 'user')
      );

      let nextClaimStatus: Claim['status'] = 'unverified';
      if (overallStatus === 'rejected') {
        nextClaimStatus = 'rejected';
      } else if (hasContradiction) {
        nextClaimStatus = 'disputed';
      } else if (hasVerifiedSupport) {
        nextClaimStatus = 'verified';
      }

      if (nextClaimStatus !== claim.status) {
        this.storage.updateClaimStatus(claim.id, nextClaimStatus);
      }
    }

    const score = this.computeRubricScore(input.measuredRubricScores ?? null);

    const verdict = VerdictSchema.parse({
      id: this.ids.nextId(),
      missionId: input.missionId,
      claimIds: claims.map((c) => c.id),
      status: overallStatus,
      rubricId: input.rubricId ?? 'default-v1',
      gateResults,
      evidenceIds: refreshedEvidence.map((ev) => ev.id),
      reason,
      dissent,
      ...(input.candidateArtifactId ? { candidateArtifactId: input.candidateArtifactId } : {}),
      score
    });

    this.storage.insertVerdict(verdict, input.nowIso);
    this.storage.appendEvent({
      missionId: input.missionId,
      actor: 'daemon',
      correlationId: input.correlationId,
      at: input.nowIso,
      payload: {
        type: 'verdict.created',
        payload: verdict
      }
    });

    return verdict;
  }

  private computeRubricScore(measured: Partial<RubricWeights> | null): number | null {
    if (!measured) {
      return null;
    }
    const keys: Array<keyof RubricWeights> = [
      'accuracy',
      'performance',
      'maintainability',
      'coverage',
      'cost'
    ];
    for (const key of keys) {
      if (typeof measured[key] !== 'number') {
        return null;
      }
    }
    const raw =
      (measured.accuracy! / 100) * DEFAULT_RUBRIC_WEIGHTS.accuracy +
      (measured.performance! / 100) * DEFAULT_RUBRIC_WEIGHTS.performance +
      (measured.maintainability! / 100) * DEFAULT_RUBRIC_WEIGHTS.maintainability +
      (measured.coverage! / 100) * DEFAULT_RUBRIC_WEIGHTS.coverage +
      (measured.cost! / 100) * DEFAULT_RUBRIC_WEIGHTS.cost;
    return Math.round(raw * 100) / 100;
  }
}
