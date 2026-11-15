import {
  AdapterEventSchema,
  AgentCapabilitiesSchema,
  AgentManifestSchema,
  ProbeResultSchema,
  type AgentAdapter,
  type RunRequest
} from '@mindchestra/contracts';
import type { ConformanceCheckResult, ConformanceReport } from './types.js';

export async function validateAdapterConformance(
  adapter: AgentAdapter,
  sampleRunRequest?: RunRequest
): Promise<ConformanceReport> {
  const checks: ConformanceCheckResult[] = [];
  const manifest = adapter.manifest();

  // 1. Manifest Validation
  const manifestParse = AgentManifestSchema.safeParse(manifest);
  if (manifestParse.success) {
    checks.push({ name: 'manifest.schema', passed: true });
  } else {
    checks.push({
      name: 'manifest.schema',
      passed: false,
      message: `Manifest schema validation failed: ${manifestParse.error.message}`
    });
  }

  // 2. sdkVersion Check
  if (manifest.sdkVersion === 1) {
    checks.push({ name: 'manifest.sdkVersion', passed: true });
  } else {
    checks.push({
      name: 'manifest.sdkVersion',
      passed: false,
      message: `Expected sdkVersion 1, got ${String(manifest.sdkVersion)}`
    });
  }

  // 3. Probe Validation
  try {
    const probeController = new AbortController();
    const probe = await adapter.probe(probeController.signal);
    const probeParse = ProbeResultSchema.safeParse(probe);
    if (probeParse.success) {
      checks.push({ name: 'probe.schema', passed: true });
    } else {
      checks.push({
        name: 'probe.schema',
        passed: false,
        message: `Probe result schema invalid: ${probeParse.error.message}`
      });
    }
  } catch (err) {
    checks.push({
      name: 'probe.execution',
      passed: false,
      message: `Probe failed with error: ${err instanceof Error ? err.message : String(err)}`
    });
  }

  // 4. Capabilities Validation
  try {
    const caps = await adapter.capabilities();
    const capsParse = AgentCapabilitiesSchema.safeParse(caps);
    if (capsParse.success) {
      checks.push({ name: 'capabilities.schema', passed: true });
    } else {
      checks.push({
        name: 'capabilities.schema',
        passed: false,
        message: `Capabilities schema invalid: ${capsParse.error.message}`
      });
    }
  } catch (err) {
    checks.push({
      name: 'capabilities.execution',
      passed: false,
      message: `Capabilities check failed: ${err instanceof Error ? err.message : String(err)}`
    });
  }

  // 5. Run & Event Boundary Validation (if sampleRunRequest is provided)
  if (sampleRunRequest) {
    try {
      const runController = new AbortController();
      const events = [];
      let foundTerminal = false;
      let inventedSeq = false;

      for await (const event of adapter.run(sampleRunRequest, runController.signal)) {
        events.push(event);

        // Check if event adheres to AdapterEventSchema
        const eventParse = AdapterEventSchema.safeParse(event);
        if (!eventParse.success) {
          checks.push({
            name: 'run.eventSchema',
            passed: false,
            message: `Invalid adapter event schema for ${event.type}: ${eventParse.error.message}`
          });
        }

        // Invariant: AdapterEvent must NOT contain seq or outer daemon envelope fields
        const rawEvent = event as Record<string, unknown>;
        if ('seq' in rawEvent && rawEvent.seq !== undefined) {
          inventedSeq = true;
        }

        if (event.type === 'agent.finished' || event.type === 'agent.failed') {
          foundTerminal = true;
        }
      }

      checks.push({
        name: 'run.noPersistedSeq',
        passed: !inventedSeq,
        message: inventedSeq ? 'Adapter illegally emitted persistent "seq" field' : undefined
      });

      checks.push({
        name: 'run.terminalEvent',
        passed: foundTerminal,
        message: foundTerminal ? undefined : 'Run stream ended without an agent.finished or agent.failed event'
      });
    } catch (err) {
      checks.push({
        name: 'run.execution',
        passed: false,
        message: `Run execution threw error: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }

  const passed = checks.every((c) => c.passed);
  return {
    adapterId: manifest.id,
    passed,
    checks
  };
}
