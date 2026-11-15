import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  AgentConfigSchema,
  ApprovalInputSchema,
  EvidenceRelationSchema,
  IdSchema,
  MCPServerConfigSchema,
  MindchestraError,
  MissionSpecSchema,
  MissionStatusSchema,
  SlugIdSchema,
  WorkspaceCreateInputSchema,
  canonicalJson,
  isTerminalMissionStatus,
  sha256Hex,
  type AgentEvent,
  type AgentSummary,
  type ApprovalStatus,
  type MissionStatus
} from '@mindchestra/contracts';
import {
  MissionEngine,
  ReplayProjector,
  type AdapterRegistryPort,
  type TrustedRunnerPort
} from '@mindchestra/core';
import { McpGateway, type DownstreamClientFactory } from '@mindchestra/mcp-gateway';
import {
  PolicyEngine,
  RecursiveGuard,
  redactText,
  sanitizeAgentConfig,
  type CallerIdentity
} from '@mindchestra/policy';
import {
  ArtifactStore,
  EventStore,
  SqliteDatabase,
  StorageRepositories,
  runMigrations
} from '@mindchestra/storage';
import { WorkspaceManager } from '@mindchestra/workspaces';
import { z, ZodError } from 'zod';
import { DaemonAuthManager, type AuthRegistryConfig } from './auth.js';
import { InProcessAdapterRegistry } from './adapter-registry.js';

declare module 'fastify' {
  interface FastifyRequest {
    caller?: CallerIdentity;
    mindchestraRequestId?: string;
  }
}

export interface CreateDaemonOptions {
  dbPath: string;
  artifactRoot: string;
  adapters?: AdapterRegistryPort;
  trustedRunner?: TrustedRunnerPort;
  mcpClientFactory?: DownstreamClientFactory;
  allowLoopbackMcpHttp?: boolean;
  allowLiveWrites?: boolean;
  allowedWorkspaceRoots?: readonly string[];
  sseHeartbeatMs?: number;
  sseMaxClientQueue?: number;
  auth?: AuthRegistryConfig;
}

export interface DaemonContext {
  app: FastifyInstance;
  db: SqliteDatabase;
  eventStore: EventStore;
  repos: StorageRepositories;
  artifacts: ArtifactStore;
  policy: PolicyEngine;
  workspaces: WorkspaceManager;
  gateway: McpGateway;
  engine: MissionEngine;
  auth: DaemonAuthManager;
  adapters: AdapterRegistryPort;
  close(): Promise<void>;
}

const DEFAULT_SSE_HEARTBEAT_MS = 15000;
const DEFAULT_SSE_MAX_QUEUE = 512;

export function createDaemonApp(options: CreateDaemonOptions): DaemonContext {
  const db = new SqliteDatabase(options.dbPath);
  runMigrations(db);

  const eventStore = new EventStore(db);
  const repos = new StorageRepositories(db, eventStore);
  repos.recoverInterruptedState();

  const artifacts = new ArtifactStore(db, options.artifactRoot);
  const policy = new PolicyEngine(repos, {
    allowLiveWrites: options.allowLiveWrites ?? false
  });
  const workspaces = new WorkspaceManager(repos, {
    allowedRoots: options.allowedWorkspaceRoots
  });
  const gateway = new McpGateway(repos, eventStore, artifacts, policy, {
    allowLoopbackHttp: options.allowLoopbackMcpHttp ?? false,
    clientFactory: options.mcpClientFactory
  });
  const adapters = options.adapters ?? new InProcessAdapterRegistry();
  const engine = new MissionEngine({
    storage: repos,
    adapters,
    workspaces,
    artifacts,
    trustedRunner: options.trustedRunner
  });
  const replayProjector = new ReplayProjector();
  const recursiveGuard = new RecursiveGuard();
  const auth = new DaemonAuthManager(options.auth);

  const sseHeartbeatMs = options.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
  const sseMaxQueue = options.sseMaxClientQueue ?? DEFAULT_SSE_MAX_QUEUE;

  const app = Fastify({
    logger: false,
    bodyLimit: 256 * 1024
  });

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const reqIdHeader = request.headers['x-request-id'];
    const reqId =
      typeof reqIdHeader === 'string' && reqIdHeader.trim().length > 0
        ? reqIdHeader.trim().slice(0, 128)
        : randomUUID();
    request.mindchestraRequestId = reqId;
    reply.header('x-request-id', reqId);

    if (request.url === '/v1/health') {
      return;
    }
    request.caller = auth.authenticateRequest(request);
  });

  app.setErrorHandler((error, request, reply) => {
    const reqId = request.mindchestraRequestId;
    if (error instanceof MindchestraError) {
      const sanitized = new MindchestraError(error.code, redactText(error.message), {
        retryable: error.retryable,
        details: error.details
      });
      return reply.status(sanitized.httpStatus).send(sanitized.toEnvelope(reqId));
    }
    if (error instanceof ZodError) {
      const validationErr = new MindchestraError('INVALID_INPUT', 'Request validation failed', {
        details: { issues: error.issues }
      });
      return reply.status(400).send(validationErr.toEnvelope(reqId));
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 413) {
      const payloadErr = new MindchestraError('INVALID_INPUT', 'Request body exceeds 256 KiB limit');
      return reply.status(400).send(payloadErr.toEnvelope(reqId));
    }
    const internalErr = new MindchestraError('INTERNAL', redactText('Internal daemon error'));
    return reply.status(500).send(internalErr.toEnvelope(reqId));
  });

  app.get('/v1/health', async () => {
    return {
      status: 'ok' as const,
      version: '0.1.0',
      schemaVersion: 1 as const
    };
  });

  app.post('/v1/missions', async (request, reply) => {
    const caller = request.caller!;
    const spec = MissionSpecSchema.parse(request.body);
    recursiveGuard.assertCallerAllowed(caller);

    const idempotencyHeader = request.headers['idempotency-key'];
    const idempotencyKey =
      typeof idempotencyHeader === 'string' && idempotencyHeader.trim().length > 0
        ? idempotencyHeader.trim()
        : undefined;

    if (idempotencyKey !== undefined) {
      const requestHash = sha256Hex(canonicalJson(spec));
      const existing = repos.findIdempotentMission(caller.actorId, idempotencyKey, requestHash);
      if (existing) {
        return reply.status(202).send(existing);
      }
    }

    const objectiveHash = recursiveGuard.assertObjectiveNotActive(spec);
    const releaseObjective = () => {
      recursiveGuard.releaseActiveObjective(objectiveHash);
    };

    recursiveGuard.registerActiveObjective(objectiveHash);
    try {
      const created = engine.createMission(spec, {
        callerScope: caller.actorId,
        idempotencyKey,
        correlationId: request.mindchestraRequestId
      });

      if (!created.deduplicated) {
        const execPromise = engine.startMission(created.snapshot.id, request.mindchestraRequestId);
        void execPromise.then(releaseObjective, releaseObjective);
      } else {
        releaseObjective();
      }

      return reply.status(202).send(created.snapshot);
    } catch (error) {
      releaseObjective();
      throw error;
    }
  });

  app.get('/v1/missions', async (request) => {
    const query = z
      .object({
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        status: MissionStatusSchema.optional()
      })
      .parse(request.query);

    return repos.listMissions({
      cursor: query.cursor,
      limit: query.limit,
      status: query.status as MissionStatus | undefined
    });
  });

  app.get('/v1/missions/:id', async (request) => {
    const { id } = z.object({ id: IdSchema }).parse(request.params);
    return repos.getMissionSnapshot(id);
  });

  app.get('/v1/missions/:id/result', async (request) => {
    const { id } = z.object({ id: IdSchema }).parse(request.params);
    return repos.getMissionResult(id);
  });

  app.post('/v1/missions/:id/cancel', async (request, reply) => {
    const { id } = z.object({ id: IdSchema }).parse(request.params);
    const snapshot = await engine.cancelMission(id, request.mindchestraRequestId);
    return reply.status(202).send(snapshot);
  });

  app.get('/v1/missions/:id/events', async (request, reply) => {
    const { id: missionId } = z.object({ id: IdSchema }).parse(request.params);
    const query = z
      .object({
        after: z.coerce.number().int().min(0).optional()
      })
      .parse(request.query);

    const lastEventIdHeader = request.headers['last-event-id'];
    let cursor = query.after ?? 0;
    if (typeof lastEventIdHeader === 'string' && lastEventIdHeader.trim().length > 0) {
      const parsedHeader = Number(lastEventIdHeader.trim());
      if (!Number.isInteger(parsedHeader) || parsedHeader < 0) {
        throw new MindchestraError('INVALID_INPUT', 'Last-Event-ID must be a non-negative integer');
      }
      cursor = parsedHeader;
    }

    const snapshot = repos.getMissionSnapshot(missionId);
    const liveQueue: AgentEvent[] = [];
    let closed = false;
    let drainingHistory = true;
    let lastSentSeq = cursor;

    const cleanupRef: { unsubscribe?: () => void; heartbeat?: ReturnType<typeof setInterval> } = {};

    const closeStream = () => {
      if (closed) {
        return;
      }
      closed = true;
      if (cleanupRef.heartbeat) {
        clearInterval(cleanupRef.heartbeat);
      }
      cleanupRef.unsubscribe?.();
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    };

    const writeEvent = (event: AgentEvent) => {
      if (closed || event.seq <= lastSentSeq) {
        return;
      }
      lastSentSeq = event.seq;
      const frame = `id: ${event.seq}\nevent: mission.event\ndata: ${JSON.stringify(event)}\n\n`;
      reply.raw.write(frame);

      if (
        event.type === 'mission.result' ||
        (event.type === 'mission.status' && isTerminalMissionStatus(event.payload.status))
      ) {
        closeStream();
      }
    };

    cleanupRef.unsubscribe = eventStore.subscribe(missionId, (event) => {
      if (closed) {
        return;
      }
      if (drainingHistory) {
        if (liveQueue.length >= sseMaxQueue) {
          closeStream();
          return;
        }
        liveQueue.push(event);
        return;
      }
      writeEvent(event);
    });

    let historical: AgentEvent[];
    try {
      historical = eventStore.listEventsAfter(missionId, cursor, 10000);
    } catch (error) {
      cleanupRef.unsubscribe();
      throw error;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });

    reply.raw.on('close', closeStream);
    request.raw.on('aborted', closeStream);

    for (const event of historical) {
      writeEvent(event);
    }

    drainingHistory = false;
    while (liveQueue.length > 0 && !closed) {
      const buffered = liveQueue.shift()!;
      writeEvent(buffered);
    }

    if (!closed && isTerminalMissionStatus(snapshot.status) && lastSentSeq >= snapshot.lastSeq) {
      closeStream();
      return;
    }

    if (!closed) {
      cleanupRef.heartbeat = setInterval(() => {
        if (!closed && !reply.raw.writableEnded) {
          reply.raw.write(': keepalive\n\n');
        }
      }, sseHeartbeatMs);
    }
  });

  app.get('/v1/missions/:id/evidence', async (request) => {
    const { id } = z.object({ id: IdSchema }).parse(request.params);
    repos.getMissionSnapshot(id);
    return {
      claims: repos.listClaimsByMission(id),
      evidence: repos.listEvidenceByMission(id),
      verdicts: repos.listVerdictsByMission(id),
      nextCursor: null
    };
  });

  app.post('/v1/missions/:id/evidence', async (request, reply) => {
    const caller = request.caller!;
    const { id: missionId } = z.object({ id: IdSchema }).parse(request.params);
    if (caller.missionId && caller.missionId !== missionId) {
      throw new MindchestraError('FORBIDDEN', 'Caller session cannot submit evidence to another mission');
    }
    const snapshot = repos.getMissionSnapshot(missionId);
    const body = z
      .object({
        claimId: IdSchema,
        sourceRef: z.string().min(1).max(1024),
        relation: EvidenceRelationSchema,
        artifactId: IdSchema.optional()
      })
      .strict()
      .parse(request.body);

    const workspace = workspaces.resolveWorkspace(snapshot.spec.workspace);
    if (!workspaces.validateSourceRef(workspace.canonicalPath, body.sourceRef)) {
      throw new MindchestraError('INVALID_INPUT', 'Invalid or unsafe sourceRef path');
    }

    let sha256: string | undefined;
    if (body.artifactId) {
      const meta = artifacts.getArtifactMetadata(body.artifactId);
      if (meta.missionId !== missionId) {
        throw new MindchestraError('FORBIDDEN', 'Artifact does not belong to this mission');
      }
      sha256 = meta.sha256;
    }

    const evidenceId = randomUUID();
    const at = new Date().toISOString();
    const evidence = {
      id: evidenceId,
      missionId,
      claimId: body.claimId,
      kind: 'source' as const,
      relation: body.relation,
      sourceRef: body.sourceRef,
      ...(body.artifactId ? { artifactId: body.artifactId } : {}),
      ...(sha256 ? { sha256 } : {}),
      ...(snapshot.baseCommit ? { baseCommit: snapshot.baseCommit } : {}),
      at,
      provenance: 'agent_report' as const,
      status: 'unverified' as const
    };
    repos.insertEvidence(evidence);
    eventStore.appendEvent({
      missionId,
      actor: caller.actorId,
      correlationId: request.mindchestraRequestId ?? randomUUID(),
      runId: caller.runId,
      at,
      payload: { type: 'evidence.added', payload: evidence }
    });
    return reply.status(201).send({ evidenceId });
  });

  app.post('/v1/missions/:id/messages', async (request, reply) => {
    const caller = request.caller!;
    const { id: missionId } = z.object({ id: IdSchema }).parse(request.params);
    if (caller.missionId && caller.missionId !== missionId) {
      throw new MindchestraError('FORBIDDEN', 'Caller session cannot message another mission');
    }
    const body = z
      .object({
        recipientAgentId: z.union([z.literal('all'), SlugIdSchema]),
        text: z.string().min(1).max(20000),
        relatedClaimIds: z.array(IdSchema).default([])
      })
      .strict()
      .parse(request.body);

    const senderRunId = caller.runId ?? randomUUID();
    const sent = engine.getMailbox().sendMessage({
      missionId,
      senderRunId,
      actor: caller.actorId,
      correlationId: request.mindchestraRequestId ?? randomUUID(),
      recipientAgentId: body.recipientAgentId,
      text: body.text,
      relatedClaimIds: body.relatedClaimIds
    });
    return reply.status(201).send({ messageId: sent.message.id });
  });

  app.get('/v1/missions/:id/artifacts', async (request) => {
    const { id } = z.object({ id: IdSchema }).parse(request.params);
    repos.getMissionSnapshot(id);
    const items = artifacts.listArtifactsByMission(id);
    return { items, nextCursor: null };
  });

  app.get('/v1/artifacts/:id', async (request, reply) => {
    const { id } = z.object({ id: IdSchema }).parse(request.params);
    const { metadata, data } = artifacts.readArtifactBlob(id);
    reply.header('content-type', metadata.contentType);
    reply.header('x-content-sha256', metadata.sha256);
    reply.header('x-content-type-options', 'nosniff');
    return reply.status(200).send(data);
  });

  app.get('/v1/missions/:id/replay', async (request) => {
    const { id } = z.object({ id: IdSchema }).parse(request.params);
    const query = z
      .object({
        upToSeq: z.coerce.number().int().positive().optional()
      })
      .parse(request.query);
    const events = eventStore.listEventsAfter(id, 0, 10000);
    return replayProjector.project(events, query.upToSeq);
  });

  app.post('/v1/missions/:id/rerun', async (request, reply) => {
    const caller = request.caller!;
    if (caller.role !== 'user') {
      throw new MindchestraError('FORBIDDEN', 'Only user sessions may trigger mission rerun');
    }
    const { id } = z.object({ id: IdSchema }).parse(request.params);
    const original = repos.getMissionSnapshot(id);
    const created = engine.createMission(original.spec, {
      callerScope: caller.actorId,
      correlationId: request.mindchestraRequestId,
      parentMissionId: original.id
    });
    void engine.startMission(created.snapshot.id, request.mindchestraRequestId);
    return reply.status(202).send(created.snapshot);
  });

  app.get('/v1/agents', async () => {
    const registered = adapters.listAdapters();
    const storedConfigs = new Map(repos.listAgentConfigs().map((item) => [item.config.id, item]));
    const items: AgentSummary[] = registered.map((adapter) => {
      const manifest = adapter.manifest();
      const stored = storedConfigs.get(manifest.id);
      return {
        manifest,
        probe: stored?.probe ?? null
      };
    });
    return { items };
  });

  app.post('/v1/agents', async (request, reply) => {
    const caller = request.caller!;
    if (caller.role !== 'user') {
      throw new MindchestraError('FORBIDDEN', 'Only user sessions may configure agents');
    }
    const config = sanitizeAgentConfig(AgentConfigSchema.parse(request.body));
    const adapter = adapters.getAdapter(config.adapterId);
    if (!adapter) {
      throw new MindchestraError('NOT_FOUND', `Base adapter ${config.adapterId} is not registered`);
    }
    repos.upsertAgentConfig(config);
    const stored = repos.getAgentConfig(config.id);
    return reply.status(201).send({
      manifest: adapter.manifest(),
      probe: stored?.probe ?? null
    });
  });

  app.post('/v1/agents/:id/probe', async (request) => {
    const { id } = z.object({ id: SlugIdSchema }).parse(request.params);
    const adapter = adapters.getAdapter(id);
    if (!adapter) {
      throw new MindchestraError('NOT_FOUND', `Agent ${id} is not registered`);
    }
    const probeController = new AbortController();
    const timer = setTimeout(() => probeController.abort(), 5000);
    try {
      const probe = await adapter.probe(probeController.signal);
      if (!repos.getAgentConfig(id)) {
        repos.upsertAgentConfig({ id, adapterId: id });
      }
      repos.updateAgentProbe(id, probe);
      return probe;
    } finally {
      clearTimeout(timer);
    }
  });

  app.delete('/v1/agents/:id', async (request, reply) => {
    const caller = request.caller!;
    if (caller.role !== 'user') {
      throw new MindchestraError('FORBIDDEN', 'Only user sessions may remove agents');
    }
    const { id } = z.object({ id: SlugIdSchema }).parse(request.params);
    repos.deleteAgentConfig(id);
    return reply.status(204).send();
  });

  app.get('/v1/workspaces', async () => {
    return { items: workspaces.listWorkspaces() };
  });

  app.post('/v1/workspaces', async (request, reply) => {
    const caller = request.caller!;
    if (caller.role !== 'user') {
      throw new MindchestraError('FORBIDDEN', 'Only user sessions may register workspaces');
    }
    const body = WorkspaceCreateInputSchema.parse(request.body);
    const summary = workspaces.registerWorkspace(body);
    return reply.status(201).send(summary);
  });

  app.get('/v1/mcp/servers', async () => {
    return { items: gateway.listServers() };
  });

  app.post('/v1/mcp/servers', async (request, reply) => {
    const caller = request.caller!;
    if (caller.role !== 'user') {
      throw new MindchestraError('FORBIDDEN', 'Only user sessions may register MCP servers');
    }
    const config = MCPServerConfigSchema.parse(request.body);
    const summary = gateway.registerServer(config);
    return reply.status(201).send(summary);
  });

  app.post('/v1/mcp/servers/:id/probe', async (request) => {
    const { id } = z.object({ id: SlugIdSchema }).parse(request.params);
    return gateway.probeServer(id);
  });

  app.get('/v1/mcp/servers/:id/tools', async (request) => {
    const { id } = z.object({ id: SlugIdSchema }).parse(request.params);
    return { items: gateway.listServerTools(id) };
  });

  app.get('/v1/mcp/tools/discover', async (request) => {
    const query = z.object({ serverId: SlugIdSchema.optional() }).parse(request.query);
    return { items: gateway.discoverNamespacedTools(query.serverId) };
  });

  app.post('/v1/mcp/tools/invoke', async (request) => {
    const caller = request.caller!;
    const body = z
      .object({
        missionId: IdSchema,
        serverId: SlugIdSchema,
        toolName: z.string().min(1).max(256),
        arguments: z.record(z.string(), z.unknown()),
        claimId: IdSchema.optional(),
        grantId: IdSchema.optional(),
        approvalId: IdSchema.optional()
      })
      .strict()
      .parse(request.body);

    const snapshot = repos.getMissionSnapshot(body.missionId);
    const agentId = caller.role === 'agent' ? caller.actorId : snapshot.spec.agents[0]!;
    const runId = caller.runId ?? randomUUID();

    return gateway.invokeTool({
      caller,
      missionId: body.missionId,
      runId,
      agentId,
      profile: snapshot.spec.profile,
      serverId: body.serverId,
      toolName: body.toolName,
      arguments: body.arguments,
      claimId: body.claimId,
      grantId: body.grantId,
      approvalId: body.approvalId,
      baseCommit: snapshot.baseCommit,
      correlationId: request.mindchestraRequestId
    });
  });

  app.get('/v1/approvals', async (request) => {
    const query = z
      .object({
        missionId: IdSchema.optional(),
        status: z.enum(['pending', 'approved', 'denied', 'expired', 'consumed']).optional()
      })
      .parse(request.query);
    return {
      items: repos.listApprovals({
        missionId: query.missionId,
        status: query.status as ApprovalStatus | undefined
      })
    };
  });

  app.post('/v1/approvals/:id/decision', async (request) => {
    const caller = request.caller!;
    recursiveGuard.assertCanDecideApproval(caller);
    const { id } = z.object({ id: IdSchema }).parse(request.params);
    const input = ApprovalInputSchema.parse(request.body);
    const result = repos.decideApprovalAtomic(id, input, caller.actorId);

    eventStore.appendEvent({
      missionId: result.request.missionId,
      actor: caller.actorId,
      correlationId: request.mindchestraRequestId ?? randomUUID(),
      runId: result.request.runId,
      at: result.decision.decidedAt,
      payload: {
        type: 'approval.decided',
        payload: result.decision
      }
    });

    return result.decision;
  });

  return {
    app,
    db,
    eventStore,
    repos,
    artifacts,
    policy,
    workspaces,
    gateway,
    engine,
    auth,
    adapters,
    async close() {
      await app.close();
      await engine.shutdown();
      db.close();
    }
  };
}
