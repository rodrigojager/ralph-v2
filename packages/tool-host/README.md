# `@ralph/tool-host`

Governed tool execution for Ralph v2. The package deliberately has no access to
the PRD scheduler, task markers, orchestration state, or the concrete ledger.
Those capabilities are represented by narrow injected ports.

`fs.apply_patch` v1 uses a Ralph structured replacement patch rather than a
partial unified-diff parser:

```json
{
  "changes": [
    {
      "path": "src/example.ts",
      "beforeSha256": "<64 lowercase hex characters>",
      "replacements": [
        { "oldText": "before", "newText": "after", "all": false }
      ]
    }
  ]
}
```

Every file has an explicit before hash. All replacements and resulting hashes
are computed before the first write. Each write is atomic for its individual
file; the settlement records partial effects if the process stops between files,
so recovery can reconcile hashes instead of replaying blindly.
