import { isIP } from 'node:net';
import { MindchestraError } from '@mindchestra/contracts';

export interface SsrfValidationOptions {
  allowLoopbackHttp?: boolean;
  allowedHosts?: readonly string[];
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return -1;
  }
  return (((parts[0]! << 24) >>> 0) + ((parts[1]! << 16) >>> 0) + ((parts[2]! << 8) >>> 0) + parts[3]!) >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n < 0) {
    return true;
  }
  const ranges: Array<[number, number]> = [
    [0x00000000, 0x00ffffff],
    [0x0a000000, 0x0affffff],
    [0x64400000, 0x647fffff],
    [0x7f000000, 0x7fffffff],
    [0xa9fe0000, 0xa9feffff],
    [0xac100000, 0xac1fffff],
    [0xc0a80000, 0xc0a8ffff],
    [0xc6120000, 0xc613ffff],
    [0xe0000000, 0xffffffff]
  ];
  return ranges.some(([start, end]) => n >= start && n <= end);
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::' || normalized === '::1') {
    return true;
  }
  if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isIP(mapped) === 4) {
      return isBlockedIpv4(mapped);
    }
  }
  return false;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '');
  const kind = isIP(clean);
  if (kind === 4) {
    return isBlockedIpv4(clean);
  }
  if (kind === 6) {
    return isBlockedIpv6(clean);
  }
  return false;
}

export function validateMcpHttpUrl(rawUrl: string, options?: SsrfValidationOptions): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new MindchestraError('INVALID_INPUT', 'Invalid MCP HTTP endpoint URL');
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new MindchestraError('FORBIDDEN', 'Embedded credentials in MCP URL are forbidden');
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = isLoopbackHost(hostname);

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new MindchestraError('FORBIDDEN', `Unsupported MCP URL scheme: ${parsed.protocol}`);
  }

  if (parsed.protocol === 'http:') {
    if (!options?.allowLoopbackHttp || !isLoopback) {
      throw new MindchestraError('FORBIDDEN', 'Plaintext HTTP is disallowed for remote MCP servers');
    }
  }

  if (options?.allowedHosts && options.allowedHosts.length > 0) {
    const allowedSet = new Set(options.allowedHosts.map((h) => h.toLowerCase()));
    if (!allowedSet.has(hostname)) {
      throw new MindchestraError('FORBIDDEN', `MCP host ${hostname} is not in allowlist`);
    }
  }

  if (!isLoopback || !options?.allowLoopbackHttp) {
    const cleanHost = hostname.replace(/^\[|\]$/g, '');
    if (hostname === 'metadata.google.internal' || hostname.endsWith('.internal')) {
      throw new MindchestraError('FORBIDDEN', 'Internal metadata hosts are blocked');
    }
    if (isIP(cleanHost) !== 0 && isPrivateOrReservedIp(cleanHost)) {
      throw new MindchestraError('FORBIDDEN', `Private or reserved IP address ${cleanHost} is blocked`);
    }
    if (isLoopback && !options?.allowLoopbackHttp) {
      throw new MindchestraError('FORBIDDEN', 'Loopback MCP host is blocked unless explicitly allowed');
    }
  }

  return parsed;
}

export function assertSafeResolvedIps(
  hostname: string,
  ips: readonly string[],
  options?: SsrfValidationOptions
): void {
  if (options?.allowLoopbackHttp && isLoopbackHost(hostname)) {
    return;
  }
  for (const ip of ips) {
    if (isPrivateOrReservedIp(ip)) {
      throw new MindchestraError('FORBIDDEN', `Resolved private IP ${ip} for ${hostname} is blocked`);
    }
  }
}
