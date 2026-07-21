import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
	resolvePath,
	formatTimestamp,
	escapeRegex,
	truncateText,
	projectNameFromDir,
	resolveModelAuth,
	buildReflectAnalysisTool,
} from "../extensions/reflect.js";

describe("resolveModelAuth", () => {
	const model = { provider: "test", id: "model" };

	it("prefers current getApiKeyAndHeaders and preserves header-only auth", async () => {
		let legacyCalled = false;
		const auth = await resolveModelAuth({
			getApiKeyAndHeaders: async () => ({ ok: true, headers: { "X-Test": "yes" } }),
			getApiKey: async () => { legacyCalled = true; return "legacy"; },
		}, model);
		assert.deepEqual(auth, { ok: true, apiKey: undefined, headers: { "X-Test": "yes" } });
		assert.equal(legacyCalled, false);
	});

	it("falls back to the legacy getApiKey API", async () => {
		assert.deepEqual(await resolveModelAuth({ getApiKey: async () => "legacy" }, model), { ok: true, apiKey: "legacy" });
	});
});

describe("reflect analysis tool schema", () => {
	it("uses scalar JSON Schema types for protobuf-compatible optional fields", () => {
		const properties = (buildReflectAnalysisTool().parameters.properties.edits.items as any).properties;
		assert.equal(properties.old_text.type, "string");
		assert.equal(properties.after_text.type, "string");
		assert.equal(properties.merge_sources.type, "array");
	});
});

describe("resolvePath", () => {
	it("expands ~ to HOME", () => {
		const home = process.env.HOME!;
		assert.equal(resolvePath("~/foo/bar"), `${home}/foo/bar`);
	});

	it("expands ~/", () => {
		const home = process.env.HOME!;
		assert.equal(resolvePath("~/.pi/agent"), `${home}/.pi/agent`);
	});

	it("resolves absolute paths as-is", () => {
		assert.equal(resolvePath("/tmp/test"), "/tmp/test");
	});

	it("resolves relative paths against cwd", () => {
		const result = resolvePath("foo/bar");
		assert.ok(result.startsWith("/"));
		assert.ok(result.endsWith("foo/bar"));
	});
});

describe("formatTimestamp", () => {
	it("returns a 15-char string", () => {
		const ts = formatTimestamp();
		assert.equal(ts.length, 15);
	});

	it("contains no colons or periods", () => {
		const ts = formatTimestamp();
		assert.ok(!ts.includes(":"));
		assert.ok(!ts.includes("."));
	});

	it("starts with a year", () => {
		const ts = formatTimestamp();
		assert.match(ts, /^20\d{2}/);
	});

	it("contains underscore separator between date and time", () => {
		const ts = formatTimestamp();
		assert.ok(ts.includes("_"));
	});
});

describe("escapeRegex", () => {
	it("escapes dots", () => {
		assert.equal(escapeRegex("a.b"), "a\\.b");
	});

	it("escapes parentheses", () => {
		assert.equal(escapeRegex("(foo)"), "\\(foo\\)");
	});

	it("escapes brackets", () => {
		assert.equal(escapeRegex("[a]"), "\\[a\\]");
	});

	it("escapes all special regex chars", () => {
		const specials = ".*+?^${}()|[]\\";
		const escaped = escapeRegex(specials);
		// Every special char should be preceded by a backslash
		for (const ch of specials) {
			assert.ok(escaped.includes(`\\${ch}`), `Expected \\${ch} in ${escaped}`);
		}
	});

	it("leaves normal text unchanged", () => {
		assert.equal(escapeRegex("hello world"), "hello world");
	});

	it("handles empty string", () => {
		assert.equal(escapeRegex(""), "");
	});

	it("escaped string works in RegExp constructor", () => {
		const dangerous = "price is $100.00 (USD)";
		const re = new RegExp(escapeRegex(dangerous));
		assert.ok(re.test(dangerous));
		assert.ok(!re.test("price is X100Y00 ZUSDW")); // shouldn't match with unescaped
	});
});

describe("truncateText", () => {
	it("returns null for null input", () => {
		assert.equal(truncateText(null, 100), null);
	});

	it("returns text unchanged when under limit", () => {
		assert.equal(truncateText("short", 100), "short");
	});

	it("returns text unchanged when exactly at limit", () => {
		const text = "a".repeat(100);
		assert.equal(truncateText(text, 100), text);
	});

	it("truncates text over limit", () => {
		const text = "a".repeat(200);
		const result = truncateText(text, 100)!;
		assert.ok(result.startsWith("a".repeat(100)));
		assert.ok(result.includes("[...truncated"));
	});

	it("includes omitted char count in truncation message", () => {
		const text = "a".repeat(200);
		const result = truncateText(text, 100)!;
		assert.ok(result.includes("100 chars omitted"));
	});

	it("handles limit of 0", () => {
		const result = truncateText("hello", 0)!;
		assert.ok(result.includes("truncated"));
		assert.ok(result.includes("5 chars omitted"));
	});
});

describe("projectNameFromDir", () => {
	const user = process.env.USER ?? "user";

	it("strips macOS home prefix", () => {
		// pi uses -- as path separator, single dashes are part of names
		const dirname = `--Users-${user}-personal--myproject`;
		assert.equal(projectNameFromDir(dirname), "personal/myproject");
	});

	it("strips Linux home prefix", () => {
		const dirname = `--home-${user}-projects--myapp`;
		assert.equal(projectNameFromDir(dirname), "projects/myapp");
	});

	it("preserves single dashes within path segments", () => {
		const dirname = `--Users-${user}-my-project`;
		// Single dash is part of the name, not a separator
		assert.equal(projectNameFromDir(dirname), "my-project");
	});

	it("converts double dashes to slashes", () => {
		const dirname = `--Users-${user}-a--b--c`;
		assert.equal(projectNameFromDir(dirname), "a/b/c");
	});

	it("returns 'workspace' for empty result after stripping", () => {
		const dirname = `--Users-${user}-`;
		assert.equal(projectNameFromDir(dirname), "workspace");
	});

	it("returns dirname as-is when no prefix matches", () => {
		const dirname = "some-random-dirname";
		assert.equal(projectNameFromDir(dirname), "some-random-dirname");
	});

	it("handles nested project paths", () => {
		const dirname = `--Users-${user}-personal--workspace--jo_bot`;
		assert.equal(projectNameFromDir(dirname), "personal/workspace/jo_bot");
	});

	it("strips leading/trailing dashes and slashes from result", () => {
		const dirname = `--Users-${user}---leading`;
		const result = projectNameFromDir(dirname);
		assert.ok(!result.startsWith("/"));
		assert.ok(!result.startsWith("-"));
	});
});
