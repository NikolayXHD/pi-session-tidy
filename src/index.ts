/**
 * session-tidy — улучшение сессии: конспекты рассуждений и внятность докладов.
 *
 * Описание — README.md, сценарии проверки — TESTING.md, чистые правила —
 * probe.mjs.
 *
 * Первый способ улучшения: модель видит сырое мышление последних K действий,
 * более старые блоки доходят до неё короткими конспектами. Конспект делает
 * фоновый вызов по префиксу сессии; модель, thinking level и текст задачи
 * лежат в контейнере подзадачи и в JSON-конфиге (README.md).
 *
 * Digests are substituted into the context on the fly by one function:
 * - in `context`, before the main model request;
 * - in `session_before_compact`, where Pi hands the same preparation object to
 *   its own summarizer after the hook.
 *
 * Nothing is written to the session: the raw text stays in the message entry,
 * while the state lives in extension entries. Pi therefore derives the context
 * size and the compaction threshold from the real `usage`, not from a rough
 * character estimate.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getCurrentTools, type Message, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	getAgentDir,
	type BeforeAgentStartEvent,
	type ContextEvent,
	type ContextEventResult,
	type ExtensionAPI,
	type ExtensionContext,
	type MarkdownTransformContext,
	type SessionBeforeCompactEvent,
	type SessionProjection,
	type SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONFIG,
	blockKey,
	buildReplacement,
	buildReportReplacement,
	foreignChangedBlocks,
	foreignChangedText,
	formatStatusText,
	formatTokens,
	isThinkingBlock,
	keepsSignature,
	messageText,
	normalizeText,
	orderWork,
	parseConfig,
	parseContainer,
	selectCandidates,
	selectReports,
	validateCompaction,
	validateReport,
	type Candidate,
	type Config,
	type Container,
	type ReportCandidate,
	type VisibleAssistant,
	type WorkItem,
} from "./logic";

type AgentMessage = ContextEvent["messages"][number];
type AssistantContent = Extract<AgentMessage, { role: "assistant" }>["content"];

const STATUS_KEY = "session-tidy";
/** Extension entry: the digest is substituted into the context. */
const APPLIED_ENTRY = "session-tidy-applied";
/** Entries of former extension names: read so old sessions keep their digests. */
const LEGACY_APPLIED_ENTRIES = ["hybrid-thinking-applied", "compact-thinking-applied"];
/** Extension entry: the digest was rejected and is not retried. */
const REJECTED_ENTRY = "session-tidy-rejected";
const LEGACY_REJECTED_ENTRIES = ["hybrid-thinking-rejected", "compact-thinking-rejected"];
/** Extension entry: the rewritten report is substituted into the context. */
const REPORT_ENTRY = "session-tidy-report-applied";
/** Extension entry: the rewrite was rejected and is not retried. */
const REJECTED_REPORT_ENTRY = "session-tidy-report-rejected";
/** How many transient failures one block survives per session. */
const MAX_ATTEMPTS = 3;
/** Status spinner frames: they take the place of the space while the job runs. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;
/** Container directory next to the config file: per-subtask settings. */
const CONTAINER_DIR = "session-tidy";
const DIGESTS_CONTAINER = "digests";
const REPORTS_CONTAINER = "reports";

const DEFAULT_DIGEST_TASK = [
	"You are a compression tool, not the assistant in the transcript above.",
	"",
	"Rewrite the thinking block quoted below in the same language, shorter, cleaner",
	"and better organized. Keep every option considered and rejected with the",
	"reason it was rejected, every decision and its reason, every fact the",
	"reasoning relied on, every open question. Drop repetitions and filler.",
	"",
	"Wrap the result in <digest> and </digest> tags.",
].join("\n");

const DEFAULT_REPORT_TASK = [
	"You are an editing tool, not the assistant in the transcript above.",
	"",
	"Rewrite the report quoted below so the reader understands it on the first",
	"reading. Follow the writing rules from the context: one thought per",
	"paragraph, concrete words, named actors instead of vague ones, no filler.",
	"Keep every fact, decision, reason and open question of the original — the",
	"rewrite may be longer, but nothing may be lost.",
	"",
	"Wrap the result in <rewrite> and </rewrite> tags.",
].join("\n");

interface AppliedRecord {
	targetEntryId: string;
	blockIndex: number;
	rawTokens: number;
	compactedTokens: number;
	compactedText: string;
	spentTokens: number;
	spentOutput: number;
}

interface RejectedRecord {
	targetEntryId: string;
	blockIndex: number;
	reason: string;
	spentTokens: number;
	spentOutput: number;
}

interface ReportRecord {
	targetEntryId: string;
	rawTokens: number;
	rewrittenTokens: number;
	rewrittenText: string;
	spentTokens: number;
	spentOutput: number;
}

interface RejectedReportRecord {
	targetEntryId: string;
	reason: string;
	spentTokens: number;
	spentOutput: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asAppliedRecord(data: unknown): AppliedRecord | undefined {
	if (!isRecord(data)) return undefined;
	if (typeof data.targetEntryId !== "string" || typeof data.compactedText !== "string") return undefined;
	if (!Number.isFinite(data.blockIndex)) return undefined;
	return {
		targetEntryId: data.targetEntryId,
		blockIndex: Number(data.blockIndex),
		rawTokens: Number(data.rawTokens ?? 0),
		compactedTokens: Number(data.compactedTokens ?? 0),
		compactedText: data.compactedText,
		spentTokens: Number(data.spentTokens ?? 0),
		spentOutput: Number(data.spentOutput ?? 0),
	};
}

function asRejectedRecord(data: unknown): RejectedRecord | undefined {
	if (!isRecord(data)) return undefined;
	if (typeof data.targetEntryId !== "string" || !Number.isFinite(data.blockIndex)) return undefined;
	return {
		targetEntryId: data.targetEntryId,
		blockIndex: Number(data.blockIndex),
		reason: typeof data.reason === "string" ? data.reason : "rejected",
		spentTokens: Number(data.spentTokens ?? 0),
		spentOutput: Number(data.spentOutput ?? 0),
	};
}

function asReportRecord(data: unknown): ReportRecord | undefined {
	if (!isRecord(data)) return undefined;
	if (typeof data.targetEntryId !== "string" || typeof data.rewrittenText !== "string") return undefined;
	return {
		targetEntryId: data.targetEntryId,
		rawTokens: Number(data.rawTokens ?? 0),
		rewrittenTokens: Number(data.rewrittenTokens ?? 0),
		rewrittenText: data.rewrittenText,
		spentTokens: Number(data.spentTokens ?? 0),
		spentOutput: Number(data.spentOutput ?? 0),
	};
}

function asRejectedReportRecord(data: unknown): RejectedReportRecord | undefined {
	if (!isRecord(data)) return undefined;
	if (typeof data.targetEntryId !== "string") return undefined;
	return {
		targetEntryId: data.targetEntryId,
		reason: typeof data.reason === "string" ? data.reason : "rejected",
		spentTokens: Number(data.spentTokens ?? 0),
		spentOutput: Number(data.spentOutput ?? 0),
	};
}

function configPath(): string {
	return join(getAgentDir(), "session-tidy.json");
}

function loadConfig(): { config: Config; problems: string[]; created?: string } {
	for (const path of [configPath(), legacyConfigPath()]) {
		try {
			const parsed = parseConfig(JSON.parse(readFileSync(path, "utf8")));
			return { config: parsed.config, problems: parsed.problems.map((problem) => `${path}: ${problem}`) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			const message = error instanceof Error ? error.message : String(error);
			return { config: DEFAULT_CONFIG, problems: [`${path}: ${message}`] };
		}
	}
	const path = configPath();
	writeDefaultFile(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
	return { config: DEFAULT_CONFIG, problems: [], created: path };
}

/** Config of the former extension name: read so old setups keep working. */
function legacyConfigPath(): string {
	return join(getAgentDir(), "compact-thinking.json");
}

function containerPath(name: string): string {
	return join(getAgentDir(), CONTAINER_DIR, `${name}.md`);
}

/** A missing file is created with the default content: nothing runs in secret. */
function writeDefaultFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function loadContainer(name: string, fallbackTask: string): { container: Container; problems: string[]; created?: string } {
	const path = containerPath(name);
	try {
		const container = parseContainer(readFileSync(path, "utf8"));
		if (container.task === "") {
			return {
				container: { ...container, task: fallbackTask },
				problems: [`${path}: the task text is empty, the built-in text is used`],
			};
		}
		return { container, problems: [] };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			writeDefaultFile(path, `${fallbackTask.trim()}\n`);
			return { container: { task: fallbackTask }, problems: [], created: path };
		}
		const message = error instanceof Error ? error.message : String(error);
		return { container: { task: fallbackTask }, problems: [`${path}: ${message}`] };
	}
}

function buildRequestText(task: string, tag: string, text: string): string {
	return `${task}\n\n<${tag}>\n${text}\n</${tag}>`;
}

/** Estimated like Pi does: four characters per token. */
const estimate = (text: string): number => Math.ceil(text.length / 4);

class SessionTidy {
	private readonly pi: ExtensionAPI;
	private readonly config: Config;
	private readonly problems: string[];
	private readonly created: string[];
	private readonly digestsContainer: Container;
	private readonly reportsContainer: Container;
	private readonly announced = new Set<string>();
	private readonly appliedRecords = new Map<string, AppliedRecord>();
	private readonly rejected = new Map<string, string>();
	private readonly reportRecords = new Map<string, ReportRecord>();
	private readonly reportRejected = new Map<string, string>();
	/** Rewritten report text by the normalized raw text: the render lookup. */
	private readonly rewriteByRaw = new Map<string, string>();
	private readonly attempts = new Map<string, number>();

	/**
	 * The background job must not touch `ctx`: it goes stale after session
	 * replacement or reload. References and values are captured while the event
	 * handler is still active.
	 */
	private manager: ExtensionContext["sessionManager"] | undefined;
	private registry: ExtensionContext["modelRegistry"] | undefined;
	private model: ExtensionContext["model"] | undefined;
	private ui: ExtensionContext["ui"] | undefined;
	private runPrompt = "";
	private systemOptions: { forceSystemPrompt?: string } | undefined;

	/** Context with digests substituted, keyed by assistant message time. */
	private substitutions = new Map<number, AssistantContent>();

	private enabled: boolean;
	private debug: boolean;
	private running = false;
	private rewrittenReports = 0;
	private activeDigests = 0;
	private spinnerIndex = 0;
	private spinner: ReturnType<typeof setInterval> | undefined;
	private job: AbortController | undefined;
	private generation = 0;
	private spentTokens = 0;
	private spentOutput = 0;
	private rejectedSpentTokens = 0;
	private rejectedSpentOutput = 0;
	private rawThinkingTokens = 0;
	private savedThinkingTokens = 0;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		const loaded = loadConfig();
		this.config = loaded.config;
		const digests = loadContainer(DIGESTS_CONTAINER, DEFAULT_DIGEST_TASK);
		this.digestsContainer = digests.container;
		const reports = loadContainer(REPORTS_CONTAINER, DEFAULT_REPORT_TASK);
		this.reportsContainer = reports.container;
		this.problems = [...loaded.problems, ...digests.problems, ...reports.problems];
		this.created = [loaded.created, digests.created, reports.created].filter((path): path is string => path !== undefined);
		this.enabled = loaded.config.enabled;
		this.debug = loaded.config.debug;

		pi.on("session_start", (_event, ctx) => this.onSessionStart(ctx));
		pi.on("session_tree", (_event: SessionTreeEvent, ctx) => this.onTree(ctx));
		pi.on("before_agent_start", (event: BeforeAgentStartEvent) => this.onBeforeAgentStart(event));
		pi.on("context", (event: ContextEvent) => this.onContext(event));
		pi.on("session_before_compact", (event: SessionBeforeCompactEvent) => this.onBeforeCompact(event));
		pi.on("tool_execution_start", (_event, ctx) => this.onToolExecutionStart(ctx));
		pi.on("turn_end", (_event, ctx) => this.onTurnEnd(ctx));
		pi.on("agent_before_settle", (_event, ctx) => this.onAgentBeforeSettle(ctx));
		pi.on("session_shutdown", () => this.stop());
		pi.registerMarkdownTransformer((markdown, context) => this.transformMarkdown(markdown, context));
		pi.registerCommand("session-tidy", {
			description: "Tidy the session: report, on, off, debug on|off, dump",
			handler: async (args, ctx) => this.onCommand(args, ctx),
		});
	}

	private onSessionStart(ctx: ExtensionContext): void {
		this.capture(ctx);
		this.generation += 1;
		this.systemOptions = undefined;
		this.enabled = this.config.enabled;
		this.debug = this.config.debug;
		this.rebuild();
		if (this.problems.length > 0) {
			for (const problem of this.problems) this.warn(`session-tidy: ${problem}`);
		}
		for (const path of this.created) this.inform(`session-tidy: created ${path} with the default content`);
		this.updateStatus();
	}

	/** Tree navigation does not emit `session_start`: the branch state is rebuilt. */
	private onTree(ctx: ExtensionContext): void {
		this.capture(ctx);
		this.rebuild();
		this.updateStatus();
	}

	/** Pi collapses a forced prompt (set by extensions like roles) into one head. */
	private onBeforeAgentStart(event: BeforeAgentStartEvent): void {
		this.systemOptions = event.systemPromptOptions;
	}

	/** Context before the model request: digests take the place of raw blocks. */
	private onContext(event: ContextEvent): ContextEventResult | undefined {
		const messages = this.substituteMessages(event.messages);
		return messages ? { messages } : undefined;
	}

	/** The same context for Pi's summarizer: the preparation is edited in place. */
	private onBeforeCompact(event: SessionBeforeCompactEvent): void {
		const summarized = this.substituteMessages(event.preparation.messagesToSummarize);
		if (summarized) event.preparation.messagesToSummarize = summarized;
		const prefix = this.substituteMessages(event.preparation.turnPrefixMessages);
		if (prefix) event.preparation.turnPrefixMessages = prefix;
	}

	/** The tool window: the background job does not compete with the model stream. */
	private onToolExecutionStart(ctx: ExtensionContext): void {
		this.capture(ctx);
		this.refreshThinkingTokens();
		setTimeout(() => void this.pump(), 0);
	}

	private onTurnEnd(ctx: ExtensionContext): void {
		this.capture(ctx);
		this.refreshThinkingTokens();
		this.updateStatus();
	}

	private onAgentBeforeSettle(ctx: ExtensionContext): void {
		this.capture(ctx);
		this.refreshThinkingTokens();
		this.updateStatus();
		setTimeout(() => void this.pump(), 0);
	}

	private onCommand(args: string, ctx: ExtensionContext): void {
		this.capture(ctx);
		const command = args.trim().toLowerCase();
		if (command === "on" || command === "off") {
			this.enabled = command === "on";
			this.updateStatus();
			this.notify(`session-tidy: ${this.enabled ? "on" : "off"}`, "info");
			if (this.enabled) setTimeout(() => void this.pump(), 0);
			return;
		}
		if (command === "debug" || command === "debug on" || command === "debug off") {
			this.debug = command === "debug" ? !this.debug : command === "debug on";
			this.notify(`session-tidy: debug ${this.debug ? "on" : "off"}`, "info");
			return;
		}
		if (command === "dump") {
			this.dump();
			return;
		}
		this.updateStatus();
		this.notify(this.reportText(), "info");
	}

	private capture(ctx: ExtensionContext): void {
		this.manager = ctx.sessionManager;
		this.registry = ctx.modelRegistry;
		this.model = ctx.model;
		this.ui = ctx.ui;
		this.runPrompt = ctx.getSystemPrompt();
	}

	/** Restore the branch state after restart, resume and navigation. */
	private rebuild(): void {
		const manager = this.manager;
		if (!manager) return;
		this.appliedRecords.clear();
		this.rejected.clear();
		this.reportRecords.clear();
		this.reportRejected.clear();
		this.attempts.clear();
		this.rejectedSpentTokens = 0;
		this.rejectedSpentOutput = 0;
		for (const entry of manager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === APPLIED_ENTRY || LEGACY_APPLIED_ENTRIES.includes(entry.customType)) {
				const record = asAppliedRecord(entry.data);
				if (!record) continue;
				if (record.rawTokens < record.compactedTokens) continue;
				this.appliedRecords.set(blockKey(record.targetEntryId, record.blockIndex), record);
			} else if (entry.customType === REJECTED_ENTRY || LEGACY_REJECTED_ENTRIES.includes(entry.customType)) {
				const record = asRejectedRecord(entry.data);
				if (!record) continue;
				this.rejected.set(blockKey(record.targetEntryId, record.blockIndex), record.reason);
				this.rejectedSpentTokens += record.spentTokens;
				this.rejectedSpentOutput += record.spentOutput;
			} else if (entry.customType === REPORT_ENTRY) {
				const record = asReportRecord(entry.data);
				if (!record) continue;
				this.reportRecords.set(record.targetEntryId, record);
			} else if (entry.customType === REJECTED_REPORT_ENTRY) {
				const record = asRejectedReportRecord(entry.data);
				if (!record) continue;
				this.reportRejected.set(record.targetEntryId, record.reason);
				this.rejectedSpentTokens += record.spentTokens;
				this.rejectedSpentOutput += record.spentOutput;
			}
		}
		this.rebuildSubstitutions();
	}

	/**
	 * Build the substituted context: for every target entry, its content with the
	 * replaced blocks. Counters take only active digests into account.
	 */
	private rebuildSubstitutions(): void {
		const manager = this.manager;
		this.substitutions = new Map();
		this.rewriteByRaw.clear();
		this.savedThinkingTokens = 0;
		this.rewrittenReports = 0;
		this.activeDigests = 0;
		this.spentTokens = this.rejectedSpentTokens;
		this.spentOutput = this.rejectedSpentOutput;
		if (!manager) return;
		const projection = manager.buildSessionProjection();
		const inContext = new Set(projection.entries.map((projected) => projected.sourceEntry.id));
		const digestsByTarget = new Map<string, AppliedRecord[]>();
		for (const record of this.appliedRecords.values()) {
			if (!inContext.has(record.targetEntryId)) continue;
			const group = digestsByTarget.get(record.targetEntryId) ?? [];
			group.push(record);
			digestsByTarget.set(record.targetEntryId, group);
		}
		const targets = new Set<string>([...digestsByTarget.keys(), ...this.reportRecords.keys()]);
		for (const targetId of targets) {
			if (!inContext.has(targetId)) continue;
			const entry = manager.getEntry(targetId);
			if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
			const ordered = [...(digestsByTarget.get(targetId) ?? [])].sort((left, right) => left.blockIndex - right.blockIndex);
			let content = entry.message.content;
			for (const record of ordered) {
				const block = content[record.blockIndex];
				if (!block || block.type !== "thinking") continue;
				content = buildReplacement(
					content,
					record.blockIndex,
					record.compactedText,
					keepsSignature(block.thinkingSignature),
				);
				this.savedThinkingTokens += record.rawTokens - record.compactedTokens;
				this.activeDigests += 1;
				this.spentTokens += record.spentTokens;
				this.spentOutput += record.spentOutput;
			}
			const report = this.reportRecords.get(targetId);
			if (report) {
				this.rewriteByRaw.set(normalizeText(messageText(entry.message.content)), report.rewrittenText);
				content = buildReportReplacement(content, report.rewrittenText);
				this.rewrittenReports += 1;
				this.spentTokens += report.spentTokens;
				this.spentOutput += report.spentOutput;
			}
			this.substitutions.set(entry.message.timestamp, content);
		}
		this.rawThinkingTokens = this.measureRawThinking(projection);
	}

	private transformMarkdown(markdown: string, context: MarkdownTransformContext): string {
		if (context.messageType !== "assistant") return markdown;
		const key = normalizeText(markdown);
		const rewritten = this.rewriteByRaw.get(key);
		try {
			appendFileSync(
				"/tmp/session-tidy-transform.log",
				`${Date.now()} ${JSON.stringify({ hit: rewritten !== undefined, key: key.slice(0, 40) })}\n`,
			);
		} catch {
			// Debug log only.
		}
		if (rewritten === undefined) return markdown;
		if (this.debug) return `${markdown}\n\n---\n\n${rewritten}`;
		return rewritten;
	}

	/** Substitute digests into the messages; undefined when there is nothing to change. */
	private substituteMessages(messages: readonly AgentMessage[]): AgentMessage[] | undefined {
		if (this.substitutions.size === 0) return undefined;
		let changed = false;
		const next = messages.map((message) => {
			if (message.role !== "assistant") return message;
			const content = this.substitutions.get(message.timestamp);
			if (!content) return message;
			changed = true;
			return { ...message, content };
		});
		return changed ? next : undefined;
	}

	/**
	 * The oldest uncompacted block left of the cut point. A block whose visible
	 * text was changed by a foreign `context_edit` is left alone.
	 */
	/** The oldest work item: a digest or a report, in session order. */
	private pickWork(): WorkItem | undefined {
		const manager = this.manager;
		if (!manager) return undefined;
		const projection = manager.buildSessionProjection();
		const assistants: VisibleAssistant[] = [];
		const changed = new Set<string>();
		const textChanged = new Set<string>();
		for (const projected of projection.entries) {
			const entry = projected.sourceEntry;
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const visible = projected.messages[0];
			if (!visible || visible.role !== "assistant" || !Array.isArray(visible.content)) continue;
			const content = entry.message.content;
			const foreign = foreignChangedBlocks(content, visible.content);
			if (foreign.length > 0) {
				content.forEach((block, index) => {
					if (block.type === "thinking") changed.add(blockKey(entry.id, index));
				});
			}
			if (foreignChangedText(content, visible.content)) textChanged.add(entry.id);
			assistants.push({ entryId: entry.id, api: entry.message.api, content });
		}
		const skipDigests = new Set<string>([...this.appliedRecords.keys(), ...this.rejected.keys(), ...changed]);
		const skipReports = new Set<string>([...this.reportRecords.keys(), ...this.reportRejected.keys(), ...textChanged]);
		const digests = selectCandidates(assistants, skipDigests, this.config, estimate);
		const reports = selectReports(assistants, skipReports, this.config.minReportTokens, estimate);
		return orderWork(assistants, digests, reports)[0];
	}

	/**
	 * Rewrite a report clearer. The request repeats the session prefix, so the
	 * editor sees the writing rules from the context. Length is no criterion:
	 * reports are not compressed.
	 */
	private async rewrite(report: ReportCandidate): Promise<void> {
		const container = this.reportsContainer;
		const message = await this.editorCall(
			container,
			buildRequestText(container.task, "report", report.text),
			Math.max(512, report.tokens * 2),
		);
		if (!message) return;
		const spentTokens = message.usage?.totalTokens ?? 0;
		const spentOutput = message.usage?.output ?? 0;
		const verdict = validateReport(message, estimate);
		if (!verdict.ok) {
			const reason = message.errorMessage ? `${verdict.reason}: ${message.errorMessage}` : verdict.reason;
			if (!verdict.terminal) {
				const attempts = (this.attempts.get(report.entryId) ?? 0) + 1;
				this.attempts.set(report.entryId, attempts);
				if (attempts < MAX_ATTEMPTS) {
					this.spentTokens += spentTokens;
					this.spentOutput += spentOutput;
					throw new Error(reason);
				}
			}
			this.attempts.delete(report.entryId);
			const record: RejectedReportRecord = { targetEntryId: report.entryId, reason, spentTokens, spentOutput };
			this.persist(REJECTED_REPORT_ENTRY, record);
			this.reportRejected.set(report.entryId, reason);
			this.rejectedSpentTokens += spentTokens;
			this.rejectedSpentOutput += spentOutput;
			return;
		}
		this.attempts.delete(report.entryId);
		const record: ReportRecord = {
			targetEntryId: report.entryId,
			rawTokens: report.tokens,
			rewrittenTokens: verdict.tokens,
			rewrittenText: verdict.text,
			spentTokens,
			spentOutput,
		};
		this.persist(REPORT_ENTRY, record);
		this.reportRecords.set(report.entryId, record);
		this.rebuildSubstitutions();
	}

	/** A digest stands in the place of the raw block: shorter, nothing lost. */
	private async compact(candidate: Candidate): Promise<void> {
		const container = this.digestsContainer;
		const message = await this.editorCall(
			container,
			buildRequestText(container.task, "thinking_block", candidate.text),
			Math.max(512, candidate.tokens),
		);
		if (!message) return;
		const spentTokens = message.usage?.totalTokens ?? 0;
		const spentOutput = message.usage?.output ?? 0;
		const verdict = validateCompaction(message, candidate.tokens, this.config.acceptanceRatio, estimate);
		const key = blockKey(candidate.entryId, candidate.blockIndex);
		if (!verdict.ok) {
			const reason = message.errorMessage ? `${verdict.reason}: ${message.errorMessage}` : verdict.reason;
			if (!verdict.terminal) {
				const attempts = (this.attempts.get(key) ?? 0) + 1;
				this.attempts.set(key, attempts);
				if (attempts < MAX_ATTEMPTS) {
					this.spentTokens += spentTokens;
					this.spentOutput += spentOutput;
					throw new Error(reason);
				}
			}
			this.attempts.delete(key);
			const record: RejectedRecord = {
				targetEntryId: candidate.entryId,
				blockIndex: candidate.blockIndex,
				reason,
				spentTokens,
				spentOutput,
			};
			this.persist(REJECTED_ENTRY, record);
			this.rejected.set(key, reason);
			this.rejectedSpentTokens += spentTokens;
			this.rejectedSpentOutput += spentOutput;
			return;
		}
		this.attempts.delete(key);
		const record: AppliedRecord = {
			targetEntryId: candidate.entryId,
			blockIndex: candidate.blockIndex,
			rawTokens: candidate.tokens,
			compactedTokens: verdict.tokens,
			compactedText: verdict.text,
			spentTokens,
			spentOutput,
		};
		this.persist(APPLIED_ENTRY, record);
		this.appliedRecords.set(key, record);
		this.rebuildSubstitutions();
	}

	/**
	 * One call of the editor model over the session prefix — the same prefix the
	 * main session sends: applied transformations stand where they were
	 * substituted, so the provider cache is shared and later calls build on
	 * earlier results. With a forced system prompt Pi collapses system messages
	 * into one head — mirrored here. Undefined when the session moved on.
	 */
	private async editorCall(container: Container, requestText: string, maxTokens: number) {
		const manager = this.manager;
		const registry = this.registry;
		const model = this.editorModel(container.model ?? this.config.model);
		if (!manager || !registry || !model) return undefined;
		const generation = this.generation;
		const projection = manager.buildSessionProjection();
		const messages = convertToLlm(this.substituteMessages(projection.messages) ?? projection.messages);
		const tools = getCurrentTools(messages);
		const prefix: Message[] =
			this.systemOptions?.forceSystemPrompt !== undefined
				? [
						{
							role: "system",
							content: this.runPrompt,
							...(tools.length > 0 ? { toolsAdded: tools } : {}),
							timestamp: Date.now(),
						},
						...messages.filter((message) => message.role !== "system"),
					]
				: messages;
		prefix.push({ role: "user", content: [{ type: "text", text: requestText }], timestamp: Date.now() });

		const controller = new AbortController();
		this.job = controller;
		try {
			const reasoning = (container.thinking ?? this.config.thinking) as SimpleStreamOptions["reasoning"];
			const stream = registry.streamSimple(model, { messages: prefix }, {
				maxTokens,
				toolChoice: "none",
				...(reasoning !== undefined ? { reasoning } : {}),
				sessionId: manager.getSessionId(),
				signal: controller.signal,
			});
			const iterator = stream[Symbol.asyncIterator]();
			while (!(await iterator.next()).done) {
				// Drain the stream: its event queue otherwise grows with the answer.
			}
			const message = await stream.result();
			if (generation !== this.generation || controller.signal.aborted) return undefined;
			return message;
		} finally {
			this.job = undefined;
		}
	}

	/**
	 * Model of a background call: the container override, the config base, or
	 * the session model. The setting names the model as `provider/model-id`.
	 */
	private editorModel(spec: string | undefined) {
		if (!spec) {
			this.warn("session-tidy: model is not set, the background calls go to the session model");
			return this.model;
		}
		const registry = this.registry;
		if (!registry) return this.model;
		const separator = spec.indexOf("/");
		if (separator <= 0) {
			this.warn(`session-tidy: "${spec}" is not provider/model-id`);
			return this.model;
		}
		const found = registry.find(spec.slice(0, separator), spec.slice(separator + 1));
		if (!found) {
			this.warn(`session-tidy: model "${spec}" is not found`);
			return this.model;
		}
		return found;
	}

	/** One background job: walk the candidates while there are any. */
	private async pump(): Promise<void> {
		if (this.running || !this.enabled) return;
		const generation = this.generation;
		this.running = true;
		this.refreshThinkingTokens();
		this.startSpinner();
		try {
			for (;;) {
				if (generation !== this.generation || !this.enabled) return;
				const work = this.pickWork();
				if (!work) return;
				if (work.kind === "digest") await this.compact(work.candidate);
				else await this.rewrite(work.report);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.warn(`session-tidy: ${message}`);
		} finally {
			this.running = false;
			this.stopSpinner();
		}
	}

	private startSpinner(): void {
		if (this.spinner) return;
		this.spinnerIndex = 0;
		this.updateStatus();
		this.spinner = setInterval(() => {
			this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
			this.updateStatus();
		}, SPINNER_INTERVAL_MS);
	}

	private stopSpinner(): void {
		if (this.spinner) clearInterval(this.spinner);
		this.spinner = undefined;
		this.updateStatus();
	}

	/**
	 * Next to the session file: `thinking-a` holds raw blocks, `thinking-b` what
	 * the model sees after substitution. Block headings match so a diff aligns.
	 */
	private dump(): void {
		const manager = this.manager;
		if (!manager) return;
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) {
			this.notify("session-tidy: the session is not persisted, nowhere to write", "warning");
			return;
		}
		const raw: string[] = [];
		const substituted: string[] = [];
		for (const projected of manager.buildSessionProjection().entries) {
			const entry = projected.sourceEntry;
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const content = this.substitutions.get(entry.message.timestamp);
			if (!content) continue;
			entry.message.content.forEach((block, index) => {
				if (block.type !== "thinking") return;
				if (!this.appliedRecords.has(blockKey(entry.id, index))) return;
				const replaced = content[index];
				const heading = `## ${entry.id}:${index} ${entry.timestamp}`;
				raw.push(`${heading}\n\n${block.thinking.trim()}`);
				substituted.push(`${heading}\n\n${isThinkingBlock(replaced) ? replaced.thinking.trim() : block.thinking.trim()}`);
			});
		}
		const dir = dirname(sessionFile);
		writeFileSync(join(dir, "thinking-a"), `${raw.join("\n\n")}\n`);
		writeFileSync(join(dir, "thinking-b"), `${substituted.join("\n\n")}\n`);
		this.notify(`session-tidy: ${raw.length} digests in ${dir}`, "info");
	}

	private persist(customType: string, data: unknown): void {
		try {
			this.pi.appendEntry(customType, data);
		} catch {
			// The session is already replaced or closed: nowhere to put the entry.
		}
	}

	private statusText(): string | undefined {
		const frame = SPINNER_FRAMES[this.spinnerIndex] ?? " ";
		return formatStatusText(
			{
				enabled: this.enabled,
				running: this.running,
				rawThinkingTokens: this.rawThinkingTokens,
				contextThinkingTokens: this.rawThinkingTokens - this.savedThinkingTokens,
				generatedTokens: this.spentOutput,
				rewrittenReports: this.rewrittenReports,
			},
			frame,
		);
	}

	/** Detailed report for `/session-tidy` without arguments. */
	private reportText(): string {
		return (
			`session-tidy: ${this.enabled ? "on" : "off"} · ` +
			`digests ${this.activeDigests} · reports ${this.rewrittenReports} · ` +
			`saved ${formatTokens(this.savedThinkingTokens)} tokens · ` +
			`generated ${formatTokens(this.spentOutput)} tokens · ` +
			`read ${formatTokens(this.spentTokens)} prefix tokens`
		);
	}

	/** Raw reasoning tokens in the current context. */
	private measureRawThinking(projection: SessionProjection): number {
		let raw = 0;
		for (const projected of projection.entries) {
			const entry = projected.sourceEntry;
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (block.type === "thinking") raw += estimate(block.thinking);
			}
		}
		return raw;
	}

	/** Recompute the raw reasoning sum for the current context. */
	private refreshThinkingTokens(): void {
		const manager = this.manager;
		if (!manager) return;
		this.rawThinkingTokens = this.measureRawThinking(manager.buildSessionProjection());
	}

	private updateStatus(): void {
		try {
			this.ui?.setStatus(STATUS_KEY, this.statusText());
		} catch {
			// Stale UI after a session replacement: the line no longer exists.
		}
	}

	private notify(message: string, level: "info" | "warning" | "error"): void {
		try {
			this.ui?.notify(message, level);
		} catch {
			// Stale UI after a session replacement.
		}
	}

	private warn(message: string): void {
		this.announce(message, "warning");
	}

	private inform(message: string): void {
		this.announce(message, "info");
	}

	private announce(message: string, level: "info" | "warning"): void {
		if (this.announced.has(message)) return;
		this.announced.add(message);
		this.notify(message, level);
	}

	private stop(): void {
		this.generation += 1;
		this.job?.abort();
		this.stopSpinner();
		this.running = false;
	}
}

export default function sessionTidy(pi: ExtensionAPI): void {
	new SessionTidy(pi);
}
