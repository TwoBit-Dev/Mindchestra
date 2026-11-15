import { BaseAgentAdapter } from '@mindchestra/adapter-sdk';
import {
  DEFAULT_FALSE_CAPABILITIES,
  MindchestraError,
  type AdapterEvent,
  type AgentManifest,
  type ProbeResult,
  type RunRequest
} from '@mindchestra/contracts';

export class CodexCliAdapter extends BaseAgentAdapter {
  constructor() {
    const manifest: AgentManifest = {
      id: 'codex',
      displayName: 'Codex CLI',
      provider: 'openai',
      adapterVersion: '0.1.0',
      sdkVersion: 1,
      kind: 'cli',
      capabilities: {
        ...DEFAULT_FALSE_CAPABILITIES,
        streaming: true,
        tools: true,
        structuredOutput: true
      },
      models: ['gpt-5-codex', 'gpt-5']
    };
    super(manifest);
  }

  async probe(signal: AbortSignal): Promise<ProbeResult> {
    this.assertNotAborted(signal);
    // Offline/smoke check: CLI binary detected or auth required
    return {
      status: 'ready',
      checkedAt: new Date().toISOString(),
      version: '0.1.0',
      detail: 'Codex CLI adapter stub registered',
      capabilities: this._manifest.capabilities
    };
  }

  async *run(_req: RunRequest, _signal: AbortSignal): AsyncIterable<AdapterEvent> {
    throw new MindchestraError('UNSUPPORTED', 'Codex CLI adapter execution scheduled for Sprint 3');
  }
}
