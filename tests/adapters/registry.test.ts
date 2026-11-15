import { describe, expect, it } from 'vitest';
import { AdapterRegistry, DeterministicMockAdapter } from '@mindchestra/adapters';

describe('AdapterRegistry', () => {
  it('registers and retrieves adapters by slug ID', () => {
    const registry = new AdapterRegistry();
    const adapter = new DeterministicMockAdapter({ id: 'custom-mock' });

    registry.register(adapter);
    expect(registry.hasAdapter('custom-mock')).toBe(true);
    expect(registry.getAdapter('custom-mock')).toBe(adapter);
    expect(registry.listAdapters()).toHaveLength(1);
    expect(registry.listManifests()).toEqual([adapter.manifest()]);
  });

  it('rejects duplicate adapter registrations with CONFLICT error', () => {
    const registry = new AdapterRegistry();
    const adapter1 = new DeterministicMockAdapter({ id: 'dupe-agent' });
    const adapter2 = new DeterministicMockAdapter({ id: 'dupe-agent' });

    registry.register(adapter1);
    expect(() => registry.register(adapter2)).toThrowError(/already registered/);
  });

  it('unregisters an adapter cleanly', () => {
    const registry = new AdapterRegistry();
    const adapter = new DeterministicMockAdapter({ id: 'temp-agent' });

    registry.register(adapter);
    expect(registry.unregister('temp-agent')).toBe(true);
    expect(registry.hasAdapter('temp-agent')).toBe(false);
    expect(registry.getAdapter('temp-agent')).toBeUndefined();
  });

  it('probes adapter and resolves effective capabilities with write disabled by policy', async () => {
    const registry = new AdapterRegistry();
    const adapter = new DeterministicMockAdapter({
      id: 'probe-test',
      capabilities: {
        streaming: true,
        tools: true,
        workspaceWrite: true // declared true in manifest
      }
    });

    registry.register(adapter);
    const controller = new AbortController();
    const probe = await registry.probeAdapter('probe-test', controller.signal);

    expect(probe.status).toBe('ready');
    // Policy default denies workspaceWrite
    expect(probe.capabilities.workspaceWrite).toBe(false);
    expect(probe.capabilities.streaming).toBe(true);
  });
});
