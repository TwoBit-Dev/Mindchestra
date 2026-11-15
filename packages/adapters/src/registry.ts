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

/**
 * Provider-independent registry that manages registered agent adapters,
 * validates sdkVersion, prevents ID collision, and resolves effective capabilities.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    const manifest = AgentManifestSchema.parse(adapter.manifest());

    if (manifest.sdkVersion !== 1) {
      throw new MindchestraError(
        'INVALID_INPUT',
        `Adapter ${manifest.id} specifies unsupported sdkVersion: ${manifest.sdkVersion}. Only sdkVersion 1 is supported.`
      );
    }

    if (this.adapters.has(manifest.id)) {
      throw new MindchestraError('CONFLICT', `Adapter with ID "${manifest.id}" is already registered`);
    }

    this.adapters.set(manifest.id, adapter);
  }

  unregister(agentId: string): boolean {
    return this.adapters.delete(agentId);
  }

  getAdapter(agentId: string): AgentAdapter | undefined {
    return this.adapters.get(agentId);
  }

  hasAdapter(agentId: string): boolean {
    return this.adapters.has(agentId);
  }

  listAdapters(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  listManifests(): AgentManifest[] {
    return this.listAdapters().map((adapter) => adapter.manifest());
  }

  async probeAdapter(
    agentId: string,
    signal: AbortSignal,
    policyCapabilities?: Partial<AgentCapabilities>
  ): Promise<ProbeResult> {
    const adapter = this.adapters.get(agentId);
    if (!adapter) {
      throw new MindchestraError('NOT_FOUND', `Adapter "${agentId}" is not registered`);
    }

    const manifest = adapter.manifest();
    const rawProbe = await adapter.probe(signal);

    // Capabilities are intersection of declared, observed and permitted support (default-deny for writes)
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

  clear(): void {
    this.adapters.clear();
  }
}
