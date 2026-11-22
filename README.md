# mend: one patch tool for every AI edit format

[![bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/top234/hidden-spec-cli-01-run-20261122-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/top234/hidden-spec-cli-01-run-20261122-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Entry for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

`mend` is a single command-line tool (`main.ts`, Node 22, standard library only) that
applies the edits AI models write, in all four formats, to one written specification
(`SPEC.md`):

- **Unified diffs** — even with wrong line numbers, drifted whitespace and indentation,
  CRLF files, files without a final line break, renames (`rename from`/`to`,
  `diff --git` paths, `---`/`+++` pairs), creates and deletes.
- **SEARCH/REPLACE blocks** — with a path line, `<<<<<<< SEARCH` / `=======` /
  `>>>>>>> REPLACE`, prose and code fences around the blocks.
- **V4A patches** — `*** Begin Patch` / `*** End Patch`, Add / Delete / Update File
  sections, `*** Move to:`, `@@` anchors, `*** End of File` chunks.
- **JSON edits** — one JSON array or JSON Lines of `create`, `str_replace` and
  `insert` tool calls.

Matching works at three tiers: exact, trailing whitespace stripped, then leading and
trailing whitespace stripped (with new lines re-indented to the file's own indent).
A patch is applied atomically — every edit or none: a failed edit changes nothing,
later edits still run, and every failure is reported. Output is deterministic:
one `A`/`D`/`M` line per changed path (or `R old -> new` for a move) in UTF-8 byte
order, then `ok: <n> files`.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a file, or `-`/absent for stdin. Exit codes: `0` success, `1` one or
more edits failed, `2` usage / no-patch / format / parse error (see `SPEC.md`).

## Verification

- All 100 public practice checks pass: `node check.ts ../program/generator/practice.json`
  (practice score 1000).
- 51 additional hand-written checks covering spec sentences the practice set does
  not show (renames, moves, `\ No newline at end of file`, CRLF round-trips, EOF
  chunks, anchors, atomicity, unsafe paths, `--check`, `--strict`) — all pass.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the kit's trial runner (unchanged).
- `check.ts` — the practice-set runner.
- `SPEC.md` — the specification.
- `LICENSE` — MIT (`SPDX-License-Identifier: MIT`).
