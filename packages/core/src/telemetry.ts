import type { UsageMetrics } from '@mindchestra/contracts';

export interface MissionTelemetrySummary {
  missionId: string;
  runCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  totalDurationMs: number;
  hasUnmeasuredUsage: boolean;
}

export class TelemetryCollector {
  private readonly latestRunUsage = new Map<string, UsageMetrics>();

  recordRunUsage(runId: string, metrics: UsageMetrics): void {
    this.latestRunUsage.set(runId, metrics);
  }

  summarize(missionId: string, runIds: readonly string[]): MissionTelemetrySummary {
    let inputSum = 0;
    let outputSum = 0;
    let costSum = 0;
    let durationSum = 0;
    let anyInput = false;
    let anyOutput = false;
    let anyCost = false;
    let hasUnmeasuredUsage = false;

    for (const runId of runIds) {
      const metrics = this.latestRunUsage.get(runId);
      if (!metrics) {
        hasUnmeasuredUsage = true;
        continue;
      }
      durationSum += metrics.durationMs;
      if (metrics.inputTokens !== null) {
        anyInput = true;
        inputSum += metrics.inputTokens;
      } else {
        hasUnmeasuredUsage = true;
      }
      if (metrics.outputTokens !== null) {
        anyOutput = true;
        outputSum += metrics.outputTokens;
      } else {
        hasUnmeasuredUsage = true;
      }
      if (metrics.costUsd !== null) {
        anyCost = true;
        costSum += metrics.costUsd;
      }
    }

    return {
      missionId,
      runCount: runIds.length,
      inputTokens: anyInput ? inputSum : null,
      outputTokens: anyOutput ? outputSum : null,
      costUsd: anyCost ? Math.round(costSum * 1_000_000) / 1_000_000 : null,
      totalDurationMs: durationSum,
      hasUnmeasuredUsage
    };
  }
}
