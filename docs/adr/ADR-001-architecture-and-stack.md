# ADR-001: Architecture and Core Technology Stack

- Status: Accepted
- Date: 2026-11-15
- Scope: Repository Foundation

## Context

Mindchestra requires a local-first orchestration daemon with strict runtime boundary validation, deterministic state persistence, and clean separation between engine contracts, persistence, policy enforcement, and concrete provider integrations.

## Decisions

1. **Workspace and Language**: TypeScript (`~5.8.2`) with `strict: true`, `noUncheckedIndexedAccess: true`, ESM (`NodeNext`), managed as a `pnpm` monorepo (`pnpm@11.5.1`) targeting Node.js `>=22.0.0`.
2. **Runtime Contract Authority**: Zod (`~3.24.2`) schemas in `packages/contracts` are the single canonical definition for runtime validation, TypeScript type inference, and OpenAPI schema parity.
3. **Persistence**: SQLite via Node built-in `node:sqlite` (`DatabaseSync`) configured with `WAL` journal mode, `foreign_keys = ON`, and single-writer `BEGIN IMMEDIATE` transactions. Large payloads are stored in a content-addressed blob directory backed by SHA-256 verification.
4. **Daemon Authority**: `apps/daemon` exposes a loopback-only Fastify (`~5.2.1`) HTTP + SSE API (`/v1`) and acts as the composition root injecting concrete adapters, storage, policy, and gateway services into `@mindchestra/core`. Core packages never import concrete provider adapters or UI modules.
5. **MCP Protocol**: Official `@modelcontextprotocol/sdk` (`~1.6.1`) with separate upstream stdio facade (`packages/mcp-server`) and downstream client gateway (`packages/mcp-gateway`).
6. **Testing**: Deterministic unit, contract, security, and integration tests using Vitest (`~3.0.8`) with zero live provider calls or external network dependencies in CI.

## Consequences

- Provider integrations and user interfaces evolve independently behind frozen `@mindchestra/contracts` interfaces.
- Every state transition and event sequence number is durably recorded and replayable without re-invoking external side effects.
