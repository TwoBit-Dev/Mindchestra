import { randomBytes, timingSafeEqual } from 'node:crypto';
import { MindchestraError } from '@mindchestra/contracts';
import type { CallerIdentity } from '@mindchestra/policy';
import type { FastifyRequest } from 'fastify';

export interface BrowserSession {
  sessionId: string;
  csrfToken: string;
  identity: CallerIdentity;
}

export interface AuthRegistryConfig {
  nativeTokens?: Map<string, CallerIdentity>;
  browserSessions?: Map<string, BrowserSession>;
  requireAuth?: boolean;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function safeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.byteLength !== bufB.byteLength) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const name = part.slice(0, eqIndex).trim();
    const val = part.slice(eqIndex + 1).trim();
    if (name) {
      cookies[name] = decodeURIComponent(val);
    }
  }
  return cookies;
}

export function assertLoopbackHost(hostHeader: string | undefined): void {
  if (!hostHeader) {
    throw new MindchestraError('FORBIDDEN', 'Missing Host header');
  }
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    throw new MindchestraError('FORBIDDEN', 'Invalid Host header');
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new MindchestraError('FORBIDDEN', `Host ${hostname} is not a permitted loopback host`);
  }
}

export function assertSameOriginIfPresent(originHeader: string | undefined): void {
  if (!originHeader) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(originHeader);
  } catch {
    throw new MindchestraError('FORBIDDEN', 'Malformed Origin header');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MindchestraError('FORBIDDEN', 'Unsupported Origin scheme');
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new MindchestraError('FORBIDDEN', 'Cross-origin request rejected');
  }
}

export function assertNoTokenInUrl(rawUrl: string): void {
  const queryStart = rawUrl.indexOf('?');
  if (queryStart < 0) {
    return;
  }
  const params = new URLSearchParams(rawUrl.slice(queryStart + 1));
  const forbiddenKeys = ['token', 'access_token', 'auth', 'bearer', 'api_key', 'apikey', 'secret'];
  for (const key of forbiddenKeys) {
    if (params.has(key)) {
      throw new MindchestraError('UNAUTHENTICATED', 'Authentication tokens in URL query parameters are forbidden');
    }
  }
}

export class DaemonAuthManager {
  private readonly nativeTokens: Map<string, CallerIdentity>;
  private readonly browserSessions: Map<string, BrowserSession>;
  private readonly requireAuth: boolean;

  constructor(config?: AuthRegistryConfig) {
    this.nativeTokens = config?.nativeTokens ?? new Map();
    this.browserSessions = config?.browserSessions ?? new Map();
    this.requireAuth = config?.requireAuth ?? true;
    if (this.requireAuth && this.nativeTokens.size === 0) {
      const defaultToken = randomBytes(24).toString('hex');
      this.nativeTokens.set(defaultToken, {
        role: 'user',
        actorId: 'local-user',
        depth: 0
      });
    }
  }

  registerNativeToken(token: string, identity: CallerIdentity): void {
    this.nativeTokens.set(token, identity);
  }

  issueBrowserSession(identity: CallerIdentity): BrowserSession {
    const session: BrowserSession = {
      sessionId: randomBytes(24).toString('hex'),
      csrfToken: randomBytes(24).toString('hex'),
      identity
    };
    this.browserSessions.set(session.sessionId, session);
    return session;
  }

  getDefaultUserToken(): string | undefined {
    for (const [token, identity] of this.nativeTokens.entries()) {
      if (identity.role === 'user') {
        return token;
      }
    }
    return undefined;
  }

  authenticateRequest(request: FastifyRequest): CallerIdentity {
    assertNoTokenInUrl(request.url);
    assertLoopbackHost(request.headers.host);
    assertSameOriginIfPresent(request.headers.origin);

    if (!this.requireAuth) {
      return { role: 'user', actorId: 'local-user', depth: 0 };
    }

    const authHeader = request.headers.authorization;
    if (authHeader) {
      const match = /^Bearer\s+(.+)$/i.exec(authHeader);
      if (!match) {
        throw new MindchestraError('UNAUTHENTICATED', 'Invalid Authorization header scheme');
      }
      const presented = match[1]!.trim();
      for (const [expectedToken, identity] of this.nativeTokens.entries()) {
        if (safeStringEqual(presented, expectedToken)) {
          return identity;
        }
      }
      throw new MindchestraError('UNAUTHENTICATED', 'Invalid bearer credential');
    }

    const cookies = parseCookies(request.headers.cookie);
    const sessionId = cookies['mindchestra_session'];
    if (sessionId) {
      for (const [expectedId, session] of this.browserSessions.entries()) {
        if (safeStringEqual(sessionId, expectedId)) {
          const isMutation =
            request.method === 'POST' ||
            request.method === 'PUT' ||
            request.method === 'PATCH' ||
            request.method === 'DELETE';
          if (isMutation) {
            const csrfHeader = request.headers['x-mindchestra-csrf'];
            const csrfValue = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
            if (!csrfValue || !safeStringEqual(csrfValue, session.csrfToken)) {
              throw new MindchestraError('FORBIDDEN', 'Missing or invalid CSRF token');
            }
          }
          return session.identity;
        }
      }
      throw new MindchestraError('UNAUTHENTICATED', 'Invalid or expired session cookie');
    }

    throw new MindchestraError('UNAUTHENTICATED', 'Missing authentication credentials');
  }
}
