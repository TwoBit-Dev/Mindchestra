import { MindchestraError } from '@mindchestra/contracts';
import type { DaemonContext } from './app.js';

const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export async function listenLoopback(
  daemon: DaemonContext,
  options?: { port?: number; host?: string }
): Promise<{ address: string; port: number }> {
  const host = options?.host ?? '127.0.0.1';
  if (!LOOPBACK_BIND_HOSTS.has(host)) {
    throw new MindchestraError('FORBIDDEN', `Refusing to bind daemon to non-loopback address: ${host}`);
  }
  const address = await daemon.app.listen({
    host,
    port: options?.port ?? 4311
  });
  const parsed = new URL(address);
  return {
    address,
    port: Number(parsed.port)
  };
}
