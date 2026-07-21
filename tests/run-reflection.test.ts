import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	runReflection,
	type ReflectTarget,
	type RunReflectionDeps,
	type NotifyFn,
	DEFAULT_TARGET,
} from "../extensions/reflect.js";
import { makeTempDir, cleanup, SAMPLE_AGENTS_MD } from "./helpers.js";

let tmpDir: string;
let notifications: Array<{ msg: string; level: string }>;
let notify: NotifyFn;

beforeEach(() => {
	tmpDir = makeTempDir();
	notifications = [];
	notify = (msg, level) => notifications.push({ msg, level });
});

afterEach(() => {
	cleanup(tmpDir);
});

function makeTarget(overrides: Partial<ReflectTarget> = {}): ReflectTarget {
	return {
		...DEFAULT_TARGET,
		backupDir: path.join(tmpDir, "backups"),
		...overrides,
	};
}

function makeLlmResponse(edits: any[], corrections_found = 5, summary = "Test summary") {
	return JSON.stringify({ corrections_found, sessions_with_corrections: 3, edits, patterns_not_added: [], summary });
}

function makeDeps(llmResponseJson: string, transcripts = "### Session: test\n\n**USER:** bro no\n**AGENT:** sorry"): RunReflectionDeps {
	return {
		completeSimple: async () => ({
			content: [{ type: "text", text: llmResponseJson }],
		}),
		getModel: () => ({ provider: "test", id: "test-model" }),
		collectTranscriptsFn: async () => ({
			transcripts,
			sessionCount: 10,
			includedCount: 5,
		}),
	};
}

function makeModelRegistry() {
	return {
		find: () => ({ provider: "test", id: "test-model" }),
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: undefined }),
	};
}

describe("runReflection", () => {
	it("returns null and notifies when target file not found", async () => {
		const target = makeTarget({ path: path.join(tmpDir, "nonexistent.md") });
		const result = await runReflection(target, makeModelRegistry(), notify, makeDeps("{}"));
		assert.equal(result, null);
		assert.ok(notifications.some(n => n.level === "error" && n.msg.includes("not found")));
	});

	it("returns null when target file is too small", async () => {
		const fp = path.join(tmpDir, "tiny.md");
		fs.writeFileSync(fp, "small");
		const target = makeTarget({ path: fp });
		const result = await runReflection(target, makeModelRegistry(), notify, makeDeps("{}"));
		assert.equal(result, null);
		assert.ok(notifications.some(n => n.level === "error" && n.msg.includes("too small")));
	});

	it("returns null when no transcripts found", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({ path: fp });
		const deps: RunReflectionDeps = {
			...makeDeps("{}"),
			collectTranscriptsFn: async () => ({ transcripts: "", sessionCount: 5, includedCount: 0 }),
		};
		const result = await runReflection(target, makeModelRegistry(), notify, deps);
		assert.equal(result, null);
		assert.ok(notifications.some(n => n.msg.includes("No substantive sessions")));
	});

	it("returns null when model not found", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({ path: fp, model: "nonexistent/model-xyz" });
		const deps: RunReflectionDeps = {
			...makeDeps("{}"),
			getModel: () => null,
		};
		const registry = { find: () => null, getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) };
		const result = await runReflection(target, registry, notify, deps);
		assert.equal(result, null);
		assert.ok(notifications.some(n => n.level === "error" && n.msg.includes("Model not found")));
	});

	it("returns null when no API key available", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({ path: fp });
		const registry = {
			find: () => ({ provider: "test", id: "test" }),
			getApiKeyAndHeaders: async () => ({ ok: false, error: "No API key" }),
		};
		const result = await runReflection(target, registry, notify, makeDeps("{}"));
		assert.equal(result, null);
		assert.ok(notifications.some(n => n.level === "error" && n.msg.includes("No API key")));
	});

	it("supports header-only auth from the current model registry", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		let receivedOptions: any;
		const deps = makeDeps(makeLlmResponse([], 0));
		deps.completeSimple = async (_model, _request, options) => {
			receivedOptions = options;
			return { content: [{ type: "text", text: makeLlmResponse([], 0) }] };
		};
		const registry = {
			find: () => ({ provider: "test", id: "test" }),
			getApiKeyAndHeaders: async () => ({ ok: true, headers: { "X-Custom": "value" } }),
		};
		const result = await runReflection(makeTarget({ path: fp }), registry, notify, deps);
		assert.notEqual(result, null);
		assert.deepEqual(receivedOptions.headers, { "X-Custom": "value" });
	});

	it("supports the legacy modelRegistry.getApiKey API", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const registry = {
			find: () => ({ provider: "test", id: "test" }),
			getApiKey: async () => "legacy-key",
		};
		const result = await runReflection(makeTarget({ path: fp }), registry, notify, makeDeps(makeLlmResponse([], 0)));
		assert.notEqual(result, null);
	});

	it("returns run with 0 edits when LLM says no edits needed", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({ path: fp });
		const llmResponse = makeLlmResponse([], 0, "No issues found.");
		const result = await runReflection(target, makeModelRegistry(), notify, makeDeps(llmResponse));
		assert.notEqual(result, null);
		assert.equal(result!.editsApplied, 0);
		assert.equal(result!.correctionsFound, 0);
		assert.ok(result!.summary.includes("No issues"));
	});

	it("applies edits and creates backup", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const backupDir = path.join(tmpDir, "backups");
		const target = makeTarget({ path: fp, backupDir });

		const llmResponse = makeLlmResponse([{
			type: "strengthen",
			old_text: "- **Keep code DRY**: NEVER duplicate logic.",
			new_text: "- **Keep code DRY (CRITICAL)**: NEVER duplicate logic. If two call sites need different behavior, add parameters.",
		}]);

		const result = await runReflection(target, makeModelRegistry(), notify, makeDeps(llmResponse));
		assert.notEqual(result, null);
		assert.equal(result!.editsApplied, 1);

		// File was modified
		const updated = fs.readFileSync(fp, "utf-8");
		assert.ok(updated.includes("Keep code DRY (CRITICAL)"));

		// Backup was created
		const backups = fs.readdirSync(backupDir);
		assert.equal(backups.length, 1);
		assert.ok(backups[0].startsWith("AGENTS_"));
		assert.ok(backups[0].endsWith(".md"));

		// Backup has original content
		const backupContent = fs.readFileSync(path.join(backupDir, backups[0]), "utf-8");
		assert.equal(backupContent, SAMPLE_AGENTS_MD);
	});

	it("returns null and cleans up backup when all edits fail", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const backupDir = path.join(tmpDir, "backups");
		const target = makeTarget({ path: fp, backupDir });

		const llmResponse = makeLlmResponse([{
			type: "strengthen",
			old_text: "- This text does not exist in the file at all.",
			new_text: "- Replacement that can never apply.",
		}]);

		const result = await runReflection(target, makeModelRegistry(), notify, makeDeps(llmResponse));
		assert.equal(result, null);
		assert.ok(notifications.some(n => n.level === "warning" && n.msg.includes("edits failed")));

		// Backup should be cleaned up
		if (fs.existsSync(backupDir)) {
			const backups = fs.readdirSync(backupDir);
			assert.equal(backups.length, 0);
		}
	});

	it("returns null when LLM response is not valid JSON", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({ path: fp });
		const deps: RunReflectionDeps = {
			...makeDeps("{}"),
			completeSimple: async () => ({
				content: [{ type: "text", text: "This is not JSON at all, just plain text." }],
			}),
		};
		const result = await runReflection(target, makeModelRegistry(), notify, deps);
		assert.equal(result, null);
		assert.ok(notifications.some(n => n.level === "error" && n.msg.includes("Failed to parse")));
	});

	it("strips markdown code fences from LLM response", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({ path: fp });
		const jsonStr = makeLlmResponse([{
			type: "strengthen",
			old_text: "- **Keep code DRY**: NEVER duplicate logic.",
			new_text: "- **Keep code DRY (CRITICAL)**: NEVER duplicate logic. Always parameterize.",
		}]);
		const deps: RunReflectionDeps = {
			...makeDeps("{}"),
			completeSimple: async () => ({
				content: [{ type: "text", text: "```json\n" + jsonStr + "\n```" }],
			}),
		};
		const result = await runReflection(target, makeModelRegistry(), notify, deps);
		assert.notEqual(result, null);
		assert.equal(result!.editsApplied, 1);
	});

	it("uses command transcript source when configured", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({
			path: fp,
			transcriptSource: { type: "command", command: "echo test {lookbackDays}" },
		});

		let commandCalledWith = "";
		const deps: RunReflectionDeps = {
			...makeDeps("{}"),
			collectTranscriptsFromCommandFn: async (cmd, days, max) => {
				commandCalledWith = cmd;
				return { transcripts: "### Session: cmd test\n\n**USER:** test\n", sessionCount: 1, includedCount: 1 };
			},
		};

		const llmResponse = makeLlmResponse([], 0, "No issues.");
		deps.completeSimple = async () => ({
			content: [{ type: "text", text: llmResponse }],
		});

		await runReflection(target, makeModelRegistry(), notify, deps);
		assert.equal(commandCalledWith, "echo test {lookbackDays}");
	});

	it("counts diff lines correctly", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({ path: fp });
		const llmResponse = makeLlmResponse([{
			type: "add",
			after_text: "- **Keep code DRY**: NEVER duplicate logic.",
			new_text: "- **New rule 1**: First new rule.\n- **New rule 2**: Second new rule.",
		}]);

		const result = await runReflection(target, makeModelRegistry(), notify, makeDeps(llmResponse));
		assert.notEqual(result, null);
		assert.ok(result!.diffLines > 0);
	});

	it("reports partial success with skipped edits", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({ path: fp });
		const llmResponse = makeLlmResponse([
			{
				type: "strengthen",
				old_text: "- **Keep code DRY**: NEVER duplicate logic.",
				new_text: "- **Keep code DRY (CRITICAL)**: NEVER duplicate logic. Parameterize always.",
			},
			{
				type: "strengthen",
				old_text: "- This text does not exist.",
				new_text: "- This will fail.",
			},
		]);

		const result = await runReflection(target, makeModelRegistry(), notify, makeDeps(llmResponse));
		assert.notEqual(result, null);
		assert.equal(result!.editsApplied, 1);
		assert.ok(notifications.some(n => n.level === "warning" && n.msg.includes("1 skipped")));
	});

	it("does not write file when result would be suspiciously small", async () => {
		// Create a very large file
		const fp = path.join(tmpDir, "AGENTS.md");
		const bigContent = SAMPLE_AGENTS_MD + "\n" + "x".repeat(10000);
		fs.writeFileSync(fp, bigContent);
		const target = makeTarget({ path: fp });

		// An edit that would replace most of the content with almost nothing
		const llmResponse = makeLlmResponse([{
			type: "strengthen",
			old_text: "x".repeat(10000),
			new_text: "tiny",
		}]);

		const result = await runReflection(target, makeModelRegistry(), notify, makeDeps(llmResponse));

		// The size check should abort — file unchanged
		assert.equal(result, null);
		assert.ok(notifications.some(n => n.level === "error" && n.msg.includes("suspiciously small")));
		const unchanged = fs.readFileSync(fp, "utf-8");
		assert.equal(unchanged, bigContent);
	});

	it("falls back to model registry when getModel returns null", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({ path: fp });
		const llmResponse = makeLlmResponse([], 0, "No issues.");

		let registryFindCalled = false;
		const registry = {
			find: () => { registryFindCalled = true; return { provider: "test", id: "test" }; },
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: undefined }),
		};
		const deps: RunReflectionDeps = {
			...makeDeps(llmResponse),
			getModel: () => null, // force fallback to registry
		};

		await runReflection(target, registry, notify, deps);
		assert.ok(registryFindCalled);
	});

	it("includes session stats in notifications", async () => {
		const fp = path.join(tmpDir, "AGENTS.md");
		fs.writeFileSync(fp, SAMPLE_AGENTS_MD);
		const target = makeTarget({ path: fp });
		const llmResponse = makeLlmResponse([], 0, "Clean.");
		const result = await runReflection(target, makeModelRegistry(), notify, makeDeps(llmResponse));

		assert.ok(notifications.some(n => n.msg.includes("Extracting transcripts")));
		assert.ok(notifications.some(n => n.msg.includes("5 sessions") && n.msg.includes("10 scanned")));
		assert.ok(notifications.some(n => n.msg.includes("Analyzing with")));
	});
});
