# pi-session-tidy

Pi extension that tidies the session in three ways: it shrinks the thinking in
the context, rewrites reports for the reader, and turns emotional replies into
clear wording.

## Thinking: digests

In some tasks reasoning takes more than half of the context; the extension
compresses that part by 30–60%. Every thinking block is rewritten by a
background call into a short digest as soon as its message is done: decisions,
rejected options, facts and open questions survive, repetition and filler do
not. There is no raw zone.

## Reports: clear wording

A report longer than `minReportTokens` is checked and rewritten only when it
has a problem — hard to understand on the first reading. A clear report is
answered with `<unchanged/>` and stays as typed: every rewrite must be worth
its place. The rewrite takes one thought per paragraph, concrete words, named
actors. Every fact, decision and open question of the original survives — the
rewrite may be longer, reports are not compressed. The clear wording goes to
the model context in place of the raw report.

Both texts stay in the transcript: the raw report as streamed, the clear
wording in a `rewritten report` block right below it. The block is bound to
its message by session position — the entry that stores the rewrite — never
by the text: two identical reports carry two rewrites.

## Replies: value out of the heat

A reply of the human — caps lock, profanity, fragments — carries a demand, a
correction, a priority. The editor extracts that value and rewrites the message
as calm, clear wording; the force survives as content, not as noise. Nothing is
edited mechanically: extracting the value is the job of the model.

Only a problematic message is rewritten. A calm, clear message is answered
with `<unchanged/>` and stays exactly as typed — no rewrite, no second text.
The editor answers in exactly one of two marks: `<unchanged/>` — nothing to
rewrite — or `<rewrite>…</rewrite>` — the calm wording. An answer in any other
shape rewrites nothing and raises a warning in the session.

Both texts stay visible: the raw reply is the human message as typed, the
clear wording is shown in a `rewritten reply` block right below it — bound to
its message by session position, never by the text. The clear wording also
goes to the model context — the assistant works from the value, not from the
noise.

## What you see

Footer: `💭 -40k/120k +76k ✍ 2 😞 1` — reasoning tokens saved, raw reasoning
tokens in context, tokens spent by the background calls, and two rewrite
counters: `✍` rewritten reports, `😞` rewritten replies. Only texts that had a
problem are rewritten, so both counters count writing problems: reports show
how the session model writes, replies — the human's outbursts (@NikolayXHD:
«счётчик моей печали»), a quality signal of the model too. A counter appears
after its first rewrite. Spinner while a background call runs. While the mode
is off the footer is empty and nothing is rewritten, substituted or shown.

- `/tidy` — turn the tidying on for this session; the status line appears;
- `/tidy-settings` — the settings menu; its `mode (session)` row turns the
  tidying off.

## Settings menu

`/tidy-settings` opens the menu: the title carries the state, row labels carry
current values. Enter on a row changes the value and the menu stays open. The
`mode (session)` row changes the running session only — it is the off switch;
every other row writes the config file. Model and thinking level open a
picker, number rows open an input, container rows open the container text in
the editor. `counters report` prints digests, rewrites and spending; `dump
thinking` writes the thinking files.

## Observability

The `dump thinking` menu row writes two files next to the session JSONL:

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
content and announced — nothing runs on a hidden default. The mode is not a
config field: tidy stays off until `/tidy` turns it on.

| field             | default       | meaning                        |
| ----------------- | ------------- | ------------------------------ |
| `minTokens`       | `512`         | shorter blocks are left alone  |
| `acceptanceRatio` | `0.95`        | a longer digest is rejected    |
| `minReportTokens` | `200`         | shorter reports are left alone |
| `model`           | session model | model of the background calls  |
| `thinking`        | none          | thinking level of the calls    |

The mode is not a config field: tidy stays off until `/tidy` turns it on.
Removed fields left in an old config — `enabled`, `k`, `debug` — are reported
by name, never silently ignored.

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

There is no built-in task text: a prompt is authored by the human. No prompt
— the subtask does not run, and the menu says so on the container row.

## How it works

A digest and a rewrite are separate calls over the same session prefix: no
tools, the answer wrapped in `<digest>…</digest>` or in one of the two rewrite
marks — `<unchanged/>` or `<rewrite>…</rewrite>`.
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

Turns are serialized: before every model request the queue is drained to the
empty end — the request goes out only with the final texts of everything past,
all or nothing, like compaction. A text never changes after the turn it
appeared in. The background job also starts in the tool window and before the
session settles, so the drain at the request is normally already done; it
never competes with the model stream.

The rewritten texts are drawn by entry renderers at the position of their
entries — the position is the attribution. Markdown transformers are not used
for this: a transformer cannot tell one message from another, and a text-keyed
lookup gives ten identical replies one shared rewrite.

## Limits

- works while the extension is loaded; state is restored from extension
  entries on resume;
- every block costs a full prefix read: a warm cache matters;
- does not replace Pi compaction, it shrinks thinking and clarifies reports.

## Development

`node src/probe.mjs` for pure rules, `TESTING.md` for session scenarios.
