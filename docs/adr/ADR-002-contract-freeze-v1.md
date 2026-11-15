# ADR-002: Contract Freeze v1

- Status: Accepted
- Date: 2026-11-15
- Scope: `packages/contracts`, HTTP `/v1`, SSE, and Upstream MCP Surface

## Decisions

1. **Versioning & Naming**:
   - `schemaVersion` is locked to `1` for v1 contracts.
   - All JSON fields use `camelCase`. Event types use `dot.notation`. HTTP endpoints live exclusively under `/v1`.
   - Generated entity IDs are UUID v4 strings; registry slugs match `^[a-z0-9][a-z0-9-_]{0,63}$`.
   - All timestamps use UTC ISO-8601 strings.
   - Missing optional fields are omitted (`undefined` is never serialized into JSON); unmeasured or unknown numeric metrics are explicitly `null`.
2. **AdapterEvent vs AgentEvent**:
   - Adapters yield normalized `AdapterEvent` inputs without inventing sequence numbers, event IDs, or correlation metadata.
   - The daemon assigns `seq` (monotonically increasing per mission), `id`, `missionId`, `actor`, `at`, `correlationId`, and optional `runId`/`causationId` when persisting an immutable `AgentEvent`.
3. **Pagination & Error Envelopes**:
   - List endpoints accept opaque `cursor` and `limit` (default `50`, maximum `200`) and return `{ items, nextCursor }`.
   - Non-2xx responses use `{ error: { code, message, retryable, requestId?, details? } }`.
4. **Approval Fingerprints**:
   - Approval requests and decisions bind an immutable SHA-256 `actionHash` computed over canonical JSON of `{ missionId, runId, action, target, argsOrPatchHash, schemaHash, policyVersion, baseCommit }`.
5. **v0.1 Feature Scope**:
   - Supported modes in v0.1 are `council`, `parallel`, and `review` (max 3 agents per mission in v0.1). Unsupported enum modes return `400 UNSUPPORTED`.
   - Live write execution remains disabled in `read-only` v0.1; pending approval flows return structured approval requests without performing mutations.
