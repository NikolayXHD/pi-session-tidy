# Test scenarios

The extension densifies old thinking blocks into digests while keeping the raw
text in the session. Digests are substituted into the context on the fly: in
`context` and in `session_before_compact`.

The automated run is `node src/probe.mjs` from the package root: pure rules for
candidate selection, acceptance, replacement assembly and status text.
Everything that lives only in the session is checked manually through a child
`pi` session and its JSONL.

The background job starts in the tool window (`tool_execution_start`) and
before settling (`agent_before_settle`); it never runs while the main model
streams.

## Config

The file is `~/.pi/agent/session-tidy.json` (the former
`~/.pi/agent/compact-thinking.json` is read when the new file is missing).
Fields: `k`, `minTokens`, `acceptanceRatio`, `minReportTokens`, `debug`,
`model`, `thinking`. The mode is not a config field: tidy stays off until
`/tidy`, and a leftover `enabled` field is reported by name. A
missing file is created with the defaults and announced; an unusable value
falls back to its default and is reported by name.

Per-subtask settings live in `~/.pi/agent/session-tidy/digests.md`,
`reports.md` and `replies.md`: frontmatter `model` and `thinking` override the
config, the body is the task text. There is no built-in task text: a missing
file or an empty task means the subtask does not run, and the menu shows the
container row as `— no task, subtask off`.

## Selection and replacement

Rules live in probe.mjs. Session consequences:

- blocks shorter than `minTokens` are left alone;
- `k` counts all thinking blocks, including redacted ones, so the raw zone
  keeps the width of that many actions;
- a block whose visible text was replaced by a foreign `context_edit` is not
  touched;
- replacement changes the text of target blocks and leaves neighbouring blocks,
  text and tool calls intact;
- a digest is accepted only with a normal stop reason, without tool calls and
  not longer than `acceptanceRatio` of the source block; the answer must
  contain `<digest>…</digest>`, text outside the tags is ignored, tool-call
  markup inside the tags is rejected;
- a rejection caused by the block (length cut-off, tool call, missing or empty
  wrapper, tool markup, grown answer) is recorded and never retried; a network
  or cancellation rejection leaves the block in the queue, but not more than
  three attempts per session.

Reports are checked on other terms: a final answer longer than
`minReportTokens` qualifies, a message with tool calls does not; the raw zone
`k` does not apply to reports. Only a report that has a problem is rewritten;
a clear one is marked `<unchanged/>` and stays as typed. The acceptance checks
the form only and never the length: the answer carries exactly one of
`<unchanged/>` and `<rewrite>…</rewrite>`, the rewrite is not empty and carries
no tool-call markup; a rewrite may be longer than the original. A rewrite equal
to the source is not a replacement — the text stays as typed. A report whose
text was changed by a foreign `context_edit` is left alone.

Replies are checked without a threshold but rewritten only when the message
has a problem: the editor marks a calm one `<unchanged/>` and the message stays
as typed. An answer in any other shape rewrites nothing and raises a warning
naming the reason.

## Manual session scenarios

Run each scenario in an empty directory so the JSONL lands in its own place:
`mkdir -p /tmp/session-tidy-check` and run `pi -p "..."` inside it.

Status. Without `/tidy` the footer shows nothing and no work runs. `/tidy`
turns the mode on for this session and the footer shows `💭 -…k/…k +…k`:
savings, raw reasoning sum and generation of the background calls; after the
first rewrite the counters follow — `✍ 2` for rewritten reports, `😞 1` for
rewritten replies. While the background call runs, a spinner follows the
balloon.
`/tidy-settings` opens the settings menu — see the menu scenario below; the
counters report row prints digests, rewrites and spending. Sums are
recomputed at every turn boundary, so in a running session with reasoning the
second number must not stay zero.

Settings menu. `/tidy-settings` opens the menu with the state in the title and
current values in the rows. Enter on a row changes the value and the menu
stays open. The `mode (session)` and `report display (session)`
rows change the running session only; the model, thinking level and number rows
write the config file — after changing `k` the file holds the new value.
Container rows open the text in the editor and save it on close.

Compaction during a task. With `k = 0` and `minTokens` around 16 ask the agent
to run several bash commands in a row. After the second answer the session
JSONL contains `session-tidy-applied` entries; the extension writes no
`context_edit` entries at all; the assistant message entry keeps the full raw
thinking.

Substitution reaches the provider. A temporary logger extension on
`before_provider_request` writes the length and the start of
`reasoning_content` for assistant messages; in the log a raw block turns into a
digest and stays that way in later requests.

Editor context. The background call carries the results of earlier
transformations: its request is built from substituted messages — the same
substitution the main requests use, which the logger scenario above verifies.
Extension events do not fire for extension-initiated calls: the logger sees
only the session requests, not the editor ones.

The summarizer sees digests. A temporary logger extension on
`session_before_compact` writes thinking block lengths from
`preparation.messagesToSummarize`; those must be digests, not raw text.

Context change. After a digest is applied, the counters report row shows
non-zero
digests and savings, while the raw text stays in the message entry.

Tree navigation. Make several turns, then `/tree` to an earlier entry. The
state is rebuilt for the new branch: the status counts only its entries, and
digests from the abandoned branch do not enter the context.

Foreign edit. If a block's visible text was replaced by a foreign
`context_edit`, the extension leaves it alone and no `session-tidy-applied`
entry appears for it.

Resume. Interrupt a session and resume it. Digests are restored from
`session-tidy-applied` entries and substituted into the context again; the
status matches the number of active entries.

Disable. `mode (session): off` in the menu — no new extension entries appear
and the footer shows nothing until `/tidy` again.

Dump. After several compactions the `dump thinking` row writes `thinking-a`
and `thinking-b` next to the session JSONL; block headings match in both files,
blocks follow session order, and `thinking-b` holds what the model sees. Diff
recipes are in README, section Observability.

Provider signature. For DeepSeek and vLLM the digest keeps
`thinkingSignature: "reasoning_content"`; for a provider without a
reasoning-field signature it is dropped.

Rename. A session written before the rename keeps its digests: entries
`compact-thinking-applied` and `hybrid-thinking-applied` are read like
`session-tidy-applied`. With only `compact-thinking.json` on disk the config is
read from it.

Container model. With `model: provider/id` in `digests.md` the background calls
go to that model — a temporary logger on `before_provider_request` writes the
model name. An unknown model name warns once and falls back to the session
model.

Report rewriting. Ask for a long final answer with a problem — jargon or
tangled categories. After the run settles the session JSONL gains a
`session-tidy-report-applied` entry and the transcript switches from the raw
text to the clear wording. The footer counter shows `✍ 1`.

Clear report. Ask for a long final answer that is already well-formed. The
transcript keeps it as typed, the session JSONL gains a
`session-tidy-report-applied` entry without `rewrittenText`, and the counters
stay at zero.

Debug display. With `report display (session): debug` the transcript keeps the
raw report and shows the clear wording after it, below a separator; with
`plain` the text switches to the clear wording. The switch applies at render —
moving the viewport or sending a message redraws the transcript.

Reply rewriting. Send a reply with caps lock and profanity. After the run
settles the session JSONL gains a `session-tidy-reply-applied` entry and the
reply shows both texts in one message: the raw wording as typed, a divider,
and the clear wording below it. The rewrite extracts the demand: the force
survives as content, the noise does not. The footer counter shows `😞 1`.

Calm reply. Send a calm short reply — "ok", a plain question. The message
stays a single text, no divider; the session JSONL gains a
`session-tidy-reply-applied` entry without `rewrittenText` (checked, nothing to
rewrite) and the message is never sent to the editor again.

Invalid editor answer. Break the task text temporarily ("Answer with OK.").
The reply is not rewritten, the message stays as typed, a warning naming the
reason appears in the session, and the session JSONL gains a
`session-tidy-reply-rejected` entry.

Loud defaults. With no settings file the session start announces its creation
and the file on disk holds the defaults; a `k` of `-3` or a model of `7`
warns by name and falls back to the default. Containers are never created:
no prompt, no subtask.
