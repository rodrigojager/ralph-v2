# Bun 1.3.14 runtime provenance

This curated bundle is bound to the exact Bun runtime used to build the Ralph v2 beta candidate.
It records official upstream material; it is not a legal opinion or an independent certification.

## Exact source identity

- Repository: <https://github.com/oven-sh/bun>
- Release: <https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14>
- Release tag: `bun-v1.3.14`
- Release published: `2026-05-13T03:48:28Z`
- Tag target and runtime revision: `0d9b296af33f2b851fcbf4df3e9ec89751734ba4`
- Commit date: `2026-05-12T22:12:49Z`
- Commit tree: `afe6bd3443b8948a294fc6246256430a0099e511`
- Commit parent: `39540fd99ccd859a4ca19067cfe476a42c77732a`

The official tag is a lightweight Git ref whose target is exactly the runtime revision above. The
GitHub release also declares that same revision as `target_commitish`.

## Official license material

`LICENSE.md` reproduces the official text from:

<https://raw.githubusercontent.com/oven-sh/bun/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/LICENSE.md>

- Git blob: `81069ee8d3b84f21ee32b2a9766643e1de114863`
- Upstream size: `5376` bytes
- Upstream SHA-256: `2c6160ec8fb853f7e8f97d9b249e756c9b0ac44860a68b6bf4f1b0bcbc5c3741`
- Curated copy size: `5377` bytes
- Curated copy SHA-256: `2cb858b2db8fc793bca2093489c5bc8eee615d002cc4924254904044c27a0afa`

The curated copy differs only by one terminal LF added by the repository text-file convention; its
textual content is otherwise unchanged. Both upstream and curated byte receipts are recorded here.

At this revision the repository root contains no separate `NOTICE` or `COPYING` file. The official
root `LICENSE.md` is Bun's consolidated license/notice matrix: it identifies Bun's own license,
JavaScriptCore/WebKit obligations, statically linked libraries, embedded polyfills and credits.
References inside that upstream file remain upstream references and are not rewritten here.

## Official release asset digests for Ralph targets

The release API supplied these SHA-256 digests and byte sizes for the six target families used by
Ralph's release matrix:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `bun-windows-x64-baseline.zip` | 38023440 | `538f9c846355d9e847b2671bc00c47da4229a0befb24df3282b739770f3b475f` |
| `bun-windows-aarch64.zip` | 36659109 | `89841f5a57f2348b67ec0839b718f4bf4ea7d07c371c9ba4b77b6c790f918953` |
| `bun-linux-x64-baseline.zip` | 35595658 | `a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7` |
| `bun-linux-aarch64.zip` | 35700603 | `a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b` |
| `bun-darwin-x64.zip` | 26509109 | `4183df3374623e5bab315c547cfa0974533cd457d86b73b639f7a87974cd6633` |
| `bun-darwin-aarch64.zip` | 23586433 | `d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620` |

## Curation record

- Curated at: `2026-07-20T04:27:07.803Z`
- Curated by: Codex acting under explicit release-owner delegation from Rodrigo Jager
- Scope: license, notice and provenance material for the pinned embedded Bun runtime
- Verification: official GitHub release API, tag ref, commit object, root tree and content API

Every file shipped from this directory is enumerated separately in `CURATION.json` with its exact
size and SHA-256. The Ralph release packager rejects missing, extra, linked or modified files.
