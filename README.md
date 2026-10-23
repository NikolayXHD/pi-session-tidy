# pi-session-tidy

Pi extension that shrinks the thinking in the context.

- in some tasks reasoning takes more than half of the context;
- the extension compresses that part by 30–60%.

Old thinking blocks are rewritten by a background call of the same model into
short digests: decisions, rejected options, facts and open questions survive,
repetition and filler do not. Recent blocks stay raw.

## What you see

Footer: `💭 -40k/120k +76k` — reasoning tokens saved, raw reasoning tokens in
context, tokens spent by the background calls. Spinner while a rewrite runs.
While the mode is off the footer shows nothing.

- `/session-tidy` — report;
- `/session-tidy on` / `off`;
- `/session-tidy dump` — raw and compacted blocks next to the session file.

## Observability

`/session-tidy dump` writes two files next to the session JSONL:

- `thinking-a` — the raw blocks as the model wrote them;
- `thinking-b` — the same blocks as the model sees them, with digests in place.

Every block is preceded by the same heading in both files
(`## entryId:blockIndex timestamp`), so a diff aligns block by block. Only
applied digests that are still in context are dumped.

Unified diff:

```bash
diff -u thinking-a thinking-b
```

Side by side:

```bash
delta --side-by-side thinking-a thinking-b
diff --side-by-side --width=180 thinking-a thinking-b
vimdiff thinking-a thinking-b
```

`delta` is the readable default: side-by-side panes, syntax highlight, an
aligned vertical line between the sides. `vimdiff` (or `meld`, `code --diff`)
works when you want to edit or fold.

The dump notification prints the directory it wrote to; the files sit next to
the session JSONL under `~/.pi/agent/sessions/`.

## Install

```bash
pi install git:github.com/NikolayXHD/pi-session-tidy
```

Settings: `~/.pi/agent/session-tidy.json`. The former
`~/.pi/agent/compact-thinking.json` is read when the new file is missing. A
missing settings file and a missing container are created with the default
content and announced — nothing runs on a hidden default.

| field             | default       | meaning                       |
| ----------------- | ------------- | ----------------------------- |
| `enabled`         | `true`        | mode is on at session start   |
| `k`               | `5`           | recent blocks that stay raw   |
| `minTokens`       | `512`         | shorter blocks are left alone |
| `acceptanceRatio` | `0.95`        | a longer digest is rejected   |
| `model`           | session model | model of the background calls |
| `thinking`        | none          | thinking level of the calls   |

## Containers

Per-subtask settings live in `~/.pi/agent/session-tidy/`: one markdown file per
subtask, the digests subtask uses `digests.md`. Frontmatter holds `model` and
`thinking` — overrides of the config base — the body is the task text for the
background model. The extension reads the files itself: pi subagents do not see
them.

```markdown
---
model: deepseek/deepseek-flash
thinking: high
---

Rewrite the thinking block quoted below in the same language, shorter …
```

Without the file the extension creates it with the built-in task text and
says so.

## How it works

A digest is a separate call over the same session prefix: no tools, the answer
wrapped in `<digest>…</digest>`. The call goes to the model named by `model` —
the config base, overridden by the container; without `model` the session model
does the work and the extension says so.

Digests are substituted into the context by one function called in `context`
(before the main model request) and in `session_before_compact` (before Pi's
own summarizer). Nothing is written to the session, so Pi keeps deriving the
context size and the compaction threshold from the real provider `usage`.

The background job runs while the agent is busy with tools and right before the
session settles; it never competes with the model stream.

## Limits

- works while the extension is loaded, nothing is stored in the session;
- every block costs a full prefix read: a warm cache matters;
- does not replace Pi compaction, it shrinks thinking only.

## Development

`node src/probe.mjs` for pure rules, `TESTING.md` for session scenarios.
