# pi-session-tidy

Pi extension that tidies the session in three ways: it shrinks the thinking in
the context, rewrites reports for the reader, and turns emotional replies into
clear wording.

## Thinking: digests

In some tasks reasoning takes more than half of the context; the extension
compresses that part by 30–60%. Old thinking blocks are rewritten by a
background call into short digests: decisions, rejected options, facts and open
questions survive, repetition and filler do not. Recent blocks stay raw.

## Reports: clear wording

A report longer than `minReportTokens` is rewritten to be understood on the
first reading: one thought per paragraph, concrete words, named actors. Every
fact, decision and open question of the original survives — the rewrite may be
longer, reports are not compressed. The clear wording replaces the raw report
in the model context and in the transcript.

While the rewrite is being prepared the raw report is on screen — the model
streams it live and streaming cannot be held. When the clear wording arrives,
the transcript switches to it.

## Replies: value out of the heat

A reply of the human — caps lock, profanity, fragments — carries a demand, a
correction, a priority. The editor extracts that value and rewrites the message
as calm, clear wording; the force survives as content, not as noise. Nothing is
edited mechanically: extracting the value is the job of the model.

Both texts stay visible: the raw reply is the human message as typed, the
rewritten one is a block right after it. The clear wording also goes to the
model context — the assistant works from the value, not from the noise.

## What you see

Footer: `💭 -40k/120k +76k ✍ 2` — reasoning tokens saved, raw reasoning tokens
in context, tokens spent by the background calls, reports rewritten. Spinner
while a background call runs. While the mode is off the footer shows nothing.

- `/session-tidy` — report;
- `/session-tidy on` / `off`;
- `/session-tidy debug on` / `off` — show the clear wording after the original
  report instead of replacing it;
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

| field             | default       | meaning                             |
| ----------------- | ------------- | ----------------------------------- |
| `enabled`         | `true`        | mode is on at session start         |
| `k`               | `5`           | recent blocks that stay raw         |
| `minTokens`       | `512`         | shorter blocks are left alone       |
| `acceptanceRatio` | `0.95`        | a longer digest is rejected         |
| `minReportTokens` | `200`         | shorter reports are left alone      |
| `debug`           | `false`       | show the rewrite after the original |
| `model`           | session model | model of the background calls       |
| `thinking`        | none          | thinking level of the calls         |

## Containers

Per-subtask settings live in `~/.pi/agent/session-tidy/`: one markdown file per
subtask, `digests.md` for digests, `reports.md` for report rewriting and
`replies.md` for replies.
Frontmatter holds `model` and `thinking` — overrides of the config base — the
body is the task text for the background model. The extension reads the files
itself: pi subagents do not see them.

```markdown
---
model: deepseek/deepseek-flash
thinking: high
---

Rewrite the thinking block quoted below in the same language, shorter …
```

Without the file the extension creates it with the built-in task text and says
so.

## How it works

A digest and a rewrite are separate calls over the same session prefix: no
tools, the answer wrapped in `<digest>…</digest>` or `<rewrite>…</rewrite>`.
The calls go to the model named by `model` — the config base, overridden by the
container; without `model` the session model does the work and the extension
says so. The prefix already carries earlier transformations, so later calls
build on earlier results and the provider cache stays warm.

Results are substituted into the context by one function called in `context`
(before the main model request) and in `session_before_compact` (before Pi's
own summarizer). Nothing is written to message entries: the raw text stays in
the session, while the state lives in extension entries
(`session-tidy-applied`, `session-tidy-report-applied`,
`session-tidy-reply-applied`) and survives resume.

The background job runs while the agent is busy with tools and right before the
session settles; it never competes with the model stream.

## Limits

- works while the extension is loaded; state is restored from extension
  entries on resume;
- every block costs a full prefix read: a warm cache matters;
- does not replace Pi compaction, it shrinks thinking and clarifies reports.

## Development

`node src/probe.mjs` for pure rules, `TESTING.md` for session scenarios.
