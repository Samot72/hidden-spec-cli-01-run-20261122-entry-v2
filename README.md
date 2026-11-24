# mend — one patch tool for every AI edit format

[![Competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Samot72/hidden-spec-cli-01-run-20261122-entry-v2/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Samot72/hidden-spec-cli-01-run-20261122-entry-v2/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files, as
specified by `SPEC.md` in the competition kit. One command-line tool reads all
four formats models write — unified diffs (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON — finds the lines each edit names even when the model drifted their
whitespace or indentation, and changes every file or none.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree; every path in a patch is
  relative to it.
- `PATCH` is the patch file; when absent or `-`, the patch is read from
  standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a` or
  `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`/`D`/`M`, or `R old -> new` for
a move) plus `ok: <n> files`. Exit 1 lists every failed edit and
`failed: <k> of <n> edits`, and writes nothing. Exit 2 reports a usage,
missing-patch, format or parse error as a single line.

## How it works

- **Three matching tiers.** Old lines are found at the first tier where they
  occur: tier 0 exact, tier 1 trailing whitespace ignored, tier 2 leading
  and trailing whitespace ignored. At tier 2, new lines are re-indented from
  the patch's indentation to the file's own. Context lines are always written
  as the file's own matched lines.
- **Unified diffs.** Hunks apply in order to the result of the ones before,
  each taking the occurrence nearest its (possibly wrong) `@@` line number;
  empty hunks insert after a line count. `diff --git`, `---`/`+++`,
  `rename from`/`rename to`, `new file mode` and `deleted file mode` are all
  read; creations, deletions and moves are one edit each. `\ No newline at
  end of file` decides whether a hunk that runs to the end of the file leaves
  a final line break.
- **SEARCH/REPLACE.** The path is the nearest non-blank, non-fence line
  before the block (or the previous block's path); old lines must occur
  exactly once at their tier, else `ambiguous`.
- **V4A.** Sections add, delete or update files; update chunks are anchored
  by `@@` lines and applied in order behind a cursor that only moves
  forward, with `*** End of File` chunks pinned to the file's last line and
  `*** Move to:` renaming the file.
- **JSON.** One array or JSON Lines of `create` / `str_replace` / `insert`
  objects, with CRLF files read and written back as CRLF.
- **Atomicity.** Edits apply in order to the tree as earlier edits left it,
  a failed edit changes nothing and the edits after it still run, and when
  any edit failed no file is written at all. Paths are checked for safety
  before anything else about them.

## Verification

- **100/100 practice checks** from the kit (`practice score 1000`),
  run with an independent driver against the kit's expected exit codes,
  stdout and resulting files.
- **52/52 hand-built edge cases** for sentences of `SPEC.md` the practice
  set does not show: malformed headers, rename-only moves, `\ No newline`
  placement, V4A anchors and end-of-file chunks, unsafe paths, usage errors,
  `--check`, multi-move output ordering, and create-then-delete no-ops.
- **Deterministic:** 25/25 sampled practice checks give byte-identical exit
  code, stdout and files on a second run.

## Files

- `main.ts` — the CLI (Node 22+, standard library only).
- `runner.ts` — the kit's runner, kept as shipped; `main.ts` hands a trial
  over to it when `MAKEFUN_ENV_URL` is set.
- `LICENSE` — MIT.
