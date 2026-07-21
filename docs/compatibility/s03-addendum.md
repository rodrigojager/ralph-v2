# S03 orchestration compatibility addendum

This generated addendum is intentionally separate from the S01 legacy compatibility baseline.
It proves the packaged S03 orchestration surface and does not overwrite or reinterpret
`s01-report.json`.

## Artifact boundary

- Production artifact: `<PROJECT_ROOT>/dist/standalone/bun-windows-x64-baseline/ralph.exe`
- Production target: `bun-windows-x64-baseline`
- Production SHA-256: `8c1e6250f3a291d0b79ea604ea8c33956d00edbee216be7af9c0bfbf5883fa19`
- Current source fingerprint: `21a145e4ec4ecc3799f77c9d2f2922cefcea3c27b09020e801f4db3584e773ed`
- Production release eligible: `true`
- Test entrypoint: `tests/support/fixture-cli.ts`
- Test composition SHA-256: `c71d8fc53edf9dd7b2be1625c6b83892fe2d5dc7f637ea48a6dd98d744589f0d`
- Test composition release eligible: `false`

The production standalone passed the build-metadata, artifact-hash and current-source
fingerprint checks before any scenario ran. The scripted backend exists only in the independently
compiled test composition; it is evidence infrastructure, never a release artifact.

## Command evidence

Only portable invocations, exit contracts, diagnostic codes and hashes of normalized output are
stored. Raw output, absolute paths, environment values, UUIDs, timestamps and measured durations
are not retained.

| Command | Composition | Exit | Timed out | Result ok | Diagnostics | Normalized stdout SHA-256 |
| --- | --- | ---: | --- | --- | --- | --- |
| product.help | production | 0 | no | n/a | none | `dc11ffbcf904bdb97fda55f97ee58f6889aaffa4ae57f42e88a32ea5fc8218ed` |
| product.fake.init | production | 0 | no | true | none | `45b43baf0b26da7507822115d396d9ab71ad0b67c2973d9ba3b97ced45a9ff36` |
| product.fake.once | production | 6 | no | false | RALPH_EXECUTOR_PROFILE_UNAVAILABLE | `6597c118d6a45998f24da8605096841f3daecd84cdb1093cfe7d0d3bbdcb5cf6` |
| product.fake.status-run | production | 0 | no | true | none | `7fa9af7980b3634a5e74703ec365466b854234836a6f023ed210a412059fafd3` |
| test.init | test | 0 | no | true | none | `74c0578a431f676fdc920c9cc92c2544467a945ca52c4ec448e3b0ea44ca562e` |
| test.once | test | 0 | no | true | RALPH_RUN_OPTION_NOTICE | `07c737cb18d46c7ef58f9f4e13209bbdefa19d6847fb510fc006d30e773d949a` |
| test.status-run | test | 0 | no | true | none | `2f4abdab1be6529bf7a3f66a701469cf82210e5f91010a89b0e310f969071235` |
| test.events | test | 0 | no | true | none | `93e1dcba98f2ac7bb3bbe100f3c41c06a3be206fe78c7670ab629320d79532bf` |
| test.report-last | test | 0 | no | true | none | `f0de45d692f432f2fe1f52bc7f1f6e4cf54b2d8a5f0434794843a834367b5c06` |

## Invariants

| Invariant | Assessment | Evidence |
| --- | --- | --- |
| product.artifact.fresh | pass | The native production standalone passed artifact, version and current-source fingerprint validation. |
| product.help.command-surface | pass | Help exposes once, run, loop, Wiggum, run status, events and both report commands. |
| product.help.s03-flags | pass | Help exposes all 18 required S03 execution flags. |
| product.fake.exit-contract | pass | The production standalone rejected the fake executor profile with exit 6. |
| product.fake.diagnostic | pass | The rejection emitted RALPH_EXECUTOR_PROFILE_UNAVAILABLE. |
| product.fake.no-run | pass | The ledger and public status-run view both report zero persisted runs (0). |
| product.fake.marker-unchanged | pass | The unavailable profile left the complete PRD bytes and pending marker unchanged. |
| test-composition.classification | pass | The fixture CLI was independently compiled and is explicitly ineligible for release. |
| test-flow.command-sequence | pass | The packaged test composition completed init -> once -> status run -> events -> report last. |
| test-flow.deliverable | pass | The vertical slice produced product/capability.txt with the exact value delivered. |
| test-flow.marker | pass | The authority-owned PRD marker reached [x] only after verification. |
| test-flow.progress | pass | Public status reports deterministic progress 1/1 (ratio 1). |
| test-flow.events | pass | Public events returned 41 persisted records. |
| test-flow.gate | pass | The persisted blocking command gate status is passed. |
| test-flow.report | pass | The persisted and public reports agree on completed status, one task, one attempt and one model call. |

## Summary

- Passed: 15/15
- Regressions: 0
- S01 baseline changed: no

The positive packaged flow is `init -> once -> status run -> events -> report last`. It verifies
the delivered file, the authority-owned `[x]` marker, the blocking gate, progress counters and
the persisted report. The negative production flow proves that `--executor-profile fake` exits
with code 6 and `RALPH_EXECUTOR_PROFILE_UNAVAILABLE` without creating a run or changing the PRD.
