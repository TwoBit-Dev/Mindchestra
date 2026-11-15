# Guide: Authoring AI Adapters for Mindchestra

This guide explains how to build, test, and register a custom AI adapter using `@mindchestra/adapter-sdk` and `@mindchestra/contracts`.

---

## 1. Core Principles

1. **Strict Contract Compliance**: Every adapter implements `AgentAdapter` (`manifest()`, `probe()`, `capabilities()`, `run()`).
2. **Normalized Events Only**: Adapters emit pure `AdapterEvent` payloads (`agent.started`, `message.delta`, `message.completed`, `tool.observed`, `usage.updated`, `agent.finished`, `agent.failed`). **Never** attach sequence numbers (`seq`), event IDs, or outer envelopes—the daemon manages persistence and ordering.
3. **Deterministic & Safe Subprocesses**: CLI-based adapters must execute via `streamCliLines` with `shell: false`, UTF-8 chunk buffering, timeout limits, and sensitive data redaction.
4. **Default-Deny Capabilities**: Manifest declarations are intersected with observed probe results and daemon policy. Write permissions are disabled by default in v0.1.

---

## 2. Minimal Implementation Example

```typescript
import { BaseAgentAdapter } from '@mindchestra/adapter-sdk';
import {
  DEFAULT_FALSE_CAPABILITIES,
  type AdapterEvent,
  type AgentManifest,
  type ProbeResult,
  type RunRequest
} from '@mindchestra/contracts';

export class CustomAiAdapter extends BaseAgentAdapter {
  constructor() {
    const manifest: AgentManifest = {
      id: 'my-custom-ai',
      displayName: 'My Custom AI Provider',
      provider: 'custom',
      adapterVersion: '0.1.0',
      sdkVersion: 1, // Must be 1 in Mindchestra v0.1
      kind: 'custom',
      capabilities: {
        ...DEFAULT_FALSE_CAPABILITIES,
        streaming: true,
        tools: true
      }
    };
    super(manifest);
  }

  async probe(signal: AbortSignal): Promise<ProbeResult> {
    this.assertNotAborted(signal);
    return {
      status: 'ready',
      checkedAt: new Date().toISOString(),
      version: '1.0.0',
      capabilities: this._manifest.capabilities
    };
  }

  async *run(req: RunRequest, signal: AbortSignal): AsyncIterable<AdapterEvent> {
    this.assertNotAborted(signal);

    yield {
      type: 'agent.started',
      payload: { providerSessionId: req.sessionId }
    };

    const messageId = crypto.randomUUID();
    yield {
      type: 'message.delta',
      payload: { messageId, text: 'Examining input...' }
    };

    yield {
      type: 'message.completed',
      payload: { messageId, text: 'Examining input... Done.' }
    };

    yield {
      type: 'agent.finished',
      payload: { summary: 'Analysis completed.' }
    };
  }
}
```

---

## 3. Conformance Testing

Before opening a pull request, verify that your adapter satisfies all contract invariants using `validateAdapterConformance`:

```typescript
import { it, expect } from 'vitest';
import { validateAdapterConformance } from '@mindchestra/adapter-sdk';
import { CustomAiAdapter } from './custom-adapter.js';

it('passes adapter conformance checks', async () => {
  const adapter = new CustomAiAdapter();
  const report = await validateAdapterConformance(adapter);
  expect(report.passed).toBe(true);
});
```

---

## 4. Registering with Mindchestra

Register your adapter instance with the `AdapterRegistry`:

```typescript
import { AdapterRegistry } from '@mindchestra/adapters';
import { CustomAiAdapter } from './custom-adapter.js';

const registry = new AdapterRegistry();
registry.register(new CustomAiAdapter());
```
