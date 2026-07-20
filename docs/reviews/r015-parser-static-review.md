# R015 — Independent parser static review

Verdict: **APPROVED**

This receipt records the independent static review required by R015 and `BLK-R015-REVIEW`. It is valid only for the exact parser source snapshot below.

## Review identity

| Field | Value |
| --- | --- |
| Reviewer | Codex independent static review agent `r015_parser_review` |
| Reviewed at | `2026-07-20T00:29:28.579Z` |
| Method | Independent static source review |
| Verdict | `APPROVED` |

## Source binding

| Field | Value |
| --- | --- |
| Path | [`packages/prd/src/parser.ts`](../../packages/prd/src/parser.ts) |
| SHA-256 | `e69dd71f508e9f7ce9646ec0cb3af3faff4757f424e6b2d012c854624988073a` |
| Size | 41,965 bytes |
| Lines | 1,313 |

Any change to that source identity invalidates this receipt until a new independent review is recorded.

## Evidence trail

1. The YAML frontmatter path uses `parseDocument` with strict mode, unique keys, the core schema and aliases disabled during conversion ([lines 410–432](../../packages/prd/src/parser.ts#L410)).
2. The normative Markdown section is discovered and validated from typed mdast/CommonMark nodes, not by matching whole Markdown lines ([lines 1064–1112](../../packages/prd/src/parser.ts#L1064)).
3. Task-header regular expressions receive scalar text already selected from an AST paragraph leaf, while identifier and field coercion pass through the leaf parser boundary ([lines 654–668](../../packages/prd/src/parser.ts#L654), [lines 709–768](../../packages/prd/src/parser.ts#L709)).
4. The only mutable checkbox marker is located from its AST position and revalidated as an exact three-character source slice before its location is exposed ([lines 1016–1041](../../packages/prd/src/parser.ts#L1016)).
5. Broad line-oriented regular expressions are confined to the separate classic compatibility adapter ([`packages/prd/src/classic.ts`](../../packages/prd/src/classic.ts#L72)); the PRD v2 parser does not import that adapter.

## Conclusion

The reviewed PRD v2 parser uses safe YAML and CommonMark/mdast parsing for document structure. Its regular expressions are confined to AST-selected scalar leaf validation or the bounded three-character marker. Classic line-oriented parsing remains isolated in its compatibility adapter. R015 is therefore approved for the source snapshot bound above.

## Scope limit

This was a static review. It did not execute Bun, tests, builds, the CLI or the TUI. The machine-readable companion is [`r015-parser-static-review.json`](r015-parser-static-review.json).
