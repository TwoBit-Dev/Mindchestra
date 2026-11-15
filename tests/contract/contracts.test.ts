import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AdapterEventSchema,
  AgentEventSchema,
  AgentManifestSchema,
  DEFAULT_FALSE_CAPABILITIES,
  ERROR_HTTP_STATUS,
  ErrorEnvelopeSchema,
  MindchestraError,
  MissionSpecSchema,
  UsageMetricsSchema,
  canonicalJson,
  computeActionHash,
  computeSchemaHash,
  resolveCapabilities
} from '@mindchestra/contracts';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const openApiPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../docs/api/openapi.yaml');

describe('Contract schemas and canonical helpers', () => {
  it('validates valid mission spec fixture and rejects invalid spec fixture', () => {
    const validRaw = JSON.parse(readFileSync(path.join(fixturesDir, 'valid-mission-spec.json'), 'utf8'));
    const invalidRaw = JSON.parse(readFileSync(path.join(fixturesDir, 'invalid-mission-spec.json'), 'utf8'));

    const validParsed = MissionSpecSchema.safeParse(validRaw);
    expect(validParsed.success).toBe(true);

    const invalidParsed = MissionSpecSchema.safeParse(invalidRaw);
    expect(invalidParsed.success).toBe(false);
  });

  it('enforces mission objective length bounds and unique agent list up to 10', () => {
    const base = JSON.parse(readFileSync(path.join(fixturesDir, 'valid-mission-spec.json'), 'utf8'));

    expect(MissionSpecSchema.safeParse({ ...base, objective: '' }).success).toBe(false);
    expect(MissionSpecSchema.safeParse({ ...base, objective: 'x'.repeat(20001) }).success).toBe(false);
    expect(
      MissionSpecSchema.safeParse({
        ...base,
        agents: Array.from({ length: 10 }, (_, idx) => `agent-${idx}`)
      }).success
    ).toBe(true);
    expect(
      MissionSpecSchema.safeParse({
        ...base,
        agents: Array.from({ length: 11 }, (_, idx) => `agent-${idx}`)
      }).success
    ).toBe(false);
  });

  it('distinguishes AdapterEvent from persisted AgentEvent envelope', () => {
    const golden = JSON.parse(readFileSync(path.join(fixturesDir, 'golden-event-stream.json'), 'utf8')) as {
      events: unknown[];
    };

    for (const raw of golden.events) {
      expect(AgentEventSchema.safeParse(raw).success).toBe(true);
    }

    const adapterInput = {
      type: 'agent.finished',
      payload: { summary: 'Completed analysis' }
    };
    expect(AdapterEventSchema.safeParse(adapterInput).success).toBe(true);
    expect(AgentEventSchema.safeParse(adapterInput).success).toBe(false);
  });

  it('validates capability intersection and treats unknown as false', () => {
    const manifest = AgentManifestSchema.parse({
      id: 'codex-cli',
      displayName: 'Codex CLI',
      provider: 'openai',
      adapterVersion: '0.1.0',
      sdkVersion: 1,
      kind: 'cli',
      capabilities: {
        ...DEFAULT_FALSE_CAPABILITIES,
        streaming: true,
        tools: true,
        workspaceWrite: true
      }
    });

    const resolved = resolveCapabilities(
      manifest.capabilities,
      { streaming: true, tools: false, workspaceWrite: true },
      { streaming: true, tools: true, workspaceWrite: false }
    );

    expect(resolved.streaming).toBe(true);
    expect(resolved.tools).toBe(false);
    expect(resolved.workspaceWrite).toBe(false);
    expect(resolved.resume).toBe(false);
  });

  it('preserves null for unmeasured usage metrics and omits undefined in canonicalJson', () => {
    const usage = UsageMetricsSchema.parse({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      durationMs: 420,
      source: 'unknown'
    });
    expect(usage.inputTokens).toBeNull();

    const a = canonicalJson({ z: 1, a: 2, omitted: undefined, nested: { b: 2, a: 1 } });
    const b = canonicalJson({ nested: { a: 1, b: 2 }, a: 2, z: 1 });
    expect(a).toBe(b);
    expect(a).not.toContain('undefined');
  });

  it('produces deterministic actionHash and schemaHash across key permutations', () => {
    const h1 = computeActionHash({
      missionId: '20000000-0000-4000-8000-000000000001',
      runId: '40000000-0000-4000-8000-000000000001',
      action: 'tool_write',
      target: 'fs::write',
      argsOrPatchHash: 'a'.repeat(64),
      schemaHash: 'b'.repeat(64),
      policyVersion: 1,
      baseCommit: 'abc123'
    });
    const h2 = computeActionHash({
      baseCommit: 'abc123',
      policyVersion: 1,
      schemaHash: 'b'.repeat(64),
      argsOrPatchHash: 'a'.repeat(64),
      target: 'fs::write',
      action: 'tool_write',
      runId: '40000000-0000-4000-8000-000000000001',
      missionId: '20000000-0000-4000-8000-000000000001'
    });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);

    const s1 = computeSchemaHash({ type: 'object', properties: { b: { type: 'string' }, a: { type: 'number' } } });
    const s2 = computeSchemaHash({ properties: { a: { type: 'number' }, b: { type: 'string' } }, type: 'object' });
    expect(s1).toBe(s2);
  });

  it('maps error codes to exact HTTP status codes and error envelopes', () => {
    expect(ERROR_HTTP_STATUS.INVALID_INPUT).toBe(400);
    expect(ERROR_HTTP_STATUS.UNAUTHENTICATED).toBe(401);
    expect(ERROR_HTTP_STATUS.FORBIDDEN).toBe(403);
    expect(ERROR_HTTP_STATUS.NOT_FOUND).toBe(404);
    expect(ERROR_HTTP_STATUS.CONFLICT).toBe(409);
    expect(ERROR_HTTP_STATUS.NOT_READY).toBe(409);
    expect(ERROR_HTTP_STATUS.CURSOR_EXPIRED).toBe(410);
    expect(ERROR_HTTP_STATUS.RATE_LIMITED).toBe(429);
    expect(ERROR_HTTP_STATUS.UNAVAILABLE).toBe(503);
    expect(ERROR_HTTP_STATUS.TIMEOUT).toBe(504);

    const err = new MindchestraError('NOT_READY', 'Mission is running', { retryable: true });
    expect(err.httpStatus).toBe(409);
    const envelope = err.toEnvelope('req-123');
    expect(ErrorEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('documents all v1 HTTP endpoints in openapi.yaml', () => {
    const specText = readFileSync(openApiPath, 'utf8');
    const requiredPaths = [
      '/v1/health:',
      '/v1/missions:',
      '/v1/missions/{id}:',
      '/v1/missions/{id}/events:',
      '/v1/missions/{id}/result:',
      '/v1/missions/{id}/cancel:',
      '/v1/missions/{id}/evidence:',
      '/v1/missions/{id}/artifacts:',
      '/v1/missions/{id}/replay:',
      '/v1/missions/{id}/rerun:',
      '/v1/artifacts/{id}:',
      '/v1/agents:',
      '/v1/agents/{id}/probe:',
      '/v1/agents/{id}:',
      '/v1/workspaces:',
      '/v1/mcp/servers:',
      '/v1/mcp/servers/{id}/probe:',
      '/v1/mcp/servers/{id}/tools:',
      '/v1/approvals:',
      '/v1/approvals/{id}/decision:'
    ];
    for (const p of requiredPaths) {
      expect(specText).toContain(p);
    }
  });
});
