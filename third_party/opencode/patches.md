# OpenCode adaptation record

Snapshot: `45cd8d76920839e4a7b6b931c4e26b52e1495636`.

Machine-verifiable source/destination edges, current destination hashes and the
bounded branding/protocol exceptions are recorded in
[`PROVENANCE.json`](PROVENANCE.json). This file supplies the human rationale
for the patch IDs used by that manifest.

## Applied material

### P0001 — Preserve upstream license and establish a fixed source boundary

- Upstream source: `LICENSE`.
- Ralph destination: `third_party/opencode/LICENSE`.
- Change: newline normalization to the repository's required LF convention;
  license wording and copyright notice are unchanged.
- Reason: distribute the required MIT notice with every curated derivation.
- Verification: `tests/unit/opencode-provenance.test.ts` hashes the LF content
  and checks the public notice and provenance documents.

## P0002 — Embed the bounded ChatGPT Codex account protocol

- Upstream source: `packages/opencode/src/plugin/openai/codex.ts`, blob
  `d16b7495654c8da0bc1522d9e96118162ff9489f`.
- Ralph destinations: `packages/openai-driver/src/protocol.ts`,
  `packages/openai-driver/src/device-auth.ts` and
  `packages/openai-driver/src/driver.ts`, plus the bounded protocol composition
  in `apps/ralph-cli/src/s04-services.ts`.
- Retained behavior: browser OAuth with state/PKCE/callback validation, device
  authorization polling, refresh, defensive account-ID extraction, fixed Codex
  Responses endpoint transformation and the pinned subscription-model policy.
- Removed behavior: OpenCode plugin/session hooks, websocket pool, installation
  and version identity, OpenCode settings and user agent, product UI and every
  application-state dependency.
- Ralph changes: injectable `ralph-next/...` user agent; independent API-key and
  subscription drivers; bounded timeout/cancel; sanitized failure taxonomy;
  composition of the pinned issuer/client/scopes/callback and account metadata
  parameters behind Ralph credential commands; read-only smoke request with
  `store: false` and no tools; protocol drift and subscription eligibility fail
  closed.
- Ralph hardening (`2026-07-18`): one absolute deadline spans refresh, request
  and response consumption; concurrent refresh waiters keep independent
  cancellation budgets; sinks are fenced after settlement; JSON/SSE bytes,
  structure depth/nodes, frames and normalized events are bounded; provider
  sequence and terminal ordering fail closed; raw records retain summaries but
  replace private reasoning; mixed usage preserves nonnegative provenance; and
  provider failures cross the Ralph event adapter as sanitized
  `model.provider.error` plus terminal evidence.
- Protocol exception: the request parameter `originator=opencode` is retained
  exactly because it is part of the pinned upstream authorization/request
  protocol. It is not used as the User-Agent, CLI identity, UI branding or an
  affiliation claim; changing it requires a reviewed protocol refresh.
- Dependencies: only platform Web APIs; no OpenCode package, AI SDK or
  subprocess dependency was introduced. In particular, this code never invokes
  the `codex` executable and never substitutes an API key for a subscription.
- Verification: `tests/unit/openai-driver-*.test.ts`,
  `tests/unit/s04-services.test.ts`,
  `tests/integration/openai-driver-subscription-smoke.test.ts` and the real
  opt-in ChatGPT harness, including browser-to-token integration, device-flow,
  protocol, driver, golden streams and dependency boundary tests;
  `tests/unit/opencode-provenance.test.ts` verifies this map.
- Risk and rollback: upstream can change undocumented account behavior. The
  exact snapshot remains the rollback authority; a protocol mismatch disables
  this method until a reviewed vendor refresh.

## Reference-only credential records

Potential source: `packages/opencode/src/auth/index.ts`.

Only lifecycle/schema concepts may inform Ralph-owned contracts. Do not carry
over global `auth.json`, plaintext secret persistence, OpenCode Global/FSUtil or
Effect application layers. Ralph config stores `CredentialRef`; secret bytes
remain in the selected secret store and never cross public events.

## P0003 — Curate provider and model metadata behind Ralph ports

Upstream sources:

- `packages/opencode/src/provider/provider.ts`;
- `packages/core/src/models-dev.ts`;
- `packages/core/src/model.ts`;
- `packages/core/src/provider.ts`.

- Ralph destinations: `packages/providers/src/contracts.ts`, `catalog.ts`,
  `curated.ts`, `models-dev.ts`, `file-cache.ts`, `registry.ts` and `runtime.ts`.
- Retained behavior: bounded normalization of provider/model metadata and
  capability/limit/variant/access/price fields, lazy registry behavior, cache
  TTL, atomic refresh and stale/fallback snapshot semantics.
- Removed behavior: upstream public schemas, Effect layers, global state,
  event bus, config/session logic, dynamic npm loading, fuzzy search and the
  full AI SDK provider matrix.
- Ralph changes: strict Zod-owned public contracts, content-addressed validated
  cache, explicit pricing applicability, deterministic capability filtering,
  explicit fallback classes and data-only Models.dev ingestion. Remote metadata
  is parsed as untrusted data and cannot execute code.
- Dependencies: Zod and platform filesystem/crypto/fetch only; no OpenCode or
  provider runtime dependency was copied.
- Verification: `packages/providers/tests/**`, public generated JSON Schemas and
  `tests/unit/opencode-provenance.test.ts`.
- Risk and rollback: metadata shape drift fails closed and falls back to the
  pinned curated Ralph snapshot. A source refresh requires the manual process in
  `UPSTREAM.md`.

## Dependencies deliberately not carried over

- `@opencode-ai/*` workspace/private packages;
- OpenCode session, server, storage, database, config, plugin and event layers;
- `effect` and OpenCode-specific Effect application infrastructure;
- the full `ai` / `@ai-sdk/*` provider matrix;
- `fuzzysort`, `remeda`, dynamic npm imports and provider package installers;
- `OpenAIWebSocketPool` and OpenCode's OAuth callback page component;
- branding, commands, TUI application, assets and identity.

A later Ralph implementation may independently select a public library after
license and dependency review. Such a selection is not a copied OpenCode
dependency and must be recorded in the normal manifest, lockfile and SBOM.

## Update discipline

Every future patch entry must contain:

1. upstream path, fixed commit, Git blob ID and SHA-256;
2. all Ralph destination paths;
3. behavior retained, behavior removed and Ralph-specific changes;
4. dependencies introduced or deliberately eliminated;
5. contract/golden/security tests that cover the port; and
6. protocol or migration risk and rollback path.

Update `UPSTREAM.md`, `PROVENANCE.json`, `copied-files.md`, this file and
`THIRD_PARTY_NOTICES.md` in the same commit as any derived source.
