# Third-party notices

Ralph v2 contains a copied license notice and bounded curated adaptations from
the OpenCode project. OpenCode is not bundled as an application, agent,
session runner or runtime dependency.

## OpenCode

- Project: OpenCode
- Source: <https://github.com/anomalyco/opencode>
- Fixed commit: `45cd8d76920839e4a7b6b931c4e26b52e1495636`
- Upstream version at snapshot: `1.18.3`
- License: MIT
- Copyright: Copyright (c) 2025 opencode
- License text: [`third_party/opencode/LICENSE`](third_party/opencode/LICENSE)
- Provenance and refresh policy:
  [`third_party/opencode/UPSTREAM.md`](third_party/opencode/UPSTREAM.md)
- Deterministic provenance manifest:
  [`third_party/opencode/PROVENANCE.json`](third_party/opencode/PROVENANCE.json)
- Source-to-destination map:
  [`third_party/opencode/copied-files.md`](third_party/opencode/copied-files.md)
- Adaptation record:
  [`third_party/opencode/patches.md`](third_party/opencode/patches.md)

The OpenCode name and project identity identify the upstream source only. They
do not imply sponsorship, endorsement or affiliation. Ralph does not copy the
OpenCode logo, branding or product UI.

The full MIT license text is reproduced in the linked file and must accompany
source distributions and release artifacts that contain OpenCode-derived
material. Release artifacts preserve these linked human-readable provenance
paths in addition to the canonical hashed inventory under
`third_party/licenses/`. Future direct dependencies remain subject to their own
notices, license review, lockfile and SBOM records; they are not covered merely
by this OpenCode notice.

The `2026-07-18` response-safety, deadline, catalog-provenance and credential
atomicity hardening modifies only Ralph-owned adaptation code. It does not add
another OpenCode source file, package, runtime component or product identity.

## Bun embedded runtime

- Project: Bun
- Source: <https://github.com/oven-sh/bun>
- Release: <https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14>
- Exact version: `1.3.14`
- Exact revision: `0d9b296af33f2b851fcbf4df3e9ec89751734ba4`
- Official license/linked-library notice matrix:
  [`third_party/bun/runtime/1.3.14/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/LICENSE.md`](third_party/bun/runtime/1.3.14/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/LICENSE.md)
- Release, tag, commit, blob and target-asset receipts:
  [`third_party/bun/runtime/1.3.14/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/PROVENANCE.md`](third_party/bun/runtime/1.3.14/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/PROVENANCE.md)
- Deterministic curation manifest:
  [`third_party/bun/runtime/1.3.14/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/CURATION.json`](third_party/bun/runtime/1.3.14/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/CURATION.json)

Standalone Ralph artifacts embed the Bun runtime. Bun's official notice identifies Bun's own MIT
license together with JavaScriptCore/WebKit, linked-library, embedded-polyfill and credit material;
the copied upstream matrix must accompany the runtime. The local manifest binds the exact bytes
used for packaging and does not replace the upstream obligations or constitute a legal opinion.

## Complete artifact inventory

The source notice above is not a substitute for the texts required by every
runtime dependency. Each npm and standalone artifact must also contain
`third_party/licenses/manifest.json` and the files referenced by that manifest.
The release packagers derive this inventory from the exact serialized SBOM,
resolve every exact npm name/version in the installed immutable Bun store,
require at least one top-level `LICENSE`, `LICENCE` or `COPYING` text, include
every matching `NOTICE` text, and record the copied file size and SHA-256. A
package without real text, ambiguous peer variants with different text, an
unknown non-npm component, a symlink or an unbounded/non-UTF-8 file blocks the
artifact. Package metadata alone never supplies or reconstructs license text.

Standalone artifacts additionally embed a separately curated local bundle for
the exact Bun runtime version and 40-character revision recorded by engine and
launcher build metadata. The packager never downloads that material and never
infers Bun's license from a package field. If the exact bounded curation bundle
and its provenance receipt are absent or disagree, standalone packaging fails
closed. The npm artifact does not embed Bun itself and therefore inventories
its exact npm runtime graph without claiming to license the separately installed
host runtime.

This inventory provides traceable source texts and hashes; it is not, by
itself, a legal-compliance certification. Release owners remain responsible for
reviewing obligations and notices for the candidate actually distributed.

## OpenTUI

- Packages: `@opentui/core` and `@opentui/solid`
- Exact version: `0.4.5`
- Source: <https://github.com/anomalyco/opentui>
- License: MIT
- Copyright: Copyright (c) 2025 opentui
- License text: [`third_party/opentui/LICENSE`](third_party/opentui/LICENSE)

These are direct, lockfile-pinned runtime dependencies used by Ralph's own TUI.
No OpenCode TUI component, branding or source file is copied by this dependency.

## SolidJS

- Package: `solid-js`
- Exact version: `1.9.12`
- Source: <https://github.com/solidjs/solid>
- License: MIT
- Copyright: Copyright (c) 2016-2025 Ryan Carniato
- License text: [`third_party/solid-js/LICENSE`](third_party/solid-js/LICENSE)

SolidJS is a direct, lockfile-pinned runtime dependency of the OpenTUI binding.
