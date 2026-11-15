import {
  AgentManifestSchema,
  DEFAULT_FALSE_CAPABILITIES,
  MindchestraError,
  resolveCapabilities,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentManifest,
  type ProbeResult
} from '@mindchestra/contracts';
import type { AdapterRegistryPort } from '@mindchestra/core';

export class InProcessAdapterRegistry implements AdapterRegistryPort {
  private readonly adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    const manifest = AgentManifestSchema.parse(adapter.manifest());
    if (this.adapters.has(manifest.id)) {
      throw new MindchestraError('CONFLICT', `Adapter ${manifest.id} is already registered`);
    }
    this.adapters.set(manifest.id, adapter);
  }

  unregister(agentId: string): boolean {
    return this.adapters.delete(agentId);
  }

  getAdapter(agentId: string): AgentAdapter | undefined {
    return this.adapters.get(agentId);
  }

  listAdapters(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  listManifests(): AgentManifest[] {
    return this.listAdapters().map((a) => a.manifest());
  }

  async probeAdapter(
    agentId: string,
    signal: AbortSignal,
    policyCapabilities?: Partial<AgentCapabilities>
  ): Promise<ProbeResult> {
    const adapter = this.adapters.get(agentId);
    if (!adapter) {
      throw new MindchestraError('NOT_FOUND', `Adapter ${agentId} not registered`);
    }
    const manifest = adapter.manifest();
    const rawProbe = await adapter.probe(signal);
    const effectivePolicy: Partial<AgentCapabilities> = policyCapabilities ?? {
      ...manifest.capabilities,
      workspaceWrite: false
    };
    return {
      ...rawProbe,
      capabilities: resolveCapabilities(
        manifest.capabilities,
        rawProbe.capabilities ?? DEFAULT_FALSE_CAPABILITIES,
        effectivePolicy
      )
    };
  }
}
