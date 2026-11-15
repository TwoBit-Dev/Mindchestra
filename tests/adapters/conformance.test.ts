import { describe, expect, it } from 'vitest';
import { validateAdapterConformance } from '@mindchestra/adapter-sdk';
import { DeterministicMockAdapter } from '@mindchestra/adapters';
import type { RunRequest } from '@mindchestra/contracts';

describe('Adapter Conformance Suite', () => {
  const sampleRequest: RunRequest = {
    missionId: '00000000-0000-0000-0000-000000000001',
    runId: '00000000-0000-0000-0000-000000000002',
    agentId: 'mock-agent',
    phase: 'independent',
    prompt: 'Evaluate architecture and verify constraints',
    workspacePath: '/tmp/workspace',
    profile: 'read-only',
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    toolGrantIds: [],
    inputArtifactIds: []
  };

  it('passes all conformance checks for standard deterministic mock adapter', async () => {
    const adapter = new DeterministicMockAdapter({ id: 'mock-conformance' });
    const report = await validateAdapterConformance(adapter, sampleRequest);

    expect(report.passed).toBe(true);
    expect(report.adapterId).toBe('mock-conformance');
    for (const check of report.checks) {
      expect(check.passed, `Check ${check.name} failed: ${check.message}`).toBe(true);
    }
  });

  it('verifies that adapters do not invent sequence numbers (no seq in AdapterEvent)', async () => {
    const adapter = new DeterministicMockAdapter({ id: 'mock-no-seq' });
    const controller = new AbortController();

    for await (const event of adapter.run(sampleRequest, controller.signal)) {
      expect(event).not.toHaveProperty('seq');
      expect(event).not.toHaveProperty('missionId');
      expect(event).not.toHaveProperty('actor');
      expect(event).not.toHaveProperty('correlationId');
    }
  });
});
