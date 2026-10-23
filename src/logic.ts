/**
 * session-tidy — pure rules for compacting old thinking blocks.
 *
 * The module is pure: no files, no Pi events. Everything runtime-bound lives
 * in index.ts. Test scenarios — TESTING.md, direct run — probe.mjs.
 */

export interface Config {
	enabled: boolean;
	/** How many last actions keep raw thinking blocks. */
	k: number;
	/** Blocks shorter than this are not compacted. */
	minTokens: number;
	/** A digest longer than this fraction of the source block is rejected. */
	acceptanceRatio: number;
	/** Reports shorter than this are left alone. */
	minReportTokens: number;
	/** Debug mode: the rewrite is shown after the original report. */
	debug: boolean;
	/** Base model of the background calls: `provider/model-id`. */
	model?: string;
	/** Base thinking level of the background calls. */
	thinking?: string;
}

export const DEFAULT_CONFIG: Config = {
	enabled: true,
	k: 5,
	minTokens: 512,
	acceptanceRatio: 0.95,
	minReportTokens: 200,
	debug: false,
};

export interface ParsedConfig {
	config: Config;
	/** Values that fell back to defaults, one line per value. */
	problems: string[];
}

/** Unusable values fall back to defaults and are reported by name. */
export function parseConfig(raw: unknown): ParsedConfig {
	const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const problems: string[] = [];
	const unusable = (name: string, value: unknown, reason: string): void => {
		problems.push(`${name} is ${JSON.stringify(value) ?? String(value)}: ${reason}`);
	};
	const count = (name: string, value: unknown, orDefault: number): number => {
		if (value === undefined) return orDefault;
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
		unusable(name, value, "a non-negative number is expected, the default is used");
		return orDefault;
	};
	const flag = (name: string, value: unknown, orDefault: boolean): boolean => {
		if (value === undefined) return orDefault;
		if (typeof value === "boolean") return value;
		unusable(name, value, "a boolean is expected, the default is used");
		return orDefault;
	};
	const word = (name: string, value: unknown): string | undefined => {
		if (value === undefined) return undefined;
		if (typeof value === "string" && value.trim() !== "") return value.trim();
		unusable(name, value, "a non-empty string is expected, the setting is ignored");
		return undefined;
	};
	let acceptanceRatio = DEFAULT_CONFIG.acceptanceRatio;
	const enabled = flag("enabled", source.enabled, DEFAULT_CONFIG.enabled);
	const k = count("k", source.k, DEFAULT_CONFIG.k);
	const minTokens = count("minTokens", source.minTokens, DEFAULT_CONFIG.minTokens);
	const minReportTokens = count("minReportTokens", source.minReportTokens, DEFAULT_CONFIG.minReportTokens);
	const debug = flag("debug", source.debug, DEFAULT_CONFIG.debug);
	if (source.acceptanceRatio !== undefined) {
		const ratio = source.acceptanceRatio;
		if (typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 && ratio <= 1) {
			acceptanceRatio = ratio;
		} else {
			unusable("acceptanceRatio", ratio, "a number in (0, 1] is expected, the default is used");
		}
	}
	const model = word("model", source.model);
	const thinking = word("thinking", source.thinking);
	return {
		config: { enabled, k, minTokens, acceptanceRatio, minReportTokens, debug, model, thinking },
		problems,
	};
}

/** Per-subtask settings: the model fields override the config base. */
export interface Container {
	/** Model override for this subtask: `provider/model-id`. */
	model?: string;
	/** Thinking level override for this subtask. */
	thinking?: string;
	/** Task text the background model receives. */
	task: string;
}

/**
 * Frontmatter as in agents/*.md: `key: value` lines between `---` fences, the
 * body is the task text. Flat scalars only; unknown keys are ignored. Without
 * frontmatter the whole file is the task text.
 */
export function parseContainer(raw: string): Container {
	const lines = raw.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { task: raw.trim() };
	let close = -1;
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index].trim() === "---") {
			close = index;
			break;
		}
	}
	if (close < 0) return { task: raw.trim() };
	const container: Container = { task: lines.slice(close + 1).join("\n").trim() };
	for (const line of lines.slice(1, close)) {
		const separator = line.indexOf(":");
		if (separator < 0) continue;
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		if (value === "") continue;
		if (key === "model") container.model = value;
		else if (key === "thinking") container.thinking = value;
	}
	return container;
}

export interface ThinkingBlock {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}

export interface TextBlock {
	type: "text";
	text: string;
}

export interface ToolCallBlock {
	type: "toolCall";
}

export type ContentBlock = ThinkingBlock | TextBlock | ToolCallBlock | { type: string };

/** Signatures with which a provider marks replayable reasoning. */
const REASONING_SIGNATURES = new Set(["reasoning_content", "reasoning", "reasoning_text"]);

export function isThinkingBlock(block: ContentBlock): block is ThinkingBlock {
	return block.type === "thinking" && "thinking" in block && typeof block.thinking === "string";
}

export function isTextBlock(block: ContentBlock): block is TextBlock {
	return block.type === "text" && "text" in block && typeof block.text === "string";
}

/** The report text of a message: its text blocks joined. */
export function messageText(content: readonly ContentBlock[]): string {
	return content
		.filter(isTextBlock)
		.map((block) => block.text.trim())
		.filter((part) => part !== "")
		.join("\n");
}

/** Whitespace-insensitive form: rendering may join blocks differently. */
export function normalizeText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function keepsSignature(signature: unknown): boolean {
	return typeof signature === "string" && REASONING_SIGNATURES.has(signature);
}

/**
 * Whether the provider replays this block's reasoning in the next request.
 * `openai-completions` sends reasoning only with a field-name signature; without
 * one the block is silently dropped, so there is nothing to compact.
 */
export function canReplay(block: ThinkingBlock, api: string): boolean {
	if (block.redacted || block.thinking.trim() === "") return false;
	if (api === "openai-completions") return keepsSignature(block.thinkingSignature);
	return true;
}

export function blockKey(entryId: string, blockIndex: number): string {
	return `${entryId}:${blockIndex}`;
}

/**
 * Indices of thinking blocks whose visible text was changed by a foreign
 * `context_edit`: our digests are not visible in the projection, so any
 * difference is foreign.
 */
export function foreignChangedBlocks(
	content: readonly ContentBlock[],
	shown: readonly ContentBlock[] | undefined,
): number[] {
	const changed: number[] = [];
	content.forEach((block, index) => {
		if (!isThinkingBlock(block)) return;
		const shownBlock = shown?.[index];
		if (!shownBlock || !isThinkingBlock(shownBlock) || shownBlock.thinking !== block.thinking) {
			changed.push(index);
		}
	});
	return changed;
}

/** Whether a foreign `context_edit` changed the visible text of the message. */
export function foreignChangedText(
	content: readonly ContentBlock[],
	shown: readonly ContentBlock[] | undefined,
): boolean {
	return content.some((block, index) => {
		if (!isTextBlock(block)) return false;
		const shownBlock = shown?.[index];
		return !shownBlock || !isTextBlock(shownBlock) || shownBlock.text !== block.text;
	});
}

export interface VisibleAssistant {
	entryId: string;
	api: string;
	content: readonly ContentBlock[];
}

export interface Candidate {
	entryId: string;
	blockIndex: number;
	text: string;
	tokens: number;
}

/**
 * Candidates are thinking blocks left of the cut point: the last K blocks stay
 * raw, everything older is compacted. Returned in order of appearance.
 */
export function selectCandidates(
	assistants: readonly VisibleAssistant[],
	skip: ReadonlySet<string>,
	config: Pick<Config, "k" | "minTokens">,
	estimate: (text: string) => number,
): Candidate[] {
	const blocks: { entryId: string; blockIndex: number; block: ThinkingBlock; api: string }[] = [];
	for (const assistant of assistants) {
		assistant.content.forEach((block, blockIndex) => {
			if (!isThinkingBlock(block)) return;
			blocks.push({ entryId: assistant.entryId, blockIndex, block, api: assistant.api });
		});
	}
	const cutoff = Math.max(0, blocks.length - config.k);
	const candidates: Candidate[] = [];
	for (const item of blocks.slice(0, cutoff)) {
		if (skip.has(blockKey(item.entryId, item.blockIndex))) continue;
		if (!canReplay(item.block, item.api)) continue;
		const text = item.block.thinking.trim();
		const tokens = estimate(text);
		if (tokens < config.minTokens) continue;
		candidates.push({ entryId: item.entryId, blockIndex: item.blockIndex, text, tokens });
	}
	return candidates;
}

export interface ReportCandidate {
	entryId: string;
	text: string;
	tokens: number;
}

/**
 * Reports are final answers: message text without tool calls. Intermediate
 * messages between tool calls are not rewritten. The raw zone `k` does not
 * apply — a report is the newest thing in the session and the reason to work.
 */
export function selectReports(
	assistants: readonly VisibleAssistant[],
	skip: ReadonlySet<string>,
	minReportTokens: number,
	estimate: (text: string) => number,
): ReportCandidate[] {
	const reports: ReportCandidate[] = [];
	for (const assistant of assistants) {
		if (skip.has(assistant.entryId)) continue;
		if (assistant.content.some((block) => block.type === "toolCall")) continue;
		const text = messageText(assistant.content);
		if (text === "") continue;
		const tokens = estimate(text);
		if (tokens < minReportTokens) continue;
		reports.push({ entryId: assistant.entryId, text, tokens });
	}
	return reports;
}

export interface ReplyCandidate {
	entryId: string;
	text: string;
	tokens: number;
}

/**
 * Replies of the human enter the queue without a threshold: a short angry
 * message is exactly the one worth rewriting. The editor answers `<unchanged/>`
 * for a calm one and the message stays as typed.
 */
export function selectReplies(
	replies: readonly { entryId: string; content: readonly ContentBlock[] }[],
	skip: ReadonlySet<string>,
	estimate: (text: string) => number,
): ReplyCandidate[] {
	const out: ReplyCandidate[] = [];
	for (const item of replies) {
		if (skip.has(item.entryId)) continue;
		const text = messageText(item.content);
		if (text === "") continue;
		out.push({ entryId: item.entryId, text, tokens: estimate(text) });
	}
	return out;
}

export type WorkItem =
	| { kind: "digest"; candidate: Candidate }
	| { kind: "report"; report: ReportCandidate }
	| { kind: "reply"; reply: ReplyCandidate };

export interface MessageSlot {
	entryId: string;
	role: "user" | "assistant";
}

/** One queue: work items in session order, a digest before the report of the same message. */
export function orderWork(
	slots: readonly MessageSlot[],
	digests: readonly Candidate[],
	reports: readonly ReportCandidate[],
	replies: readonly ReplyCandidate[],
): WorkItem[] {
	const digestsByEntry = new Map<string, Candidate[]>();
	for (const candidate of digests) {
		const group = digestsByEntry.get(candidate.entryId) ?? [];
		group.push(candidate);
		digestsByEntry.set(candidate.entryId, group);
	}
	const reportsByEntry = new Map(reports.map((report) => [report.entryId, report]));
	const repliesByEntry = new Map(replies.map((reply) => [reply.entryId, reply]));
	const work: WorkItem[] = [];
	for (const slot of slots) {
		if (slot.role === "user") {
			const reply = repliesByEntry.get(slot.entryId);
			if (reply) work.push({ kind: "reply", reply });
			continue;
		}
		for (const candidate of digestsByEntry.get(slot.entryId) ?? []) {
			work.push({ kind: "digest", candidate });
		}
		const report = reportsByEntry.get(slot.entryId);
		if (report) work.push({ kind: "report", report });
	}
	return work;
}

/**
 * A one-to-one replacement: only the reasoning text of the target block
 * changes; answer text, tool calls and their signatures are untouched. A
 * signature that does not name a reasoning field is dropped: after a rewrite
 * such a signature is invalid.
 */
export function buildReplacement<T extends ContentBlock>(
	content: readonly T[],
	blockIndex: number,
	compactedText: string,
	keepSignature: boolean,
): T[] {
	return content.map((block, index) => {
		if (index !== blockIndex) return block;
		const replacement: Record<string, unknown> = { ...block, thinking: compactedText };
		if (!keepSignature) delete replacement.thinkingSignature;
		return replacement as unknown as T;
	});
}

/**
 * A rewritten report takes the place of the message text: the first text block
 * gets it, the rest of the text goes. Thinking and tool blocks are untouched;
 * the text signature is dropped — the text is no longer the signed one.
 */
export function buildTextReplacement<T extends ContentBlock>(content: readonly T[], rewrittenText: string): T[] {
	let placed = false;
	const next: T[] = [];
	for (const block of content) {
		if (!isTextBlock(block)) {
			next.push(block);
			continue;
		}
		if (placed) continue;
		placed = true;
		next.push({ type: "text", text: rewrittenText } as unknown as T);
	}
	return next;
}

export interface AttemptResult {
	stopReason: string;
	content: readonly ContentBlock[];
}

/**
 * Tool-call markup that leaked into text: providers return such attempts as
 * text when no tools are declared.
 */
const TOOL_PROTOCOL_PATTERNS = [
	/｜｜DSML/,
	/<｜tool_calls?｜>/,
	/<tool_calls?>/,
	/<invoke\s+name=/,
	/<function_calls?>/,
	/<antml:invoke/,
];

export function findToolProtocolMarker(text: string): string | undefined {
	return TOOL_PROTOCOL_PATTERNS.find((pattern) => pattern.test(text))?.source;
}

/**
 * A result must be wrapped in its tags — `<digest>` for a digest, `<rewrite>`
 * for a rewritten report: the contract defines the result boundary, and
 * anything the model wrote outside the tags (preamble, transcript continuation,
 * a tool call) never enters the result.
 */
export function extractTagged(text: string, tag: string): string | undefined {
	const open = new RegExp(`<${tag}>`, "i").exec(text);
	if (!open) return undefined;
	const start = open.index + open[0].length;
	const close = new RegExp(`</${tag}>`, "i").exec(text.slice(start));
	if (!close) return undefined;
	return text.slice(start, start + close.index).trim();
}

export type Verdict =
	| { ok: true; text: string; tokens: number }
	| { ok: false; reason: string; terminal: boolean };

/** A rewrite either replaces the text or leaves it alone: nothing between. */
export type RewriteVerdict =
	| { ok: true; outcome: "replace"; text: string; tokens: number }
	| { ok: true; outcome: "unchanged" }
	| { ok: false; reason: string; terminal: boolean };

function answerText(content: readonly ContentBlock[]): string {
	return content
		.filter(isTextBlock)
		.map((block) => block.text.trim())
		.filter((part) => part !== "")
		.join("\n");
}

export function validateCompaction(
	result: AttemptResult,
	rawTokens: number,
	acceptanceRatio: number,
	estimate: (text: string) => number,
): Verdict {
	if (result.stopReason !== "stop") {
		return {
			reason: `stop reason: ${result.stopReason}`,
			terminal: result.stopReason !== "error" && result.stopReason !== "aborted",
			ok: false,
		};
	}
	if (result.content.some((block) => block.type === "toolCall")) {
		return { ok: false, reason: "the answer contains a tool call", terminal: true };
	}
	const text = answerText(result.content);
	const digest = extractTagged(text, "digest");
	if (digest === undefined) {
		return { ok: false, reason: "no <digest>…</digest> wrapper", terminal: true };
	}
	if (digest === "") {
		return { ok: false, reason: "empty digest", terminal: true };
	}
	const marker = findToolProtocolMarker(digest);
	if (marker) {
		return { ok: false, reason: `tool-call markup in the digest: ${marker}`, terminal: true };
	}
	const tokens = estimate(digest);
	if (tokens > rawTokens * acceptanceRatio) {
		return {
			ok: false,
			reason: `not shorter: ${tokens} > ${Math.floor(rawTokens * acceptanceRatio)}`,
			terminal: true,
		};
	}
	return { ok: true, text: digest, tokens };
}

/** `<unchanged/>` — the model found nothing to rewrite; an empty pair is the same mark. */
const UNCHANGED_MARK = /<unchanged\s*\/>|<unchanged\s*>\s*<\/unchanged\s*>/i;

/**
 * The answer of a rewrite task carries exactly one of two marks: `<unchanged/>`
 * — nothing to rewrite — or `<rewrite>…</rewrite>` — the rewritten text. Both,
 * neither, an empty rewrite or a rewrite equal to the source is not a
 * replacement: a rewrite that adds nothing leaves the text alone. Text outside
 * the marks never enters the result.
 */
export function validateRewrite(
	result: AttemptResult,
	rawText: string,
	estimate: (text: string) => number,
): RewriteVerdict {
	if (result.stopReason !== "stop") {
		return {
			reason: `stop reason: ${result.stopReason}`,
			terminal: result.stopReason !== "error" && result.stopReason !== "aborted",
			ok: false,
		};
	}
	if (result.content.some((block) => block.type === "toolCall")) {
		return { ok: false, reason: "the answer contains a tool call", terminal: true };
	}
	const text = answerText(result.content);
	const unchanged = UNCHANGED_MARK.test(text);
	const rewritten = extractTagged(text, "rewrite");
	if (unchanged && rewritten !== undefined) {
		return { ok: false, reason: "the answer carries both <unchanged/> and <rewrite>", terminal: true };
	}
	if (unchanged) return { ok: true, outcome: "unchanged" };
	if (rewritten === undefined) {
		if (/<unchanged/i.test(text)) return { ok: false, reason: "malformed <unchanged/> mark", terminal: true };
		return { ok: false, reason: "no <unchanged/> or <rewrite>…</rewrite> in the answer", terminal: true };
	}
	if (rewritten === "") return { ok: false, reason: "empty rewrite", terminal: true };
	const marker = findToolProtocolMarker(rewritten);
	if (marker) return { ok: false, reason: `tool-call markup in the rewrite: ${marker}`, terminal: true };
	if (normalizeText(rewritten) === normalizeText(rawText)) return { ok: true, outcome: "unchanged" };
	return { ok: true, outcome: "replace", text: rewritten, tokens: estimate(rewritten) };
}

export function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	return `${Math.round(tokens / 1000)}k`;
}

export interface StatusCounts {
	enabled: boolean;
	running: boolean;
	/** Raw reasoning tokens in the context. */
	rawThinkingTokens: number;
	/** Reasoning tokens the model currently sees. */
	contextThinkingTokens: number;
	/** Tokens generated by the background calls. */
	generatedTokens: number;
	/** Reports rewritten in the current context: how badly the model writes. */
	rewrittenReports: number;
	/** Replies rewritten in the current context: the human's outbursts, marked 😞. */
	rewrittenReplies: number;
}

/** Undefined when the mode is off: the footer shows nothing instead of a label. */
export function formatStatusText(counts: StatusCounts, spinnerFrame = " "): string | undefined {
	if (!counts.enabled) return undefined;
	const separator = counts.running ? spinnerFrame : " ";
	const saved = counts.rawThinkingTokens - counts.contextThinkingTokens;
	const savedText = saved > 0 ? `-${formatTokens(saved)}` : "0";
	const reports = counts.rewrittenReports > 0 ? ` ✍ ${counts.rewrittenReports}` : "";
	const replies = counts.rewrittenReplies > 0 ? ` 😞 ${counts.rewrittenReplies}` : "";
	return `💭${separator}${savedText}/${formatTokens(counts.rawThinkingTokens)} +${formatTokens(counts.generatedTokens)}${reports}${replies}`;
}
