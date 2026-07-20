import { describe, expect, test } from "bun:test"
import { whitespaceIssues } from "../../scripts/ci/check-whitespace"

describe("tracked whitespace gate", () => {
  test("accepts clean LF and CRLF text", () => {
    expect(whitespaceIssues("clean.md", "alpha\nbeta\n")).toEqual([])
    expect(whitespaceIssues("clean.ps1", "alpha\r\nbeta\r\n")).toEqual([])
  })

  test("reports trailing whitespace, space-before-tab and conflict markers", () => {
    expect(
      whitespaceIssues(
        "unsafe.txt",
        "trailing \n \tindented\n<<<<<<< HEAD\n=======\n>>>>>>> branch\n",
      ),
    ).toEqual([
      { path: "unsafe.txt", line: 1, kind: "trailing-whitespace" },
      { path: "unsafe.txt", line: 2, kind: "space-before-tab" },
      { path: "unsafe.txt", line: 3, kind: "conflict-marker" },
      { path: "unsafe.txt", line: 4, kind: "conflict-marker" },
      { path: "unsafe.txt", line: 5, kind: "conflict-marker" },
    ])
  })
})
