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
streams. Turns are serialized: before every model request — `context` and
`session_before_compact` — the queue is drained to the empty end, so no
request sees a text that changes after the fact.

## Config

The file is `~/.pi/agent/tidy.json` (the former `session-tidy.json` and
`compact-thinking.json` are read when the new file is missing).
Fields: `minTokens`, `acceptanceRatio`, `minReportTokens`, `model`, `thinking`.
Neither switch is a config field: the work starts with `/tidy`, and
`continual` is off until the menu turns it on. Removed fields
left in an old config — `enabled`, `k`, `debug` — are reported by name, never
silently ignored. A missing file is created with the defaults and announced;
an unusable value falls back to its default and is reported by name.

Per-subtask settings live in `~/.pi/agent/session-tidy/digests.md`,
`reports.md` and `replies.md`: frontmatter `model` and `thinking` override the
config, the body is the task text. There is no built-in task text: a missing
file or an empty task means the subtask does not run, and the menu shows the
container row as `— no task, subtask off`.

## Selection and replacement

Rules live in probe.mjs. Session consequences:

- blocks shorter than `minTokens` are left alone;
- every thinking block is a candidate as soon as its message is done: there is
  no raw zone;
- a block whose visible text was replaced by a foreign `context_edit` is not
  touched;
- a record stores the identity of its source text (`rawHash`); when the source
  text changes — a foreign `context_edit`, a branch edit — the digest or the
  rewrite is dropped: nothing is substituted and no block is drawn. A record
  without a hash comes from an older version and is applied as before;
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
`minReportTokens` qualifies, a message with tool calls does not. Only a report
that has a problem is rewritten;
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
starts the work and the footer shows `💭 -…k/…k +…k`:
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
stays open. The `continual` and `apply changes to context` rows change the
running session only: the first takes new messages as they come, the second
sends corrections into the model context; the model, thinking level and
number rows write the config file — after changing `minTokens` the file holds
the new value. Container rows open the text in the editor and save it on
close.

Compaction during a task. With `minTokens` around 16 ask the agent
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

Turn serialization. With tidy on, send the next message while a background call
still runs (the spinner follows the balloon). The turn waits for the queue:
before the request goes out the queue drains to the empty end, so its messages
carry the digests and rewrites of everything past and nothing is substituted
after the fact. The logger scenario above shows the request; the session JSONL
shows the `session-tidy-*` entries of the drained work landing before the next
answer starts. All or nothing — a request never sees a half-done context.

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

Stop and shadow. `continual: off` — the queue stops taking new messages, the
work already done stays. `apply changes to context: off` — the model sees the
text as typed while records and blocks stay; `on` brings the corrections back
from the next turn.

Dump. After several compactions the `dump thinking` row writes `thinking-a`
and `thinking-b` next to the session JSONL; block headings match in both files,
blocks follow session order, and `thinking-b` holds what the model sees. Diff
recipes are in README, section Observability.

Provider signature. For DeepSeek and vLLM the digest keeps
`thinkingSignature: "reasoning_content"`; for a provider without a
reasoning-field signature it is dropped.

Rename. A session written before the rename keeps its digests: entries
`compact-thinking-applied` and `hybrid-thinking-applied` are read like
`session-tidy-applied`. With only `session-tidy.json` or
`compact-thinking.json` on disk the config is
read from it.

Container model. With `model: provider/id` in `digests.md` the background calls
go to that model — a temporary logger on `before_provider_request` writes the
model name. An unknown model name warns once and falls back to the session
model.

Report rewriting. Ask for a long final answer with a problem — jargon or
tangled categories. After the run settles the session JSONL gains a
`session-tidy-report-applied` entry and a `rewritten report` block with the
clear wording appears right below the raw report. The footer counter shows
`✍ 1`.

Clear report. Ask for a long final answer that is already well-formed. The
transcript keeps it as typed, the session JSONL gains a
`session-tidy-report-applied` entry without `rewrittenText`, and the counters
stay at zero.

Reply rewriting. Send a reply with caps lock and profanity. After the run
settles the session JSONL gains a `session-tidy-reply-applied` entry and a
`rewritten reply` block with the clear wording appears right below the reply;
the raw wording stays the human message as typed. The rewrite extracts the
demand: the force survives as content, the noise does not. The footer counter
shows `😞 1`.

Attribution by position. Send the same short reply several times ("да" to
several questions). Each rewrite block sits under its own message with its own
text: identical messages never share a rewrite. Turn `apply changes to
context` off — no substitution reaches the model; blocks and entries stay.

Calm reply. Send a calm short reply — "ok", a plain question. The message
stays a single text, no divider; the session JSONL gains a
`session-tidy-reply-applied` entry without `rewrittenText` (checked, nothing to
rewrite) and the message is never sent to the editor again.

No invention. Send a bare "да" and an angry fragment ("БЛЯДЬ ДА"). The bare
one is answered `<unchanged/>`; the angry one comes back as "Да." — the words
of the message without the heat. Neither rewrite gains words the message did
not carry: the editor never completes what was half-said and never adds its
own reading of what the human meant.

Invalid editor answer. Break the task text temporarily ("Answer with OK.").
The reply is not rewritten, the message stays as typed, a warning naming the
reason appears in the session, and the session JSONL gains a
`session-tidy-reply-rejected` entry.

Loud defaults. With no settings file the session start announces its creation
and the file on disk holds the defaults; a `k` of `-3` or a model of `7`
warns by name and falls back to the default. Containers are never created:
no prompt, no subtask.
