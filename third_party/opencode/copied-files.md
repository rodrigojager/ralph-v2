# OpenCode source map

This file is the positive provenance list for OpenCode material used by Ralph
v2. Paths and hashes refer to commit
`45cd8d76920839e4a7b6b931c4e26b52e1495636`.

The same inventory is encoded for deterministic release verification in
[`PROVENANCE.json`](PROVENANCE.json). This Markdown file remains the
human-oriented explanation; the JSON manifest supplies the exact source,
destination, patch, digest and branding-policy records.

Classifications:

- `copied`: bytes are preserved in this repository;
- `derived`: Ralph source contains a substantial adaptation of upstream
  expression or protocol implementation and therefore needs a destination and
  patch record;
- `reference-only`: concepts were studied, but no upstream source expression
  is claimed as copied into Ralph by this record;
- `excluded`: the source or subsystem must not enter Ralph without a new,
  explicit provenance review.

## Copied material

| Classification | Upstream path | SHA-256 (LF) | Ralph destination | Purpose |
| --- | --- | --- | --- | --- |
| copied | `LICENSE` | `625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b` | `third_party/opencode/LICENSE` | Preserve the exact MIT notice required for the curated source. |

The audited Windows checkout SHA-256 for `LICENSE` was
`b5c625d157735f04e1b2b7ceccee849130b554bdb23cd58db55a38a257efbbdd`.

## Reviewed source inventory

These files are the complete reviewed inputs to the S04 port. A `derived`
entry names every Ralph destination that carries the bounded adaptation. A
`reference-only` entry records study without claiming copied expression.

| Classification | Upstream path | SHA-256 in audited Windows checkout | SHA-256 (LF) | Ralph destination | Reviewed use |
| --- | --- | --- | --- | --- | --- |
| derived | `packages/opencode/src/plugin/openai/codex.ts` | `1ceef8facd9b537bcb328d9ea6898f555d525fb01cebbb2e7b1d482df514fb78` | `f3f9525559c5774ab420ed3c425fd13dfd16fdffd1140345ee510d79f0efd5df` | `packages/openai-driver/src/protocol.ts`; `packages/openai-driver/src/device-auth.ts`; `packages/openai-driver/src/driver.ts`; `apps/ralph-cli/src/s04-services.ts` | Bounded OAuth/PKCE, device flow, refresh/account ID, protocol-specific account composition and embedded Codex request behavior. |
| derived | `packages/opencode/src/provider/provider.ts` | `fca4c0686dc6c3ee4ccb63d2401af9f4f205356e77316793e3df87a5eefe8e09` | `dbcf86afd30352ac21104a07433bde2e40d2c98d67d15f62c201b4e06780ce4e` | `packages/providers/src/contracts.ts`; `packages/providers/src/curated.ts`; `packages/providers/src/registry.ts` | Provider/model normalization and lazy capability-routing boundary. |
| reference-only | `packages/opencode/src/auth/index.ts` | `6b174df5b71cbed1ba1887f201f2357511c2563abbfb88919150e6e8fc930e43` | `dc897ff4b04dba1ed81f3fe24cdce7289ae32acc6bac60bc430a884bb60ad5b0` | none yet | Credential lifecycle shapes only; plaintext persistence is rejected. |
| derived | `packages/core/src/models-dev.ts` | `e6d49702b893225a21f55fa2f01ccdc3e1cd4aa484e92d3dfe37e65f60233c76` | `236c8e3ecfaf33da7c1cf194316367cce3868a3c66c57e2cc7d62746f8457d50` | `packages/providers/src/models-dev.ts`; `packages/providers/src/file-cache.ts`; `packages/providers/src/runtime.ts` | Validated data-only refresh, cache TTL and atomic snapshot behavior. |
| derived | `packages/core/src/model.ts` | `8f7f41ea76733a53b39c5dc2b3b29ca9f7597ca9b877a45a9c86dc76d839058b` | `e4825ddfa8bceadccaffb9572092ea1628892f42be1f37beeeeb92c2deb28f8c` | `packages/providers/src/contracts.ts`; `packages/providers/src/catalog.ts`; `packages/providers/src/curated.ts` | Ralph-owned model metadata, capabilities, variants, access and pricing snapshots. |
| derived | `packages/core/src/provider.ts` | `a3ed3133952b52ae847615ddb40166b6398ed9c3cb0b3db6ce909479269b3921` | `ec95c474575bc7e4be36f7286b7b883c6bb92e685c8e5b31bac3fe97cab9edc4` | `packages/providers/src/contracts.ts`; `packages/providers/src/curated.ts`; `packages/providers/src/registry.ts` | Ralph-owned provider identity, credential methods and lazy lookup contracts. |

No other OpenCode source is authorized by implication. A source file used for
copying or substantial adaptation must first be added here with commit, hash,
destination and corresponding tests.

## Excluded subsystems

| Classification | Upstream area | Reason |
| --- | --- | --- |
| excluded | `packages/core/src/session/runner/**` and all agent/session loops | Would invert Ralph's command-authoritative architecture. |
| excluded | server, database, storage and application state | Ralph owns its ledger, events and lifecycle. |
| excluded | complete plugin host and provider resolver | Only bounded driver behavior belongs behind Ralph ports. |
| excluded | OpenCode commands, branding, logo, assets and product UI | No product identity or misleading affiliation is copied. |
| excluded | `auth.json` storage behavior | It persists plaintext credentials; Ralph stores only credential references in config. |
| excluded | dynamic npm loading/provider installation | Release behavior must be deterministic and dependency-reviewed. |
| excluded | private `@opencode-ai/*` workspace packages and internal aliases | They are not assumed to be public/stable dependencies. |
| excluded | unlisted files and transitive source dependencies | Positive inventory is required; reachability is not authorization. |

## Maintenance rule

`scripts/opencode-provenance.ts` and `tests/unit/opencode-provenance.test.ts`
form the local license/provenance gate. They verify the fixed commit, the copied
license content, every current destination hash, the complete reviewed hash
inventory, required exclusions, explicit protocol/attribution occurrences and
absence of OpenCode/private-workspace dependencies. Update the structured
manifest, test and this map together during a reviewed vendor refresh; never
weaken the gate merely to accept a floating source.

The `2026-07-18` Ralph-side hardening changed only already-listed derived
destinations. It introduced no new upstream input: response privacy/bounds,
deadline fencing, normalized failure events, atomic secret rotation and exact
catalog snapshot use remain bounded Ralph adaptations of the same positive
inventory above.
