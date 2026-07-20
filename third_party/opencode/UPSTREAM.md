# OpenCode upstream snapshot

## Fixed source

- Repository: <https://github.com/anomalyco/opencode>
- Commit: `45cd8d76920839e4a7b6b931c4e26b52e1495636`
- Commit timestamp: `2026-07-17T17:10:37-04:00`
- Commit subject: `update zen models`
- Upstream package version at this commit: `1.18.3`
- License: MIT
- Copyright notice: `Copyright (c) 2025 opencode`
- License copy: [`LICENSE`](LICENSE)
- Structured provenance manifest: [`PROVENANCE.json`](PROVENANCE.json)
- Structured provenance SHA-256: `94217bef8ecd2f4b375e13eac0c7831578d70d7ca9d0e022ebb199456183b97f`
- Snapshot verified: `2026-07-18`

The Ralph-side S04 adaptation was security-hardened again on `2026-07-18`
without changing the upstream snapshot or expanding its positive source
inventory. The review added absolute call deadlines, bounded response
structure/event counts, terminal-order checks, private-reasoning omission,
atomic credential rotation and single-snapshot catalog provenance. Upstream
blob and content hashes below therefore remain unchanged.

The commit, not a branch or tag, is the provenance authority. Ralph v2 does
not fetch code from `main`, `dev`, a floating tag, or a package range during
build or release. The snapshot is an input to a curated port, not a runtime
dependency on the OpenCode application or agent/session runner.

## Verification record

The snapshot was checked out at the exact commit above and verified with
`git rev-parse HEAD`, `git show -s --format=%H%n%cI%n%s HEAD`, the MIT license
text, and SHA-256 hashes. Git blob IDs are included so the source can be
verified independently of checkout newline conversion.

| Upstream path | Git blob ID | SHA-256 in audited Windows checkout | SHA-256 after LF normalization |
| --- | --- | --- | --- |
| `LICENSE` | `6439474beed8e0271df9862eff97ffd70ec2464c` | `b5c625d157735f04e1b2b7ceccee849130b554bdb23cd58db55a38a257efbbdd` | `625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b` |
| `packages/opencode/src/plugin/openai/codex.ts` | `d16b7495654c8da0bc1522d9e96118162ff9489f` | `1ceef8facd9b537bcb328d9ea6898f555d525fb01cebbb2e7b1d482df514fb78` | `f3f9525559c5774ab420ed3c425fd13dfd16fdffd1140345ee510d79f0efd5df` |
| `packages/opencode/src/provider/provider.ts` | `5ac916e412a8ff95465780dedf4c911d7be1dadf` | `fca4c0686dc6c3ee4ccb63d2401af9f4f205356e77316793e3df87a5eefe8e09` | `dbcf86afd30352ac21104a07433bde2e40d2c98d67d15f62c201b4e06780ce4e` |
| `packages/opencode/src/auth/index.ts` | `a133e88498d5b2c3b274f3e7eb7a1d63f59a7851` | `6b174df5b71cbed1ba1887f201f2357511c2563abbfb88919150e6e8fc930e43` | `dc897ff4b04dba1ed81f3fe24cdce7289ae32acc6bac60bc430a884bb60ad5b0` |
| `packages/core/src/models-dev.ts` | `602133d9047a3d168408afaa5d7530c3e4df2917` | `e6d49702b893225a21f55fa2f01ccdc3e1cd4aa484e92d3dfe37e65f60233c76` | `236c8e3ecfaf33da7c1cf194316367cce3868a3c66c57e2cc7d62746f8457d50` |
| `packages/core/src/model.ts` | `52fff98733b11acdd292115bd4dabe320ebc592f` | `8f7f41ea76733a53b39c5dc2b3b29ca9f7597ca9b877a45a9c86dc76d839058b` | `e4825ddfa8bceadccaffb9572092ea1628892f42be1f37beeeeb92c2deb28f8c` |
| `packages/core/src/provider.ts` | `03f7d7eef378ce8843c31635bbe95956d8f1ae5a` | `a3ed3133952b52ae847615ddb40166b6398ed9c3cb0b3db6ce909479269b3921` | `ec95c474575bc7e4be36f7286b7b883c6bb92e685c8e5b31bac3fe97cab9edc4` |

The Windows-checkout hashes above intentionally describe the CRLF working
tree that was audited. The LF-normalized hashes are stable for this repository,
whose `.gitattributes` requires LF. The copied license's normalized digest is
enforced by the provenance test.

## Approved scope

The positive inventory is intentionally small:

- provider/model metadata shapes and capability-normalization concepts;
- Models.dev cache, TTL and atomic-refresh behavior;
- OpenAI/Codex account OAuth, PKCE, refresh, account-ID and request-rewrite
  behavior needed for an embedded ChatGPT subscription driver;
- credential method and lifecycle concepts.

[`PROVENANCE.json`](PROVENANCE.json) is the deterministic positive inventory;
[`copied-files.md`](copied-files.md) is its human-oriented source map. Only code
expression actually carried into Ralph is classified as `derived`. A reviewed source can remain
`reference-only`; its presence in this inventory does not claim that it was
copied. Every future derivation must add its Ralph destination and patch notes
in the same commit that introduces the derived code.

The current derivations are limited to the embedded ChatGPT Codex account
protocol in `packages/openai-driver` plus its Ralph composition in
`apps/ralph-cli/src/s04-services.ts`, and bounded provider/catalog normalization
and cache behavior in `packages/providers`. Credential persistence remains a
Ralph-owned implementation: upstream plaintext `auth.json` behavior is only
`reference-only` and was explicitly rejected.

## Explicit exclusions

Ralph does not copy or embed OpenCode's:

- agent/session loop, task selection, completion or permission policy;
- session runner, server, database, storage or application state;
- command handlers, plugin host or full provider resolver;
- branding, name, logo, themes or product identity;
- TUI application or session UI;
- dynamic npm provider installation;
- plaintext `auth.json` credential persistence;
- private workspace packages or internal path aliases as dependencies;
- source files not individually listed and hashed in `PROVENANCE.json` and
  explained in `copied-files.md`.

The Ralph CLI remains the authority. OpenCode code and protocols are inputs to
drivers behind Ralph-owned ports; they cannot select tasks, authorize tools,
change policy, persist completion, or start child runs.

## Dependency decision

No OpenCode package is vendored or installed as a Ralph dependency by this
snapshot record. In particular, the port does not copy the dependency graph of
`packages/opencode` or `packages/core`: `@opencode-ai/*` workspace packages,
Effect infrastructure, the OpenCode plugin/session/server/storage layers,
`fuzzysort`, `remeda`, and the full AI SDK/provider matrix are excluded.

If a public third-party package is later needed directly by a Ralph driver, it
must be added deliberately to Ralph's manifest and lockfile, receive its own
license review, and appear in the dependency/SBOM gate. That is a normal Ralph
dependency decision, not an implicit transitive copy from OpenCode.

Models.dev metadata is remote data, not vendored source. Any runtime use must
validate Ralph-owned schemas, record origin and retrieval time, retain a local
snapshot with an explicit TTL, and fail without executing downloaded code.

## Manual vendor refresh

There is no automatic vendor update. A refresh must:

1. create a review branch named `vendor/opencode-<commit>`;
2. select and fetch an exact candidate commit;
3. reconfirm the repository license and copyright notice at that commit;
4. diff every currently inventoried source and review auth/protocol changes;
5. review advisories and licenses for any newly proposed direct dependency;
6. update `UPSTREAM.md`, `PROVENANCE.json`, `copied-files.md`, `patches.md`, the
   copied license, and `THIRD_PARTY_NOTICES.md` atomically;
7. update source/blob/SHA-256 hashes and every derived destination;
8. run the provenance gate plus affected provider, catalog, auth and golden
   stream tests, including a real opt-in smoke when protocol eligibility can
   be verified;
9. record the reviewer, date, behavioral changes and rollback commit in the
   refresh change; and
10. merge only after review. Release builds must never download upstream source.

Protocol drift, especially in subscription authentication, fails closed. It
does not silently switch to an API key, an external CLI, or another provider.
