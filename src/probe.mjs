// Direct run of the extension rules through Node's type stripping: no Pi session.
import {
	parseConfig,
	parseContainer,
	DEFAULT_CONFIG,
	blockKey,
	canReplay,
	keepsSignature,
	selectCandidates,
	buildReplacement,
	buildTextReplacement,
	foreignChangedBlocks,
	foreignChangedText,
	orderWork,
	selectReplies,
	messageText,
	normalizeText,
	selectReports,
	extractTagged,
	findToolProtocolMarker,
	validateCompaction,
	validateRewrite,
	formatTokens,
	formatStatusText,
} from "./logic.ts";

let passed = 0;
let failed = 0;
/** Key order and undefined values do not matter, like in JSON. */
const canonical = (value) => {
	if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.keys(value)
			.sort()
			.filter((key) => value[key] !== undefined)
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
};
const expectEqual = (name, got, want) => {
	if (canonical(got) === canonical(want)) {
		passed += 1;
		return;
	}
	failed += 1;
	console.log(`FAIL ${name}`);
	console.log(`  got:  ${JSON.stringify(got)}`);
	console.log(`  want: ${JSON.stringify(want)}`);
};
const expectTrue = (name, ok, detail) => {
	if (ok) {
		passed += 1;
		return;
	}
	failed += 1;
	console.log(`FAIL ${name}`);
	if (detail !== undefined) console.log(`  got: ${JSON.stringify(detail)}`);
};

const estimateText = (text) => Math.ceil(text.length / 4);
const thinkingBlock = (text, extra = {}) => ({ type: "thinking", thinking: text, ...extra });
const textBlock = (value) => ({ type: "text", text: value });
const repeatChar = (char, count) => char.repeat(count);
const candidateKeys = (candidates) => candidates.map((candidate) => blockKey(candidate.entryId, candidate.blockIndex));
const windowConfig = (k, minTokens) => ({ k, minTokens });
const attemptResult = (stopReason, content) => ({ stopReason, content });

expectEqual("empty config gives defaults", parseConfig(undefined), { config: DEFAULT_CONFIG, problems: [] });
const fullConfig = parseConfig({
	enabled: false,
	k: 2,
	minTokens: 100,
	acceptanceRatio: 0.5,
	minReportTokens: 100,
	debug: true,
	model: "deepseek/deepseek-flash",
	thinking: "high",
});
expectEqual("config fields are read", fullConfig.config, {
	enabled: false,
	k: 2,
	minTokens: 100,
	acceptanceRatio: 0.5,
	minReportTokens: 100,
	debug: true,
	model: "deepseek/deepseek-flash",
	thinking: "high",
});
expectEqual("usable values leave no problems", fullConfig.problems, []);
const brokenConfig = parseConfig({ k: -3, minTokens: "x", acceptanceRatio: 2 });
expectEqual("broken fields fall back to defaults", brokenConfig.config, DEFAULT_CONFIG);
expectEqual("broken fields are reported by name", brokenConfig.problems, [
	"k is -3: a non-negative number is expected, the default is used",
	'minTokens is "x": a non-negative number is expected, the default is used',
	"acceptanceRatio is 2: a number in (0, 1] is expected, the default is used",
]);
expectEqual("fractional k rounds down", parseConfig({ k: 2.9 }).config.k, 2);
const stringEnabled = parseConfig({ enabled: "false" });
expectEqual("a string instead of enabled does not disable the mode", stringEnabled.config.enabled, true);
expectEqual("a string instead of enabled is reported", stringEnabled.problems, [
	'enabled is "false": a boolean is expected, the default is used',
]);
expectEqual("acceptance ratio zero is not accepted", parseConfig({ acceptanceRatio: 0 }).config.acceptanceRatio, DEFAULT_CONFIG.acceptanceRatio);
expectEqual("acceptance ratio one is allowed", parseConfig({ acceptanceRatio: 1 }).config.acceptanceRatio, 1);
const configWithEditor = parseConfig({ model: "deepseek/deepseek-flash", thinking: "high" });
expectEqual("the editor model is read from the config", configWithEditor.config.model, "deepseek/deepseek-flash");
expectEqual("the editor thinking level is read from the config", configWithEditor.config.thinking, "high");
const emptyModel = parseConfig({ model: "   " });
expectEqual("an empty model is ignored", emptyModel.config.model, undefined);
expectEqual("an empty model is reported", emptyModel.problems, [
	'model is "   ": a non-empty string is expected, the setting is ignored',
]);
const nonStringModel = parseConfig({ model: 7 });
expectEqual("a non-string model is ignored", nonStringModel.config.model, undefined);
expectEqual("a non-string model is reported", nonStringModel.problems.length, 1);

const containerText = ["---", "model: deepseek/deepseek-flash", "thinking: high", "---", "", "Rewrite the block."].join("\n");
expectEqual("the container keeps model, thinking and task", parseContainer(containerText), {
	model: "deepseek/deepseek-flash",
	thinking: "high",
	task: "Rewrite the block.",
});
expectEqual("without frontmatter the whole file is the task", parseContainer("Just the task."), { task: "Just the task." });
expectEqual(
	"an unclosed fence leaves the file as the task",
	parseContainer(["---", "model: a/b", "Just the task."].join("\n")),
	{ task: ["---", "model: a/b", "Just the task."].join("\n") },
);
expectEqual("unknown keys are ignored", parseContainer(["---", "name: digests", "---", "Task."].join("\n")), { task: "Task." });
expectEqual("an empty value is ignored", parseContainer(["---", "model:", "---", "Task."].join("\n")), { task: "Task." });
expectEqual(
	"a line without a separator is ignored",
	parseContainer(["---", "model: a/b", "nonsense", "---", "Task."].join("\n")),
	{ model: "a/b", task: "Task." },
);

expectTrue("reasoning_content is a reasoning signature", keepsSignature("reasoning_content"));
expectTrue("reasoning is a reasoning signature", keepsSignature("reasoning"));
expectTrue("reasoning_text is a reasoning signature", keepsSignature("reasoning_text"));
expectEqual("a foreign signature is not a reasoning field", keepsSignature("signed-by-server"), false);
expectEqual("an undefined signature is not a reasoning field", keepsSignature(undefined), false);

expectTrue(
	"a signed openai-completions block is replayed",
	canReplay(thinkingBlock("thought", { thinkingSignature: "reasoning_content" }), "openai-completions"),
);
expectEqual(
	"a signature that is not a reasoning field drops the block",
	canReplay(thinkingBlock("thought", { thinkingSignature: "sig" }), "openai-completions"),
	false,
);
expectEqual(
	"a redacted block is not replayed",
	canReplay(thinkingBlock("thought", { redacted: true, thinkingSignature: "reasoning_content" }), "openai-completions"),
	false,
);
expectEqual("a redacted block with a foreign signature is not replayed", canReplay(thinkingBlock("thought", { redacted: true, thinkingSignature: "sig" }), "openai-completions"), false);
expectEqual("an empty text is not replayed", canReplay(thinkingBlock("   "), "anthropic-messages"), false);
expectTrue("anthropic replays a block without a signature", canReplay(thinkingBlock("thought"), "anthropic-messages"));
expectTrue("an unknown API replays the block", canReplay(thinkingBlock("thought"), "google-generative-ai"));

const longReasoning = repeatChar("a", 400);
const shortReasoning = repeatChar("b", 40);
const assistants = [
	{ entryId: "e1", api: "anthropic-messages", content: [thinkingBlock(longReasoning), textBlock("ok")] },
	{ entryId: "e2", api: "anthropic-messages", content: [thinkingBlock(longReasoning), { type: "toolCall" }, thinkingBlock(longReasoning)] },
	{ entryId: "e3", api: "anthropic-messages", content: [thinkingBlock(longReasoning)] },
];

expectEqual(
	"k keeps the last blocks raw",
	candidateKeys(selectCandidates(assistants, new Set(), windowConfig(2, 1), estimateText)),
	["e1:0", "e2:0"],
);
expectEqual("k covers the whole history: no candidates", candidateKeys(selectCandidates(assistants, new Set(), windowConfig(4, 1), estimateText)), []);
expectEqual("compacted blocks are skipped", candidateKeys(selectCandidates(assistants, new Set(["e1:0"]), windowConfig(2, 1), estimateText)), ["e2:0"]);
expectEqual("short blocks are skipped", candidateKeys(selectCandidates(assistants, new Set(), windowConfig(2, 200), estimateText)), []);
expectEqual(
	"candidates go from oldest to newest",
	candidateKeys(selectCandidates(assistants, new Set(), windowConfig(1, 1), estimateText)),
	["e1:0", "e2:0", "e2:2"],
);
expectEqual(
	"block text is trimmed",
	selectCandidates([{ entryId: "e", api: "anthropic-messages", content: [thinkingBlock(`  ${longReasoning}  `)] }], new Set(), windowConfig(0, 1), estimateText)[0].text,
	longReasoning,
);
expectEqual(
	"a redacted block in the raw zone does not shift selection",
	candidateKeys(selectCandidates([
		{ entryId: "e1", api: "anthropic-messages", content: [thinkingBlock(longReasoning)] },
		{ entryId: "e2", api: "anthropic-messages", content: [thinkingBlock(longReasoning, { redacted: true })] },
	], new Set(), windowConfig(1, 1), estimateText)),
	["e1:0"],
);
expectEqual(
	"openai-completions without a reasoning signature is not compacted",
	candidateKeys(selectCandidates([
		{ entryId: "e1", api: "openai-completions", content: [thinkingBlock(longReasoning, { thinkingSignature: "sig" })] },
		{ entryId: "e2", api: "openai-completions", content: [thinkingBlock(longReasoning, { thinkingSignature: "reasoning_content" })] },
	], new Set(), windowConfig(0, 1), estimateText)),
	["e2:0"],
);
expectEqual("empty history: no candidates", candidateKeys(selectCandidates([], new Set(), windowConfig(0, 1), estimateText)), []);
expectEqual(
	"k = 0 compacts every block",
	candidateKeys(selectCandidates(assistants, new Set(), windowConfig(0, 1), estimateText)),
	["e1:0", "e2:0", "e2:2", "e3:0"],
);

const signatureBlock = thinkingBlock("old text", { thinkingSignature: "reasoning_content", redacted: false });
const responseBlock = textBlock("answer");
const toolBlock = { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } };
const replaced = buildReplacement([signatureBlock, responseBlock, toolBlock], 0, "new text", true);
expectEqual("replacement changes only the target block", replaced[0].thinking, "new text");
expectEqual("a reasoning-field signature is kept", replaced[0].thinkingSignature, "reasoning_content");
expectEqual("answer text is untouched", replaced[1], responseBlock);
expectEqual("tool call is untouched", replaced[2], toolBlock);
expectEqual("a foreign signature is dropped", buildReplacement([thinkingBlock("old text", { thinkingSignature: "sig" })], 0, "new text", false)[0].thinkingSignature, undefined);
expectEqual("the signature is dropped and the text replaced", buildReplacement([thinkingBlock("old text", { thinkingSignature: "sig" })], 0, "new text", false)[0].thinking, "new text");
expectEqual("an out-of-range index changes nothing", buildReplacement([signatureBlock, responseBlock], 7, "new text", false), [signatureBlock, responseBlock]);

const shownWithOwnEdit = [thinkingBlock("digest", { thinkingSignature: "reasoning_content" }), thinkingBlock(longReasoning)];
expectEqual(
	"a replaced block shows as a difference from the projection",
	foreignChangedBlocks([signatureBlock, thinkingBlock(longReasoning)], shownWithOwnEdit),
	[0],
);
expectEqual(
	"matching blocks are not reported as changed",
	foreignChangedBlocks([signatureBlock, thinkingBlock(longReasoning)], [signatureBlock, thinkingBlock(longReasoning)]),
	[],
);
expectEqual("a missing visible block is a foreign edit", foreignChangedBlocks([thinkingBlock(longReasoning)], undefined), [0]);
expectEqual(
	"a visible block of another type is a foreign edit",
	foreignChangedBlocks([thinkingBlock(longReasoning)], [textBlock("x")]),
	[0],
);

const lengthVerdict = validateCompaction(attemptResult("length", [textBlock(longReasoning)]), 100, 0.95, estimateText);
expectEqual("a length cut-off is not accepted", lengthVerdict.ok, false);
expectEqual("a length cut-off is a terminal rejection", lengthVerdict.terminal, true);
expectEqual(
	"toolUse is a terminal rejection",
	validateCompaction(attemptResult("toolUse", [textBlock(longReasoning)]), 100, 0.95, estimateText).terminal,
	true,
);
const abortedVerdict = validateCompaction(attemptResult("aborted", []), 100, 0.95, estimateText);
expectEqual("an aborted request is not accepted", abortedVerdict.ok, false);
expectEqual("an aborted request is not terminal", abortedVerdict.terminal, false);
const errorVerdict = validateCompaction(attemptResult("error", []), 100, 0.95, estimateText);
expectEqual("a provider error is not terminal", errorVerdict.terminal, false);
expectEqual("an answer with a tool call is not accepted", validateCompaction(attemptResult("stop", [textBlock(longReasoning), toolBlock]), 100, 0.95, estimateText).terminal, true);
expectEqual("an empty answer is not accepted", validateCompaction(attemptResult("stop", [textBlock("  ")]), 100, 0.95, estimateText).ok, false);
expectEqual("a grown answer is not accepted", validateCompaction(attemptResult("stop", [textBlock(`<digest>${repeatChar("x", 400)}</digest>`)]), 100, 0.95, estimateText).ok, false);
expectEqual(
	"a shortened answer is accepted",
	validateCompaction(attemptResult("stop", [textBlock(`<digest>${repeatChar("x", 200)}</digest>`)]), 100, 0.95, estimateText),
	{ ok: true, text: repeatChar("x", 200), tokens: 50 },
);
expectEqual(
	"acceptance ratio zero rejects any text",
	validateCompaction(attemptResult("stop", [textBlock("short")]), 100, 0, estimateText).ok,
	false,
);
expectEqual(
	"the exact source size is accepted at ratio one",
	validateCompaction(attemptResult("stop", [textBlock(`<digest>${repeatChar("x", 400)}</digest>`)]), 100, 1, estimateText).tokens,
	100,
);
expectEqual("the digest is extracted from the wrapper", extractTagged("preamble <digest>\ndigest\n</digest> tail", "digest"), "digest");
expectEqual("everything outside the tags is ignored", extractTagged("junk <digest>digest</digest> junk", "digest"), "digest");
expectEqual("without tags there is no digest", extractTagged("plain text", "digest"), undefined);
expectEqual("a single tag does not count", extractTagged("<digest>digest", "digest"), undefined);
expectEqual("a closing tag before the opening one does not count", extractTagged("</digest><digest>digest", "digest"), undefined);
expectEqual(
	"digest text is joined and trimmed",
	validateCompaction(attemptResult("stop", [textBlock("  <digest> "), textBlock("first\nsecond"), textBlock(" </digest>  ")]), 1000, 0.95, estimateText).text,
	"first\nsecond",
);
expectEqual(
	"an answer without a wrapper is rejected",
	validateCompaction(attemptResult("stop", [textBlock(longReasoning)]), 100, 0.95, estimateText).ok,
	false,
);
expectEqual(
	"a missing wrapper is a terminal rejection",
	validateCompaction(attemptResult("stop", [textBlock("digest")]), 100, 0.95, estimateText).terminal,
	true,
);
expectEqual(
	"an empty wrapper is rejected",
	validateCompaction(attemptResult("stop", [textBlock("<digest>   </digest>")]), 100, 0.95, estimateText).ok,
	false,
);
expectEqual("plain text has no markup", findToolProtocolMarker("plain reasoning"), undefined);
expectTrue(
	"DSML markup is found",
	findToolProtocolMarker("output ｜｜DSML｜｜ calls>") !== undefined,
);
expectTrue("the markdown tool_calls tag is found", findToolProtocolMarker("<tool_calls>") !== undefined);
expectEqual(
	"markup inside the digest is rejected",
	validateCompaction(attemptResult("stop", [textBlock(`<digest>${longReasoning}\n<tool_calls></digest>`)]), 100, 0.95, estimateText).ok,
	false,
);
expectEqual(
	"markup outside the digest does not interfere",
	validateCompaction(attemptResult("stop", [textBlock("<tool_calls><digest>digest</digest>")]), 100, 0.95, estimateText).ok,
	true,
);
expectEqual(
	"a markup rejection is terminal",
	validateCompaction(attemptResult("stop", [textBlock("<digest><｜｜DSML｜｜ invoke></digest>")]), 100, 0.95, estimateText).terminal,
	true,
);

const reportText = repeatChar("r", 400);
const reportAssistants = [
	{ entryId: "r1", api: "anthropic-messages", content: [thinkingBlock("thought"), textBlock(reportText)] },
	{ entryId: "r2", api: "anthropic-messages", content: [textBlock("working on it"), { type: "toolCall" }] },
	{ entryId: "r3", api: "anthropic-messages", content: [textBlock(reportText)] },
];
const reportKeys = (reports) => reports.map((report) => report.entryId);
expectEqual("reports without tool calls are selected", reportKeys(selectReports(reportAssistants, new Set(), 1, estimateText)), ["r1", "r3"]);
expectEqual("short reports are left alone", selectReports(reportAssistants, new Set(), 1000, estimateText), []);
expectEqual("processed reports are skipped", reportKeys(selectReports(reportAssistants, new Set(["r1"]), 1, estimateText)), ["r3"]);
expectEqual(
	"report text joins the text blocks",
	selectReports([{ entryId: "r", api: "anthropic-messages", content: [textBlock(" first "), textBlock("second")] }], new Set(), 1, estimateText)[0].text,
	"first\nsecond",
);

const mixedWork = orderWork(
	[{ entryId: "m", role: "assistant" }],
	[{ entryId: "m", blockIndex: 0, text: longReasoning, tokens: 100 }],
	[{ entryId: "m", text: reportText, tokens: 100 }],
	[],
);
expectEqual("one queue keeps session order, a digest before the report of its message", mixedWork.map((item) => item.kind), ["digest", "report"]);
expectEqual(
	"the queue goes by message order",
	orderWork(
		reportAssistants.map((assistant) => ({ entryId: assistant.entryId, role: "assistant" })),
		[{ entryId: "r3", blockIndex: 0, text: "t", tokens: 1 }],
		[{ entryId: "r1", text: reportText, tokens: 100 }],
		[],
	).map((item) => (item.kind === "digest" ? item.candidate.entryId : item.report.entryId)),
	["r1", "r3"],
);
expectEqual(
	"a reply goes before the work of its turn",
	orderWork(
		[{ entryId: "u1", role: "user" }, { entryId: "m", role: "assistant" }],
		[{ entryId: "m", blockIndex: 0, text: "t", tokens: 1 }],
		[],
		[{ entryId: "u1", text: "hi", tokens: 1 }],
	).map((item) => item.kind),
	["reply", "digest"],
);

const replyMessages = [
	{ entryId: "u1", content: [textBlock("БЛЯДЬ ОБЪЯСНИ ПОДРОБНЕЕ")] },
	{ entryId: "u2", content: [thinkingBlock("hmm")] },
	{ entryId: "u3", content: [textBlock("ok")] },
];
const replyKeys = (list) => list.map((reply) => reply.entryId);
expectEqual("every text reply is selected, short ones too", replyKeys(selectReplies(replyMessages, new Set(), estimateText)), ["u1", "u3"]);
expectEqual("processed replies are skipped", replyKeys(selectReplies(replyMessages, new Set(["u1"]), estimateText)), ["u3"]);
expectEqual("a reply without text is skipped", replyKeys(selectReplies([{ entryId: "u", content: [thinkingBlock("hmm")] }], new Set(), estimateText)), []);

expectEqual(
	"the rewrite takes the place of the report text",
	buildTextReplacement([thinkingBlock("thought"), textBlock("raw report"), textBlock("tail")], "clear report"),
	[thinkingBlock("thought"), textBlock("clear report")],
);
expectEqual("a message without text keeps its blocks", buildTextReplacement([thinkingBlock("thought")], "clear report"), [thinkingBlock("thought")]);

const rawReply = "БЛЯДЬ ОБЪЯСНИ КОРОТКО";
const acceptedRewrite = validateRewrite(attemptResult("stop", [textBlock(`<rewrite>${repeatChar("x", 800)}</rewrite>`)]), rawReply, estimateText);
expectEqual("a long rewrite is accepted", acceptedRewrite.ok, true);
expectEqual(
	"a rewrite of any length is accepted as a replacement",
	validateRewrite(attemptResult("stop", [textBlock("<rewrite>short</rewrite>")]), rawReply, estimateText),
	{ ok: true, outcome: "replace", text: "short", tokens: 2 },
);
expectEqual(
	"an unchanged mark is accepted without a rewrite",
	validateRewrite(attemptResult("stop", [textBlock("<unchanged/>")]), rawReply, estimateText),
	{ ok: true, outcome: "unchanged" },
);
expectEqual(
	"an empty unchanged pair is the same mark",
	validateRewrite(attemptResult("stop", [textBlock("<unchanged></unchanged>")]), rawReply, estimateText),
	{ ok: true, outcome: "unchanged" },
);
expectEqual(
	"a rewrite equal to the source is not a replacement",
	validateRewrite(attemptResult("stop", [textBlock("<rewrite>  БЛЯДЬ   ОБЪЯСНИ КОРОТКО </rewrite>")]), rawReply, estimateText),
	{ ok: true, outcome: "unchanged" },
);
expectEqual(
	"both marks in one answer are rejected",
	validateRewrite(attemptResult("stop", [textBlock("<unchanged/><rewrite>short</rewrite>")]), rawReply, estimateText),
	{ ok: false, reason: "the answer carries both <unchanged/> and <rewrite>", terminal: true },
);
expectEqual(
	"an answer without a mark is rejected",
	validateRewrite(attemptResult("stop", [textBlock("plain answer")]), rawReply, estimateText),
	{ ok: false, reason: "no <unchanged/> or <rewrite>…</rewrite> in the answer", terminal: true },
);
expectEqual(
	"a malformed unchanged mark is rejected",
	validateRewrite(attemptResult("stop", [textBlock("<unchanged>something</unchanged>")]), rawReply, estimateText).ok,
	false,
);
expectEqual("an empty rewrite is rejected", validateRewrite(attemptResult("stop", [textBlock("<rewrite>   </rewrite>")]), rawReply, estimateText).ok, false);
expectEqual("tool markup in the rewrite is rejected", validateRewrite(attemptResult("stop", [textBlock("<rewrite><tool_calls></rewrite>")]), rawReply, estimateText).ok, false);
expectEqual("an aborted rewrite is not terminal", validateRewrite(attemptResult("aborted", []), rawReply, estimateText).terminal, false);

expectEqual("a foreign text edit is detected", foreignChangedText([textBlock("raw")], [textBlock("changed")]), true);
expectEqual("unchanged text is not foreign", foreignChangedText([textBlock("raw")], [textBlock("raw")]), false);
expectEqual("a message without text has no foreign text", foreignChangedText([thinkingBlock("thought")], [thinkingBlock("thought")]), false);

expectEqual("message text joins the text blocks", messageText([thinkingBlock("thought"), textBlock(" first "), textBlock("second")]), "first\nsecond");
expectEqual("normalization collapses whitespace", normalizeText(" a\n\n b "), "a b");
expectEqual(
	"the status shows both rewrite counters: reports and replies",
	formatStatusText({
		enabled: true,
		running: false,
		rawThinkingTokens: 100,
		contextThinkingTokens: 100,
		generatedTokens: 0,
		rewrittenReports: 3,
		rewrittenReplies: 2,
	}),
	"💭 0/100 +0 ✍ 3 😞 2",
);
expectEqual(
	"the reply counter carries the sadness mark",
	formatStatusText({
		enabled: true,
		running: false,
		rawThinkingTokens: 100,
		contextThinkingTokens: 100,
		generatedTokens: 0,
		rewrittenReports: 0,
		rewrittenReplies: 1,
	}),
	"💭 0/100 +0 😞 1",
);
expectEqual(
	"the report counter appears alone",
	formatStatusText({
		enabled: true,
		running: false,
		rawThinkingTokens: 100,
		contextThinkingTokens: 100,
		generatedTokens: 0,
		rewrittenReports: 3,
		rewrittenReplies: 0,
	}),
	"💭 0/100 +0 ✍ 3",
);
expectEqual(
	"without rewrites the counters are absent",
	formatStatusText({
		enabled: true,
		running: false,
		rawThinkingTokens: 100,
		contextThinkingTokens: 100,
		generatedTokens: 0,
		rewrittenReports: 0,
		rewrittenReplies: 0,
	}),
	"💭 0/100 +0",
);

expectEqual("below a thousand tokens are printed as is", formatTokens(999), "999");
expectEqual("thousands are rounded to whole", formatTokens(1500), "2k");
expectEqual("rounding down", formatTokens(13400), "13k");
expectEqual("rounding up", formatTokens(13500), "14k");
expectEqual("tens of thousands", formatTokens(150000), "150k");
expectEqual("zero tokens", formatTokens(0), "0");
expectEqual(
	"the disabled mode leaves no status",
	formatStatusText({ enabled: false, running: false, rawThinkingTokens: 0, contextThinkingTokens: 0, generatedTokens: 0, rewrittenReports: 0, rewrittenReplies: 0 }),
	undefined,
);
expectEqual(
	"the status shows savings, raw sum and generation",
	formatStatusText({
		enabled: true,
		running: false,
		rawThinkingTokens: 120000,
		contextThinkingTokens: 80000,
		generatedTokens: 76000,
		rewrittenReports: 0,
		rewrittenReplies: 0,
	}),
	"💭 -40k/120k +76k",
);
expectEqual(
	"a spinner frame takes the space while running",
	formatStatusText(
		{ enabled: true, running: true, rawThinkingTokens: 120000, contextThinkingTokens: 80000, generatedTokens: 76000, rewrittenReports: 0, rewrittenReplies: 0 },
		"⠹",
	),
	"💭⠹-40k/120k +76k",
);
expectEqual(
	"without compaction savings are zero",
	formatStatusText({ enabled: true, running: false, rawThinkingTokens: 5000, contextThinkingTokens: 5000, generatedTokens: 0, rewrittenReports: 0, rewrittenReplies: 0 }),
	"💭 0/5k +0",
);
expectEqual(
	"empty context",
	formatStatusText({ enabled: true, running: false, rawThinkingTokens: 0, contextThinkingTokens: 0, generatedTokens: 0, rewrittenReports: 0, rewrittenReplies: 0 }),
	"💭 0/0 +0",
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
