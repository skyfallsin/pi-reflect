/**
 * Reflect core logic — all pure/testable functions.
 * The extension entry point (index.ts) wires these into the pi extension API.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// --- Paths ---

const HOME = process.env.HOME ?? "~";
const CONFIG_DIR = path.join(HOME, ".pi", "agent");
const CONFIG_FILE = path.join(CONFIG_DIR, "reflect.json");
const SESSIONS_DIR = path.join(HOME, ".pi", "agent", "sessions");
const DEFAULT_BACKUP_DIR = path.join(CONFIG_DIR, "reflect-backups");
const HISTORY_FILE = path.join(CONFIG_DIR, "reflect-history.json");

// --- Types ---

export interface TranscriptSource {
	type: "pi-sessions" | "command";
	/** Shell command that outputs transcript text to stdout. `{lookbackDays}` is interpolated. */
	command?: string;
}

export interface ContextSource {
	type: "files" | "command" | "url";
	/** Label shown in the context block (e.g. "daily logs", "recent conversations") */
	label?: string;
	/** For "files": glob patterns or file paths. */
	paths?: string[];
	/** For "command": shell command. `{lookbackDays}` is interpolated. */
	command?: string;
	/** For "url": HTTP GET endpoint. `{lookbackDays}` is interpolated. */
	url?: string;
	/** Max bytes to read from this source (default: 100KB) */
	maxBytes?: number;
}

export interface ReflectTarget {
	path: string;
	schedule: "daily" | "manual";
	model: string;
	lookbackDays: number;
	maxSessionBytes: number;
	backupDir: string;
	/** Transcript sources. Can be a single TranscriptSource (legacy) or array of ContextSource[].
	 *  Multiple sources are concatenated with --- separators. */
	transcriptSource?: TranscriptSource;
	transcripts?: ContextSource[];
	/** Custom prompt template. Use {fileName}, {targetContent}, {transcripts}, {context} as placeholders.
	 *  If omitted, uses the default correction-pattern prompt. */
	prompt?: string;
	/** Additional context sources to read and inject. Available via {context} placeholder in prompts.
	 *  Each source has a type: "files" (glob/paths), "command" (shell, stdout), or "url" (HTTP GET). */
	context?: ContextSource[];
}

export interface ReflectConfig {
	targets: ReflectTarget[];
}

export interface EditRecord {
	type: "strengthen" | "add" | "remove" | "merge";
	section: string;
	reason: string;
}

export interface ReflectRun {
	timestamp: string;
	targetPath: string;
	sessionsAnalyzed: number;
	correctionsFound: number;
	editsApplied: number;
	summary: string;
	diffLines: number;
	correctionRate: number;
	edits?: EditRecord[];
	sourceDate?: string;
	date?: string; // legacy field from bash-script/batch runs
	/** File size metrics after this run */
	fileSize?: { chars: number; words: number; lines: number; estTokens: number };
}

export interface SessionExchange {
	role: "user" | "assistant";
	text: string | null;
	thinking: string | null;
}

export interface SessionData {
	userCount: number;
	exchangeCount: number;
	transcript: string;
	size: number;
	project: string;
	time: string;
}

export interface TranscriptResult {
	transcripts: string;
	sessionCount: number;
	includedCount: number;
	/** Individual sessions for chunked processing when transcripts exceed context budget */
	sessions?: SessionData[];
}

export interface EditResult {
	result: string;
	applied: number;
	skipped: string[];
}

export interface AnalysisEdit {
	type: "strengthen" | "add" | "remove" | "merge";
	section?: string;
	old_text?: string | null;
	new_text: string;
	after_text?: string | null;
	/** For "merge": array of exact text strings to remove (they're consolidated into new_text) */
	merge_sources?: string[];
	reason?: string;
}

export interface ReflectionOptions {
	sourceDateOverride?: string;
	transcriptsOverride?: TranscriptResult;
	dryRun?: boolean;
	/** Override model — use the current session model instead of target.model */
	currentModel?: any;
	currentModelApiKey?: string;
	currentModelHeaders?: Record<string, string>;
}

export type NotifyFn = (msg: string, level: "info" | "warning" | "error") => void;

// --- Defaults ---

export const DEFAULT_TARGET: ReflectTarget = {
	path: "",
	schedule: "daily",
	model: "anthropic/claude-sonnet-4-5",
	lookbackDays: 1,
	maxSessionBytes: 600 * 1024,
	backupDir: DEFAULT_BACKUP_DIR,
	transcriptSource: { type: "pi-sessions" },
};

export const MAX_ASSISTANT_MSG_CHARS = 2000;
export const MAX_THINKING_MSG_CHARS = 1500;

// --- File size metrics ---

export function computeFileMetrics(content: string): { chars: number; words: number; lines: number; estTokens: number } {
	const chars = content.length;
	const words = content.split(/\s+/).filter(Boolean).length;
	const lines = content.split("\n").length;
	// Rough estimate: ~4 chars per token for English/code mix
	const estTokens = Math.round(chars / 4);
	return { chars, words, lines, estTokens };
}

// --- Config ---

export function loadConfig(): ReflectConfig {
	try {
		const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
		const parsed = JSON.parse(raw);
		return {
			targets: (parsed.targets ?? []).map((t: any) => ({
				...DEFAULT_TARGET,
				...t,
			})),
		};
	} catch {
		return { targets: [] };
	}
}

export function saveConfig(config: ReflectConfig): void {
	fs.mkdirSync(CONFIG_DIR, { recursive: true });
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

export function loadHistory(): ReflectRun[] {
	try {
		return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
	} catch {
		return [];
	}
}

export function saveHistory(runs: ReflectRun[]): void {
	const trimmed = runs.slice(-100);
	fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2), "utf-8");
}

// --- Helpers ---

export function resolvePath(p: string): string {
	if (p.startsWith("~")) {
		return path.join(HOME, p.slice(1));
	}
	return path.resolve(p);
}

export function formatTimestamp(): string {
	return new Date().toISOString().replace("T", "_").replace(/[:.]/g, "").slice(0, 15);
}

export function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function truncateText(text: string | null, limit: number): string | null {
	if (!text) return text;
	if (text.length > limit) {
		return text.slice(0, limit) + `\n[...truncated, ${text.length - limit} chars omitted]`;
	}
	return text;
}

// --- Session extraction ---

export function projectNameFromDir(dirname: string): string {
	let name = dirname;
	const user = process.env.USER ?? "user";
	const homePrefix = `--Users-${user}-`;
	if (name.startsWith(homePrefix)) {
		name = name.slice(homePrefix.length);
	}
	const linuxPrefix = `--home-${user}-`;
	if (name.startsWith(linuxPrefix)) {
		name = name.slice(linuxPrefix.length);
	}
	name = name.replace(/--/g, "/").replace(/^[-/]+|[-/]+$/g, "");
	return name || "workspace";
}

export async function extractTranscript(filepath: string): Promise<SessionExchange[]> {
	const exchanges: SessionExchange[] = [];
	try {
		const rl = createInterface({ input: createReadStream(filepath), crlfDelay: Infinity });
		for await (const line of rl) {
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}

			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (!msg) continue;
			const role = msg.role;
			if (role !== "user" && role !== "assistant") continue;

			const content = msg.content;
			if (!Array.isArray(content)) continue;

			const textParts: string[] = [];
			const thinkingParts: string[] = [];

			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				if (part.type === "text" && part.text?.trim()) {
					textParts.push(part.text.trim());
				} else if (part.type === "thinking" && part.thinking?.trim()) {
					thinkingParts.push(part.thinking.trim());
				}
			}

			if (textParts.length === 0 && thinkingParts.length === 0) continue;

			exchanges.push({
				role,
				text: textParts.length > 0 ? textParts.join("\n") : null,
				thinking: thinkingParts.length > 0 ? thinkingParts.join("\n") : null,
			});
		}
	} catch {
		// Skip unreadable files
	}
	return exchanges;
}

export function formatSessionTranscript(exchanges: SessionExchange[], sessionId: string, project: string): string {
	const lines: string[] = [];
	lines.push(`### Session: ${project} [${sessionId}]`);
	lines.push("");

	for (const ex of exchanges) {
		if (ex.role === "user") {
			lines.push(`**USER:** ${ex.text}`);
			lines.push("");
		} else if (ex.role === "assistant") {
			if (ex.thinking) {
				lines.push(`**THINKING:** ${truncateText(ex.thinking, MAX_THINKING_MSG_CHARS)}`);
				lines.push("");
			}
			if (ex.text) {
				lines.push(`**AGENT:** ${truncateText(ex.text, MAX_ASSISTANT_MSG_CHARS)}`);
				lines.push("");
			}
		}
	}

	return lines.join("\n");
}

// --- Shared session scanning logic ---

function scanSessionFiles(
	effectiveSessionsDir: string,
	targetDates: string[],
	maxBytes: number,
): { allSessions: SessionData[]; totalScanned: number } {
	// Include "next day" for UTC/local timezone overlap
	const nextDates = targetDates.map((d) => {
		const next = new Date(d + "T00:00:00Z");
		next.setDate(next.getDate() + 1);
		return next.toISOString().slice(0, 10);
	});
	const allDates = new Set([...targetDates, ...nextDates]);

	const sessionDirs: string[] = [];
	try {
		for (const dir of fs.readdirSync(effectiveSessionsDir)) {
			if (dir.includes("var-folders")) continue;
			const fullDir = path.join(effectiveSessionsDir, dir);
			if (fs.statSync(fullDir).isDirectory()) {
				sessionDirs.push(fullDir);
			}
		}
	} catch {
		return { allSessions: [], totalScanned: 0 };
	}

	return { allSessions: [], totalScanned: 0, _sessionDirs: sessionDirs, _allDates: allDates, _targetDates: new Set(targetDates) } as any;
}

async function collectSessionsForDates(
	targetDates: string[],
	maxBytes: number,
	sessionsDir?: string,
): Promise<TranscriptResult> {
	const effectiveSessionsDir = sessionsDir ?? SESSIONS_DIR;

	const nextDates = targetDates.map((d) => {
		const next = new Date(d + "T00:00:00Z");
		next.setDate(next.getDate() + 1);
		return next.toISOString().slice(0, 10);
	});
	const allDates = new Set([...targetDates, ...nextDates]);
	const targetDateSet = new Set(targetDates);

	const sessionDirs: string[] = [];
	try {
		for (const dir of fs.readdirSync(effectiveSessionsDir)) {
			if (dir.includes("var-folders")) continue;
			const fullDir = path.join(effectiveSessionsDir, dir);
			if (fs.statSync(fullDir).isDirectory()) {
				sessionDirs.push(fullDir);
			}
		}
	} catch {
		return { transcripts: "", sessionCount: 0, includedCount: 0 };
	}

	const allSessions: SessionData[] = [];
	let totalScanned = 0;

	for (const dir of sessionDirs) {
		const project = projectNameFromDir(path.basename(dir));
		let files: string[];
		try {
			files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
		} catch {
			continue;
		}

		for (const file of files) {
			const fileDate = file.slice(0, 10);
			if (!allDates.has(fileDate)) continue;

			if (!targetDateSet.has(fileDate)) {
				try {
					const hour = parseInt(file.slice(11, 13));
					if (hour >= 8) continue;
				} catch {
					continue;
				}
			}

			totalScanned++;
			const filepath = path.join(dir, file);
			const exchanges = await extractTranscript(filepath);
			const userCount = exchanges.filter((e) => e.role === "user").length;

			if (userCount < 1 || exchanges.length < 3) continue;

			const sessionTime = file.slice(0, 19).replace("T", " ");
			const transcript = formatSessionTranscript(exchanges, sessionTime, project);

			allSessions.push({
				userCount,
				exchangeCount: exchanges.length,
				transcript,
				size: transcript.length,
				project,
				time: sessionTime,
			});
		}
	}

	if (allSessions.length === 0) {
		return { transcripts: "", sessionCount: totalScanned, includedCount: 0, sessions: [] };
	}

	allSessions.sort((a, b) => {
		const densityA = a.userCount / Math.max(a.exchangeCount, 1);
		const densityB = b.userCount / Math.max(b.exchangeCount, 1);
		if (densityB !== densityA) return densityB - densityA;
		return b.userCount - a.userCount;
	});

	const parts: string[] = [];
	let currentSize = 0;
	let included = 0;

	for (const sd of allSessions) {
		const entry = sd.transcript + "\n---\n\n";
		if (currentSize + entry.length > maxBytes) continue;
		parts.push(entry);
		currentSize += entry.length;
		included++;
	}

	const header =
		`# Session Transcripts\n` +
		`# Sessions scanned: ${totalScanned}, ${allSessions.length} with substantive conversation, ${included} included\n` +
		`# Total user messages: ${allSessions.reduce((s, sd) => s + sd.userCount, 0)}\n\n`;

	return {
		transcripts: header + parts.join(""),
		sessionCount: totalScanned,
		includedCount: included,
		sessions: allSessions,
	};
}

export async function collectTranscripts(lookbackDays: number, maxBytes: number, sessionsDir?: string): Promise<TranscriptResult> {
	const targetDates: string[] = [];
	for (let i = 1; i <= lookbackDays; i++) {
		const d = new Date();
		d.setDate(d.getDate() - i);
		targetDates.push(d.toISOString().slice(0, 10));
	}
	return collectSessionsForDates(targetDates, maxBytes, sessionsDir);
}

export async function collectTranscriptsForDate(targetDate: string, maxBytes: number, sessionsDir?: string): Promise<TranscriptResult> {
	return collectSessionsForDates([targetDate], maxBytes, sessionsDir);
}

export async function collectTranscriptsFromCommand(command: string, lookbackDays: number, maxBytes: number): Promise<TranscriptResult> {
	const { execSync } = await import("node:child_process");
	const interpolated = command.replace(/\{lookbackDays\}/g, String(lookbackDays));

	try {
		let output = execSync(interpolated, {
			encoding: "utf-8",
			timeout: 60_000,
			maxBuffer: maxBytes * 2,
		});

		if (output.length > maxBytes) {
			output = output.slice(0, maxBytes) + "\n\n[...truncated to fit context budget]";
		}

		const sessionMatches = output.match(/^### Session:/gm);
		const count = sessionMatches?.length ?? 1;

		return { transcripts: output, sessionCount: count, includedCount: count };
	} catch {
		return { transcripts: "", sessionCount: 0, includedCount: 0 };
	}
}

// --- Context collection ---

/** Compute the cutoff date string (YYYY-MM-DD) for lookbackDays ago */
function lookbackCutoff(lookbackDays: number): string {
	const d = new Date();
	d.setDate(d.getDate() - lookbackDays);
	return d.toISOString().slice(0, 10);
}

/** Check if a filename contains a date and whether it's within the lookback window */
function isWithinLookback(filename: string, cutoff: string): boolean {
	const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
	if (!match) return true; // no date in filename → include it
	return match[1] >= cutoff;
}

function findGlobBaseDir(globPattern: string): string {
	const normalized = path.normalize(globPattern);
	const segments = normalized.split(path.sep);
	const globIndex = segments.findIndex((segment) => segment.includes("*"));

	if (globIndex === -1) return path.dirname(normalized);

	const baseSegments = segments.slice(0, globIndex).filter(Boolean);
	if (normalized.startsWith(path.sep)) {
		return baseSegments.length > 0 ? path.join(path.sep, ...baseSegments) : path.sep;
	}
	return baseSegments.length > 0 ? path.join(...baseSegments) : ".";
}

function globToRegex(globPattern: string): RegExp {
	const normalized = globPattern.split(path.sep).join("/");
	const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const globstarToken = "__PI_REFLECT_GLOBSTAR__";
	const withGlobstarToken = escaped.replace(/\*\*\/?/g, globstarToken);
	const withWildcards = withGlobstarToken.replace(/\*/g, "[^/]*");
	const withGlobstar = withWildcards.replaceAll(globstarToken, "(?:.*/)?");
	return new RegExp(`^${withGlobstar}$`);
}

function walkFilesRecursive(dir: string): string[] {
	const files: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				files.push(...walkFilesRecursive(fullPath));
			} else if (entry.isFile()) {
				files.push(fullPath);
			}
		}
	} catch {}

	return files;
}

function findMatchingFiles(globPattern: string): { name: string; full: string }[] {
	const baseDir = findGlobBaseDir(globPattern);
	if (!fs.existsSync(baseDir)) return [];

	const relativePattern = path.relative(baseDir, globPattern);
	const relativeRegex = globToRegex(relativePattern);
	const basenameRegex = !relativePattern.includes(path.sep) ? globToRegex(path.basename(globPattern)) : null;

	return walkFilesRecursive(baseDir)
		.filter((fullPath) => {
			const relativePath = path.relative(baseDir, fullPath).split(path.sep).join("/");
			const baseName = path.basename(fullPath);
			return relativeRegex.test(relativePath) || (basenameRegex?.test(baseName) ?? false);
		})
		.map((fullPath) => ({
			name: path.relative(baseDir, fullPath).split(path.sep).join("/"),
			full: fullPath,
		}));
}

export async function collectContext(sources: ContextSource[], lookbackDays: number): Promise<string> {
	const parts: string[] = [];
	const cutoff = lookbackCutoff(lookbackDays);

	for (const source of sources) {
		const maxBytes = source.maxBytes ?? 100 * 1024;
		const label = source.label ?? source.type;
		let content = "";
		let totalBytes = 0;

		try {
			if (source.type === "files" && source.paths) {
				const fileParts: string[] = [];
				for (const pattern of source.paths) {
					const expanded = pattern.replace(/\{lookbackDays\}/g, String(lookbackDays));
					let candidates: { name: string; full: string }[] = [];

					if (expanded.includes("*")) {
						candidates = findMatchingFiles(expanded);
					} else if (fs.existsSync(expanded)) {
						candidates = [{ name: path.basename(expanded), full: expanded }];
					}

					// Prune by date, sort newest first
					candidates = candidates
						.filter(c => isWithinLookback(c.name, cutoff))
						.sort((a, b) => b.name.localeCompare(a.name));

					for (const c of candidates) {
						try {
							if (!fs.statSync(c.full).isFile()) continue;
							const fileContent = fs.readFileSync(c.full, "utf-8");
							if (totalBytes + fileContent.length > maxBytes) break;
							fileParts.push(`### ${c.name}\n${fileContent}`);
							totalBytes += fileContent.length;
						} catch {}
					}
				}
				content = fileParts.join("\n\n");
			} else if (source.type === "command" && source.command) {
				const { execSync } = await import("node:child_process");
				const interpolated = source.command.replace(/\{lookbackDays\}/g, String(lookbackDays));
				content = execSync(interpolated, {
					encoding: "utf-8",
					timeout: 30_000,
					maxBuffer: maxBytes * 2,
				});
			} else if (source.type === "url" && source.url) {
				const interpolated = source.url.replace(/\{lookbackDays\}/g, String(lookbackDays));
				const response = await fetch(interpolated, { signal: AbortSignal.timeout(15_000) });
				if (response.ok) {
					content = await response.text();
				}
			}
		} catch {}

		if (content) {
			if (content.length > maxBytes) {
				content = content.slice(0, maxBytes) + "\n\n[...truncated to fit context budget]";
			}
			parts.push(`## ${label}\n${content}`);
		}
	}

	return parts.join("\n\n---\n\n");
}

// --- Scan available session dates ---

export function getAvailableSessionDates(): string[] {
	const dates = new Set<string>();
	try {
		for (const dir of fs.readdirSync(SESSIONS_DIR)) {
			if (dir.includes("var-folders")) continue;
			const fullDir = path.join(SESSIONS_DIR, dir);
			if (!fs.statSync(fullDir).isDirectory()) continue;
			for (const file of fs.readdirSync(fullDir)) {
				if (!file.endsWith(".jsonl")) continue;
				const fileDate = file.slice(0, 10);
				if (/^\d{4}-\d{2}-\d{2}$/.test(fileDate)) {
					dates.add(fileDate);
				}
			}
		}
	} catch {}
	return [...dates].sort();
}

// --- LLM prompt ---

export function buildReflectionPrompt(targetPath: string, targetContent: string, transcripts: string): string {
	const fileName = path.basename(targetPath);
	const charCount = targetContent.length;
	const lineCount = targetContent.split("\n").length;
	return `You are reviewing recent agent session transcripts to improve ${fileName}.

## CRITICAL: Conciseness

The target file is ${lineCount} lines / ${charCount} chars. Your #1 job is to keep it CONCISE.
- Every rule should be 1-2 sentences max. If a rule is longer, condense it.
- Remove session counts, escalating repetition tallies, and "this happened N times" histories — the rule itself is what matters, not how many times it was violated.
- Remove verbose examples when the rule is self-explanatory.
- Merge rules that say the same thing in different words.
- Remove rules that are subsumed by other, better-worded rules.
- A good rule file is SHORT and scannable. Walls of text get ignored by agents.

## Input

### Target file: ${fileName}
<target_file>
${targetContent}
</target_file>

### Session transcripts
<transcripts>
${transcripts}
</transcripts>

## Step 1: Identify Correction Patterns

Read the transcripts for genuine corrections — user redirecting the agent, expressing frustration, repeating themselves, or correcting approach. Ignore normal flow ("no worries", "actually that looks good").

For each correction: what the agent did wrong, what the user wanted, and which rule (if any) already covers it.

## Step 2: Propose Edits (prioritize conciseness)

Four edit types available:
1. **strengthen**: Tighten an existing rule's wording (make it clearer/shorter, not longer).
2. **add**: Add a new rule for a pattern with 2+ occurrences. Keep it to 1-2 sentences.
3. **remove**: Delete a rule that is redundant (covered by another rule), obsolete, or overly verbose noise.
4. **merge**: Consolidate 2+ rules that overlap into one concise rule.

Guidelines:
- Prefer strengthen/merge/remove over add. The file should get SHORTER or stay the same size, not grow.
- When strengthening, make the rule SHORTER and CLEARER — don't add history or examples unless essential.
- Strip "This happened in N sessions", "RECURRING", session dates, escalating violation counts. The rule text is enough.
- Don't reorganize or restructure the file. Minimal, targeted edits only.
- Don't add one-off rules. Only patterns with 2+ occurrences.

## Step 3: Output

IMPORTANT: Your ENTIRE response must be a single JSON object. No markdown, no preamble.

For "strengthen": old_text = COMPLETE bullet/rule copied exactly. new_text = shorter/clearer replacement.
For "add": after_text = COMPLETE bullet/line copied exactly. new_text = concise new bullet (1-2 sentences).
For "remove": old_text = COMPLETE bullet/rule to delete. new_text = "" (empty string).
For "merge": merge_sources = array of COMPLETE bullets to consolidate. new_text = single concise replacement. The merged text replaces the first source; others are removed.

{
  "corrections_found": <number>,
  "sessions_with_corrections": <number>,
  "edits": [
    {
      "type": "strengthen" | "add" | "remove" | "merge",
      "section": "which section of the file",
      "old_text": "exact text to find (strengthen/remove) or null (add/merge)",
      "new_text": "replacement/new text, or empty string for remove",
      "after_text": "insertion point (add only) or null",
      "merge_sources": ["exact text 1", "exact text 2"] or null (merge only),
      "reason": "brief reason for this edit"
    }
  ],
  "patterns_not_added": [
    { "pattern": "description", "reason": "why not added" }
  ],
  "summary": "2-3 sentence summary"
}`;
}

/** Build the prompt for a target. If target has a custom prompt, interpolate it. Otherwise use default. */
export function buildPromptForTarget(target: ReflectTarget, targetPath: string, targetContent: string, transcripts: string, context?: string): string {
	if (!target.prompt) {
		return buildReflectionPrompt(targetPath, targetContent, transcripts);
	}
	const fileName = path.basename(targetPath);
	return target.prompt
		.replace(/\{fileName\}/g, fileName)
		.replace(/\{targetContent\}/g, targetContent)
		.replace(/\{transcripts\}/g, transcripts)
		.replace(/\{context\}/g, context ?? "");
}

// --- Edit application ---

export function applyEdits(content: string, edits: AnalysisEdit[]): EditResult {
	let result = content;
	let applied = 0;
	const skipped: string[] = [];

	for (const edit of edits) {
		if (edit.type === "strengthen" && edit.old_text && edit.new_text) {
			if (!result.includes(edit.old_text)) {
				skipped.push(`Could not find text to strengthen: "${edit.old_text.slice(0, 80)}..."`);
				continue;
			}

			const firstIdx = result.indexOf(edit.old_text);
			const secondIdx = result.indexOf(edit.old_text, firstIdx + 1);
			if (secondIdx !== -1) {
				skipped.push(`Ambiguous match (appears multiple times): "${edit.old_text.slice(0, 80)}..."`);
				continue;
			}

			if (edit.old_text.length > 50) {
				const checkSnippet = edit.old_text.slice(0, 50);
				const occurrences = (edit.new_text.match(new RegExp(escapeRegex(checkSnippet), "g")) || []).length;
				if (occurrences > 1) {
					skipped.push(`Duplication detected in replacement text: "${edit.old_text.slice(0, 80)}..."`);
					continue;
				}
			}

			result = result.replace(edit.old_text, edit.new_text);
			applied++;
		} else if (edit.type === "add" && edit.new_text && edit.after_text) {
			if (!result.includes(edit.after_text)) {
				skipped.push(`Could not find insertion point: "${edit.after_text.slice(0, 80)}..."`);
				continue;
			}

			const firstIdx = result.indexOf(edit.after_text);
			const secondIdx = result.indexOf(edit.after_text, firstIdx + 1);
			if (secondIdx !== -1) {
				skipped.push(`Ambiguous insertion point (appears multiple times): "${edit.after_text.slice(0, 80)}..."`);
				continue;
			}

			if (result.includes(edit.new_text.trim())) {
				skipped.push(`Text already exists in file: "${edit.new_text.trim().slice(0, 80)}..."`);
				continue;
			}

			result = result.replace(edit.after_text, edit.after_text + "\n" + edit.new_text);
			applied++;
		} else if (edit.type === "remove" && edit.old_text) {
			if (!result.includes(edit.old_text)) {
				skipped.push(`Could not find text to remove: "${edit.old_text.slice(0, 80)}..."`);
				continue;
			}

			const firstIdx = result.indexOf(edit.old_text);
			const secondIdx = result.indexOf(edit.old_text, firstIdx + 1);
			if (secondIdx !== -1) {
				skipped.push(`Ambiguous match for removal (appears multiple times): "${edit.old_text.slice(0, 80)}..."`);
				continue;
			}

			// Remove the text and any trailing blank line
			result = result.replace(edit.old_text + "\n", "");
			if (result.includes(edit.old_text)) {
				result = result.replace(edit.old_text, "");
			}
			applied++;
		} else if (edit.type === "merge" && edit.merge_sources && edit.merge_sources.length > 0 && edit.new_text) {
			// Remove all source texts, then insert the consolidated new_text where the first source was
			let firstSourceIdx = Infinity;
			let firstSourceText = "";
			let allFound = true;

			for (const src of edit.merge_sources) {
				if (!result.includes(src)) {
					skipped.push(`Merge source not found: "${src.slice(0, 80)}..."`);
					allFound = false;
					break;
				}
				const idx = result.indexOf(src);
				if (idx < firstSourceIdx) {
					firstSourceIdx = idx;
					firstSourceText = src;
				}
			}
			if (!allFound) continue;

			// Replace the first source with the merged text
			result = result.replace(firstSourceText, edit.new_text);
			// Remove the remaining sources
			for (const src of edit.merge_sources) {
				if (src === firstSourceText) continue;
				result = result.replace(src + "\n", "");
				if (result.includes(src)) {
					result = result.replace(src, "");
				}
			}
			applied++;
		} else {
			skipped.push(`Invalid edit: ${JSON.stringify(edit).slice(0, 100)}`);
		}
	}

	return { result, applied, skipped };
}

// --- Batch helpers ---

/** Split sessions into batches that each fit within maxBytes */
export function buildTranscriptBatches(sessions: SessionData[], maxBytes: number): string[][] {
	const batches: string[][] = [];
	let currentBatch: string[] = [];
	let currentSize = 0;

	for (const sd of sessions) {
		const entry = sd.transcript + "\n---\n\n";
		if (currentSize + entry.length > maxBytes && currentBatch.length > 0) {
			batches.push(currentBatch);
			currentBatch = [];
			currentSize = 0;
		}
		currentBatch.push(entry);
		currentSize += entry.length;
	}
	if (currentBatch.length > 0) {
		batches.push(currentBatch);
	}
	return batches;
}

function formatBatchTranscripts(parts: string[], batchIndex: number, totalBatches: number, totalSessions: number): string {
	const header =
		`# Session Transcripts (batch ${batchIndex + 1}/${totalBatches})\n` +
		`# ${parts.length} sessions in this batch, ${totalSessions} total\n\n`;
	return header + parts.join("");
}

interface AnalysisResult {
	edits: AnalysisEdit[];
	correctionsFound: number;
	sessionsWithCorrections: number;
	summary: string;
	patternsNotAdded?: any[];
}

/** Run a single LLM analysis call on one batch of transcripts */
async function analyzeTranscriptBatch(
	target: ReflectTarget,
	targetPath: string,
	targetContent: string,
	transcripts: string,
	context: string,
	model: any,
	apiKey: string,
	headers: Record<string, string> | undefined,
	modelLabel: string,
	notify: NotifyFn,
	completeFn: (model: any, request: any, options: any) => Promise<any>,
): Promise<AnalysisResult | null> {
	const prompt = buildPromptForTarget(target, targetPath, targetContent, transcripts, context);

	const reflectAnalysisTool = {
		name: "submit_analysis",
		description: "Submit the reflection analysis results",
		parameters: {
			type: "object" as const,
			properties: {
				corrections_found: { type: "number", description: "Number of facts/rules added, updated, or removed" },
				sessions_with_corrections: { type: "number", description: "Number of conversations containing new facts or corrections" },
				edits: {
					type: "array",
					items: {
						type: "object",
						properties: {
							type: { type: "string", enum: ["strengthen", "add", "remove", "merge"], description: "strengthen = update existing text, add = insert new text, remove = delete redundant text, merge = consolidate multiple rules into one" },
							section: { type: "string", description: "Which section of the file" },
							old_text: { type: ["string", "null"], description: "Exact text to find (for strengthen) or null (for add)" },
							new_text: { type: "string", description: "Replacement text (for strengthen) or new text to insert (for add)" },
							after_text: { type: ["string", "null"], description: "Text after which to insert (for add) or null" },
							merge_sources: { type: ["array", "null"], items: { type: "string" }, description: "For merge: array of exact text strings to consolidate" },
							reason: { type: "string", description: "Brief reason for this edit" },
						},
						required: ["type", "new_text"],
					},
				},
				patterns_not_added: {
					type: "array",
					items: {
						type: "object",
						properties: {
							pattern: { type: "string" },
							reason: { type: "string" },
						},
					},
				},
				summary: { type: "string", description: "2-3 sentence summary of what was added/updated" },
			},
			required: ["corrections_found", "sessions_with_corrections", "edits", "summary"],
		},
	};

	const response = await completeFn(model, {
		systemPrompt: "You are a behavioral analysis tool that prioritizes CONCISENESS. Your goal is to keep the target file short and scannable — prefer merging, removing, and tightening rules over adding new ones. The file should get shorter or stay the same size, not grow. Analyze the session transcripts and call the submit_analysis tool with your results. Always call the tool — never respond with plain text.",
		messages: [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: prompt }],
				timestamp: Date.now(),
			},
		],
		tools: [reflectAnalysisTool],
	}, { apiKey, headers, maxTokens: 16384 });

	if (response.stopReason === "error") {
		notify(`LLM error: ${response.errorMessage ?? 'unknown'}`, "error");
		return null;
	}

	let analysis: any;
	const toolCall = response.content.find((c: any) => c.type === "toolCall" && c.name === "submit_analysis");
	if (toolCall && (toolCall as any).arguments) {
		analysis = (toolCall as any).arguments;
	} else {
		const responseText = response.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("")
			.trim();
		try {
			const jsonStr = responseText.replace(/^```json?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
			analysis = JSON.parse(jsonStr);
		} catch {
			notify(`Failed to parse LLM response as JSON. Raw response:\n${responseText.slice(0, 500)}`, "error");
			return null;
		}
	}

	return {
		edits: analysis.edits ?? [],
		correctionsFound: analysis.corrections_found ?? 0,
		sessionsWithCorrections: analysis.sessions_with_corrections ?? 0,
		summary: analysis.summary ?? "",
		patternsNotAdded: analysis.patterns_not_added,
	};
}

// --- Main reflection logic ---

export interface RunReflectionDeps {
	completeSimple: (model: any, request: any, options: any) => Promise<any>;
	getModel: (provider: string, modelId: string) => any;
	collectTranscriptsFn?: (lookbackDays: number, maxBytes: number) => Promise<TranscriptResult>;
	collectTranscriptsFromCommandFn?: (command: string, lookbackDays: number, maxBytes: number) => Promise<TranscriptResult>;
}

export async function runReflection(
	target: ReflectTarget,
	modelRegistry: any,
	notify: NotifyFn,
	deps?: RunReflectionDeps,
	options?: ReflectionOptions,
): Promise<ReflectRun | null> {
	const targetPath = resolvePath(target.path);

	if (!fs.existsSync(targetPath)) {
		notify(`Target file not found: ${targetPath}`, "error");
		return null;
	}

	const targetContent = fs.readFileSync(targetPath, "utf-8");
	if (targetContent.length < 100) {
		notify(`Target file too small (${targetContent.length} bytes): ${targetPath}`, "error");
		return null;
	}

	// Collect transcripts — supports new `transcripts` array (ContextSource[]) or legacy `transcriptSource`
	let transcripts: string;
	let sessionCount = 0;
	let includedCount = 0;
	let allSessions: SessionData[] | undefined;

	if (options?.transcriptsOverride) {
		({ transcripts, sessionCount, includedCount } = options.transcriptsOverride);
		allSessions = options.transcriptsOverride.sessions;
	} else if (target.transcripts && target.transcripts.length > 0) {
		// New array-based transcript sources
		notify(`Extracting transcripts from ${target.transcripts.length} source(s) (last ${target.lookbackDays} day(s))...`, "info");
		transcripts = await collectContext(target.transcripts, target.lookbackDays);
		// Estimate session count from section headers
		const headerMatches = transcripts.match(/^###\s/gm);
		sessionCount = headerMatches?.length ?? 1;
		includedCount = sessionCount;
	} else if (target.transcriptSource?.type === "command" && target.transcriptSource.command) {
		notify(`Extracting transcripts (last ${target.lookbackDays} day(s))...`, "info");
		const fn = deps?.collectTranscriptsFromCommandFn ?? collectTranscriptsFromCommand;
		const result = await fn(
			target.transcriptSource.command,
			target.lookbackDays,
			target.maxSessionBytes,
		);
		({ transcripts, sessionCount, includedCount } = result);
		allSessions = result.sessions;
	} else {
		notify(`Extracting transcripts (last ${target.lookbackDays} day(s))...`, "info");
		const fn = deps?.collectTranscriptsFn ?? collectTranscripts;
		const result = await fn(
			target.lookbackDays,
			target.maxSessionBytes,
		);
		({ transcripts, sessionCount, includedCount } = result);
		allSessions = result.sessions;
	}

	if (!transcripts || includedCount === 0) {
		notify(`No substantive sessions found (${sessionCount} scanned). Nothing to reflect on.`, "info");
		return null;
	}

	// Use total session count from allSessions if available (includes sessions that didn't fit the budget)
	const totalSessionCount = allSessions ? allSessions.length : includedCount;
	const totalBytes = allSessions ? allSessions.reduce((sum, s) => sum + s.size, 0) : transcripts.length;
	notify(`Extracted ${totalSessionCount} sessions (${sessionCount} scanned, ${(totalBytes / 1024).toFixed(0)}KB)`, "info");

	// Dedup: skip if we already reflected on this target+sourceDate
	if (!options?.sourceDateOverride) {
		const sourceDate = new Date();
		sourceDate.setDate(sourceDate.getDate() - target.lookbackDays);
		const sourceDateStr = sourceDate.toISOString().slice(0, 10);
		const history = loadHistory();
		const alreadyRan = history.some(
			(r) => r.targetPath === targetPath && r.sourceDate === sourceDateStr,
		);
		if (alreadyRan) {
			notify(`Already reflected on ${sourceDateStr} for this target — skipping`, "info");
			return null;
		}
	}

	// Resolve model — prefer current session model over target.model config
	let model: any;
	let apiKey: string | undefined;
	let headers: Record<string, string> | undefined;
	let modelLabel: string;

	if (options?.currentModel && options?.currentModelApiKey) {
		model = options.currentModel;
		apiKey = options.currentModelApiKey;
		headers = options.currentModelHeaders;
		modelLabel = `${model.provider}/${model.id}`;
	} else {
		const getModelFn = deps?.getModel ?? (await import("@mariozechner/pi-ai")).getModel;
		const [provider, modelId] = target.model.split("/", 2);
		model = getModelFn(provider as any, modelId as any);

		if (!model) {
			model = modelRegistry?.find(provider, modelId);
		}
		if (!model) {
			notify(`Model not found: ${target.model}`, "error");
			return null;
		}

		// ModelRegistry has shipped two API shapes so far:
		//   * newer pi: getApiKey(model) -> string
		//   * older pi: getApiKeyAndHeaders(model) -> { ok, apiKey, headers, env, error }
		// resolveAuth() abstracts over both so this stays compatible across pi versions.
		const auth = await resolveAuth(modelRegistry, model);
		if (!auth) {
			notify(`No API key for model: ${target.model}`, "error");
			return null;
		}
		apiKey = auth.apiKey;
		headers = auth.headers;
		modelLabel = target.model;
	}

	// Collect additional context
	let context = "";
	if (target.context && target.context.length > 0) {
		notify(`Collecting context from ${target.context.length} source(s)...`, "info");
		context = await collectContext(target.context, target.lookbackDays);
		if (context) {
			notify(`Collected ${(context.length / 1024).toFixed(0)}KB of additional context`, "info");
		}
	}

	// Build batches and call LLM
	const completeFn = deps?.completeSimple ?? (await import("@mariozechner/pi-ai")).completeSimple;

	// Determine if we need multiple batches
	// Reserve space for target file, system prompt, tool schema, and context
	const overhead = targetContent.length + (context?.length ?? 0) + 20_000; // 20KB for prompt/tool schema
	const batchBudget = Math.max(target.maxSessionBytes - overhead, 100_000); // at least 100KB per batch
	const needsBatching = allSessions && allSessions.length > 0 && totalBytes > batchBudget;
	let allEdits: AnalysisEdit[] = [];
	let totalCorrectionsFound = 0;
	let allSummaries: string[] = [];

	if (needsBatching) {
		const batches = buildTranscriptBatches(allSessions!, batchBudget);
		notify(`Sessions exceed context budget — splitting into ${batches.length} batches`, "info");

		for (let i = 0; i < batches.length; i++) {
			const batchTranscripts = formatBatchTranscripts(batches[i], i, batches.length, totalSessionCount);
			// Re-read target content for each batch so later batches see earlier edits
			const currentContent = i === 0 ? targetContent : fs.readFileSync(targetPath, "utf-8");
			notify(`Analyzing batch ${i + 1}/${batches.length} (${batches[i].length} sessions, ${(batchTranscripts.length / 1024).toFixed(0)}KB) with ${modelLabel}...`, "info");

			const result = await analyzeTranscriptBatch(
				target, targetPath, currentContent, batchTranscripts, context,
				model, apiKey!, headers, modelLabel, notify, completeFn,
			);

			if (!result) continue;

			allEdits.push(...result.edits);
			totalCorrectionsFound += result.correctionsFound;
			if (result.summary) allSummaries.push(result.summary);

			// Apply this batch's edits immediately so the next batch sees the updated file
			if (result.edits.length > 0) {
				const currentForApply = fs.readFileSync(targetPath, "utf-8");
				const { result: updated, applied } = applyEdits(currentForApply, result.edits);
				if (applied > 0) {
					// Backup before first edit
					if (i === 0) {
						const bkDir = resolvePath(target.backupDir);
						fs.mkdirSync(bkDir, { recursive: true });
						const bkPath = path.join(bkDir, `${path.basename(targetPath, ".md")}_${formatTimestamp()}.md`);
						fs.copyFileSync(targetPath, bkPath);
					}
					fs.writeFileSync(targetPath, updated, "utf-8");
					notify(`Batch ${i + 1}: applied ${applied} edit(s)`, "info");
				}
			}
		}
	} else {
		notify(`Analyzing with ${modelLabel}...`, "info");
		const result = await analyzeTranscriptBatch(
			target, targetPath, targetContent, transcripts, context,
			model, apiKey!, headers, modelLabel, notify, completeFn,
		);
		if (!result) return null;
		allEdits = result.edits;
		totalCorrectionsFound = result.correctionsFound;
		if (result.summary) allSummaries.push(result.summary);
	}

	const edits = allEdits;
	const correctionsFound = totalCorrectionsFound;
	const correctionRate = totalSessionCount > 0 ? correctionsFound / totalSessionCount : 0;

	// sourceDate = the date of sessions being analyzed, not when reflect ran
	let sourceDateStr: string;
	if (options?.sourceDateOverride) {
		sourceDateStr = options.sourceDateOverride;
	} else {
		const sourceDate = new Date();
		sourceDate.setDate(sourceDate.getDate() - target.lookbackDays);
		sourceDateStr = sourceDate.toISOString().slice(0, 10);
	}

	const combinedSummary = allSummaries.join(" ") || `${edits.length} edits from ${totalSessionCount} sessions.`;

	if (edits.length === 0) {
		notify(`No edits needed. ${combinedSummary}`, "info");
		return {
			timestamp: new Date().toISOString(),
			targetPath,
			sessionsAnalyzed: totalSessionCount,
			correctionsFound,
			editsApplied: 0,
			summary: combinedSummary,
			diffLines: 0,
			correctionRate,
			edits: [],
			sourceDate: sourceDateStr,
			fileSize: computeFileMetrics(fs.readFileSync(targetPath, "utf-8")),
		};
	}

	// In dryRun mode, skip applying edits — just record the analysis
	if (options?.dryRun) {
		const editRecords: EditRecord[] = edits
			.filter((e: any) => e.section && e.reason)
			.map((e: any) => ({
				type: e.type ?? "add",
				section: e.section,
				reason: e.reason,
			}));

		notify(`[dry run] ${combinedSummary}`, "info");

		return {
			timestamp: new Date().toISOString(),
			targetPath,
			sessionsAnalyzed: totalSessionCount,
			correctionsFound,
			editsApplied: 0,
			summary: combinedSummary,
			diffLines: 0,
			correctionRate,
			edits: editRecords,
			sourceDate: sourceDateStr,
			fileSize: computeFileMetrics(fs.readFileSync(targetPath, "utf-8")),
		};
	}

	// Apply edits
	const backupDir = resolvePath(target.backupDir);
	let totalApplied = 0;

	if (needsBatching) {
		// Batched: edits were already applied inline in the loop above.
		// Count total applied from the diff.
		const finalContent = fs.readFileSync(targetPath, "utf-8");
		const origLines = targetContent.split("\n");
		const finalLines = finalContent.split("\n");
		for (let i = 0; i < Math.max(origLines.length, finalLines.length); i++) {
			if (origLines[i] !== finalLines[i]) totalApplied++;
		}
		// Use edit count as applied since we tracked them per-batch
		totalApplied = edits.length; // best estimate — individual batch applied counts were logged
	} else {
		// Single batch — backup and apply
		fs.mkdirSync(backupDir, { recursive: true });
		const backupPath = path.join(backupDir, `${path.basename(targetPath, ".md")}_${formatTimestamp()}.md`);
		fs.copyFileSync(targetPath, backupPath);

		const { result, applied, skipped } = applyEdits(targetContent, edits);

		if (applied === 0) {
			notify(`All ${edits.length} edits failed to apply. Skipped: ${skipped.join("; ")}`, "warning");
			try { fs.unlinkSync(backupPath); } catch {}
			return null;
		}

		if (result.length < targetContent.length * 0.5) {
			notify(`Result is suspiciously small (${result.length} vs ${targetContent.length} bytes). Aborting.`, "error");
			return null;
		}

		fs.writeFileSync(targetPath, result, "utf-8");
		totalApplied = applied;

		if (skipped.length > 0) {
			notify(`Applied ${applied}/${edits.length} edits (${skipped.length} skipped). Backup: ${backupPath}`, "warning");
		} else {
			notify(`Applied ${applied} edit(s). Backup: ${backupPath}`, "info");
		}
	}

	// Compute final diff
	const finalContent = fs.readFileSync(targetPath, "utf-8");
	const originalLines = targetContent.split("\n");
	const resultLines = finalContent.split("\n");
	let diffLines = 0;
	const maxLen = Math.max(originalLines.length, resultLines.length);
	for (let i = 0; i < maxLen; i++) {
		if (originalLines[i] !== resultLines[i]) diffLines++;
	}

	notify(combinedSummary, "info");

	// Git commit
	try {
		const realPath = fs.realpathSync(targetPath);
		const repoDir = path.dirname(realPath);
		if (fs.existsSync(path.join(repoDir, ".git"))) {
			const { execFileSync } = require("node:child_process");
			execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore", timeout: 5000 });
			execFileSync("git", ["commit", "-m", `reflect: ${path.basename(realPath)} — ${totalApplied} edits from ${totalSessionCount} sessions`, "--no-verify"], { cwd: repoDir, stdio: "ignore", timeout: 5000 });
			notify(`Committed to ${path.basename(repoDir)}`, "info");
		}
	} catch {}

	const editRecords: EditRecord[] = edits
		.filter((e: any) => e.section && e.reason)
		.map((e: any) => ({ type: e.type ?? "add", section: e.section, reason: e.reason }));

	return {
		timestamp: new Date().toISOString(),
		targetPath,
		sessionsAnalyzed: totalSessionCount,
		correctionsFound,
		editsApplied: totalApplied,
		summary: combinedSummary,
		diffLines,
		correctionRate,
		edits: editRecords,
		sourceDate: sourceDateStr,
		fileSize: computeFileMetrics(fs.readFileSync(targetPath, "utf-8")),
	};
}

// Re-export path constants for the extension entry point
export { CONFIG_FILE, CONFIG_DIR, SESSIONS_DIR, DEFAULT_BACKUP_DIR, HISTORY_FILE, HOME };

/**
 * Resolve API key and headers from a ModelRegistry, supporting both API shapes
 * pi has shipped:
 *   - newer:  getApiKey(model) -> string
 *   - older:  getApiKeyAndHeaders(model) -> { ok, apiKey, headers, env, error }
 *
 * Returns null when the registry is absent, has no compatible method, or no key.
 * Exported so tests can verify the compatibility branch without a live registry.
 */
export async function resolveAuth(
	modelRegistry: any,
	model: any,
): Promise<{ apiKey: string; headers?: Record<string, string> } | null> {
	if (!modelRegistry) return null;

	// Prefer the newer single-key API when present.
	if (typeof modelRegistry.getApiKey === "function") {
		const key = await modelRegistry.getApiKey(model);
		if (typeof key === "string" && key.length > 0) {
			return { apiKey: key };
		}
		return null;
	}

	// Fall back to the combined API used by older pi releases.
	if (typeof modelRegistry.getApiKeyAndHeaders === "function") {
		const result = await modelRegistry.getApiKeyAndHeaders(model);
		if (result && result.ok && typeof result.apiKey === "string" && result.apiKey.length > 0) {
			return { apiKey: result.apiKey, headers: result.headers };
		}
		return null;
	}

	return null;
}
