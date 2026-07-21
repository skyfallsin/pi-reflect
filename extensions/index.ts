/**
 * Reflect — Self-improving behavioral files for pi coding agents.
 *
 * Commands:
 *   /reflect [path]      — Run reflection on a file (or configured default)
 *   /reflect-config      — Show/edit reflection configuration
 *   /reflect-history     — Show recent reflection runs
 *   /reflect-stats       — Show impact metrics (correction rate trend + rule recidivism)
 *   /reflect-backfill    — Backfill stats for all historical session dates
 *
 * Headless execution for cron/launchd:
 *   pi -p --no-session "/reflect /path/to/AGENTS.md"
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";

/** Display a target path as "parentDir/filename" for compact but unambiguous listing */
function targetLabel(filePath: string): string {
	const dir = path.basename(path.dirname(filePath));
	return `${dir}/${path.basename(filePath)}`;
}

import {
	type ReflectTarget,
	type ReflectRun,
	type NotifyFn,
	DEFAULT_TARGET,
	loadConfig,
	saveConfig,
	loadHistory,
	saveHistory,
	resolvePath,
	runReflection,
	collectTranscriptsForDate,
	getAvailableSessionDates,
	computeFileMetrics,
	CONFIG_FILE,
} from "./reflect.js";

export default function (pi: ExtensionAPI) {
	let modelRegistryRef: any = null;

	pi.on("session_start", async (_event, ctx) => {
		modelRegistryRef = ctx.modelRegistry;
	});

	pi.registerCommand("reflect", {
		description: "Reflect on recent sessions and improve a behavioral markdown file",
		handler: async (args, ctx) => {
			modelRegistryRef = ctx.modelRegistry;
			const targetPath = args?.trim();

			let targets: ReflectTarget[];

			if (targetPath) {
				const config = loadConfig();
				const existing = config.targets.find(
					(t) => resolvePath(t.path) === resolvePath(targetPath),
				);
				targets = [existing ?? { ...DEFAULT_TARGET, path: targetPath }];
			} else {
				const config = loadConfig();
				if (config.targets.length === 0) {
					if (ctx.hasUI) {
						const filePath = await ctx.ui.input(
							"No targets configured. Enter path to a markdown file to reflect on:",
						);
						if (!filePath) return;
						targets = [{ ...DEFAULT_TARGET, path: filePath }];

						const save = await ctx.ui.confirm(
							"Save target?",
							`Save ${filePath} as a reflection target for next time?`,
						);
						if (save) {
							config.targets.push(targets[0]);
							saveConfig(config);
							ctx.ui.notify("Saved to reflect.json", "info");
						}
					} else {
						console.error("No targets configured. Use: /reflect <path>");
						return;
					}
				} else if (config.targets.length === 1) {
					targets = [config.targets[0]];
				} else if (ctx.hasUI) {
					const allTargetsLabel = "All targets";
					const choice = await ctx.ui.select(
						"Which target?",
						[...config.targets.map((t) => targetLabel(t.path)), allTargetsLabel],
					);
					if (choice === undefined || choice === null) return;
					if (choice === allTargetsLabel) {
						targets = config.targets;
					} else {
						const chosenTarget = config.targets.find((t) => targetLabel(t.path) === choice);
						if (!chosenTarget) return;
						targets = [chosenTarget];
					}
				} else {
					targets = [config.targets[0]];
				}
			}

			const notify: NotifyFn = ctx.hasUI
				? (msg, level) => ctx.ui.notify(msg, level)
				: (msg, level) => console.log(`[reflect] [${level}] ${msg}`);

			// Run configured targets sequentially to avoid provider concurrency spikes,
			// and persist each successful result immediately.
			let completed = 0;
			let failed = 0;
			for (const target of targets) {
				try {
					const run = await runReflection(target, modelRegistryRef, notify, undefined, {});
					if (run) {
						const history = loadHistory();
						history.push(run);
						saveHistory(history);
						completed++;
					} else {
						failed++;
					}
				} catch (error) {
					failed++;
					notify(`${targetLabel(target.path)} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}
			if (targets.length > 1) {
				notify(`All targets finished: ${completed} completed, ${failed} failed or skipped`, failed ? "warning" : "info");
			}
		},
	});

	pi.registerCommand("reflect-config", {
		description: "Show and manage reflection targets",
		handler: async (_args, ctx) => {
			const config = loadConfig();

			if (!ctx.hasUI) {
				console.log(JSON.stringify(config, null, 2));
				return;
			}

			if (config.targets.length === 0) {
				ctx.ui.notify("No targets configured. Use /reflect <path> to add one.", "info");
				return;
			}

			const lines = config.targets.map((t, i) => {
				return `${i + 1}. **${targetLabel(t.path)}** — ${t.schedule}, ${t.model}, ${t.lookbackDays}d lookback\n   ${t.path}`;
			});

			ctx.ui.notify(
				`Reflection targets:\n${lines.join("\n")}\n\nEdit: ${CONFIG_FILE}`,
				"info",
			);
		},
	});

	pi.registerCommand("reflect-history", {
		description: "Show recent reflection runs",
		handler: async (_args, ctx) => {
			const history = loadHistory();

			if (history.length === 0) {
				if (ctx.hasUI) {
					ctx.ui.notify("No reflection runs yet. Use /reflect to run one.", "info");
				}
				return;
			}

			const recent = history.slice(-10).reverse();
			const lines = recent.map((r) => {
				const date = r.timestamp.slice(0, 16).replace("T", " ");
				const file = targetLabel(r.targetPath);
				return `- **${date}** ${file}: ${r.editsApplied} edits, ${r.correctionsFound} corrections (${r.sessionsAnalyzed} sessions)\n  ${r.summary}`;
			});

			if (ctx.hasUI) {
				ctx.ui.notify(`Recent reflections:\n${lines.join("\n")}`, "info");
			} else {
				console.log(lines.join("\n"));
			}
		},
	});

	// /reflect-stats — show impact metrics
	pi.registerCommand("reflect-stats", {
		description: "Show reflection impact metrics: correction rate trend and rule recidivism, grouped by target file",
		handler: async (args, ctx) => {
			const history = loadHistory();

			if (history.length < 2) {
				const msg = "Need at least 2 reflection runs for stats. Use /reflect to build history.";
				if (ctx.hasUI) { ctx.ui.notify(msg, "info"); } else { console.log(msg); }
				return;
			}

			function getSourceDate(r: ReflectRun): string {
				return r.sourceDate ?? (r as any).date ?? r.timestamp.slice(0, 10);
			}

			// Group runs by target file
			const byTarget = new Map<string, ReflectRun[]>();
			for (const run of history) {
				const key = run.targetPath;
				const list = byTarget.get(key) ?? [];
				list.push(run);
				byTarget.set(key, list);
			}

			// If multiple targets tracked, let user pick one (or show all)
			if (byTarget.size > 1 && ctx.hasUI) {
				const options = ["All targets", ...Array.from(byTarget.keys()).map((p) => targetLabel(p))];
				const choice = await ctx.ui.select("Show stats for which target?", options);
				if (choice === undefined || choice === null) return;
				if (choice !== "All targets") {
					// Filter to just the chosen target
					const chosenPath = Array.from(byTarget.keys()).find((p) => targetLabel(p) === choice);
					if (chosenPath) {
						const runs = byTarget.get(chosenPath)!;
						byTarget.clear();
						byTarget.set(chosenPath, runs);
					}
				}
			}

			const output: string[] = [];
			let targetIdx = 0;

			for (const [targetPath, runs] of byTarget) {
				const fileName = targetLabel(targetPath);
				if (targetIdx > 0) output.push("", "---", "");
				output.push(`# ${fileName}`);
				output.push(`_${targetPath}_`);
				output.push("");

				// --- Current File Size ---
				const resolvedPath = resolvePath(targetPath);
				if (fs.existsSync(resolvedPath)) {
					const current = computeFileMetrics(fs.readFileSync(resolvedPath, "utf-8"));
					output.push(`### Current Size`);
					output.push(`${current.chars.toLocaleString()} chars · ${current.words.toLocaleString()} words · ${current.lines.toLocaleString()} lines · ~${current.estTokens.toLocaleString()} tokens`);
					output.push("");
				}

				// --- File Size Trend ---
				const runsWithSize = runs.filter((r) => r.fileSize).sort((a, b) => getSourceDate(a).localeCompare(getSourceDate(b)));
				if (runsWithSize.length >= 2) {
					output.push("### File Size Trend");
					output.push("");
					for (const r of runsWithSize) {
						const sz = r.fileSize!;
						const date = getSourceDate(r);
						const bar = "\u2588".repeat(Math.round(sz.estTokens / 1000));
						output.push(`${date}  ${sz.chars.toLocaleString().padStart(7)} chars  ${sz.words.toLocaleString().padStart(6)} words  ~${sz.estTokens.toLocaleString().padStart(6)} tok  ${bar}`);
					}

					const first = runsWithSize[0].fileSize!;
					const last = runsWithSize[runsWithSize.length - 1].fileSize!;
					const charDelta = last.chars - first.chars;
					const pct = first.chars > 0 ? ((charDelta / first.chars) * 100).toFixed(0) : "N/A";
					output.push("");
					if (charDelta > 0) {
						output.push(`Trend: \u2191 grew ${charDelta.toLocaleString()} chars (+${pct}%) over ${runsWithSize.length} runs`);
					} else if (charDelta < 0) {
						output.push(`Trend: \u2193 shrank ${Math.abs(charDelta).toLocaleString()} chars (${pct}%) over ${runsWithSize.length} runs`);
					} else {
						output.push(`Trend: \u2194 unchanged`);
					}
					output.push("");
				}

				// --- Correction Rate Trend ---
				output.push("### Correction Rate (corrections per session)");
				output.push("");

				const ratesWithDates = runs.map((r) => ({
					sourceDate: getSourceDate(r),
					rate: r.correctionRate ?? (r.sessionsAnalyzed > 0 ? r.correctionsFound / r.sessionsAnalyzed : 0),
					corrections: r.correctionsFound,
					sessions: r.sessionsAnalyzed,
				}));

				ratesWithDates.sort((a, b) => a.sourceDate.localeCompare(b.sourceDate));

				for (const r of ratesWithDates) {
					const bar = "\u2588".repeat(Math.round(r.rate * 10));
					const rateStr = r.rate.toFixed(2);
					output.push(`${r.sourceDate}  ${rateStr}  ${bar}  (${r.corrections}/${r.sessions} sessions)`);
				}

				if (ratesWithDates.length >= 3) {
					const firstHalf = ratesWithDates.slice(0, Math.floor(ratesWithDates.length / 2));
					const secondHalf = ratesWithDates.slice(Math.floor(ratesWithDates.length / 2));
					const avgFirst = firstHalf.reduce((s, r) => s + r.rate, 0) / firstHalf.length;
					const avgSecond = secondHalf.reduce((s, r) => s + r.rate, 0) / secondHalf.length;
					const delta = avgSecond - avgFirst;
					const pct = avgFirst > 0 ? Math.abs(delta / avgFirst * 100).toFixed(0) : "N/A";

					output.push("");
					if (delta < -0.01) {
						output.push(`Trend: \u2193 improving (${pct}% fewer corrections per session)`);
					} else if (delta > 0.01) {
						output.push(`Trend: \u2191 worsening (${pct}% more corrections per session)`);
					} else {
						output.push(`Trend: \u2194 flat`);
					}
				}

				// --- Rule Recidivism ---
				output.push("");
				output.push("### Rule Recidivism (sections edited multiple times)");
				output.push("");

				const sectionCounts = new Map<string, { count: number; types: string[]; reasons: string[]; dates: string[] }>();

				for (const run of runs) {
					if (!run.edits) continue;
					for (const edit of run.edits) {
						const key = edit.section.toLowerCase().trim();
						const existing = sectionCounts.get(key) ?? { count: 0, types: [], reasons: [], dates: [] };
						existing.count++;
						existing.types.push(edit.type);
						existing.reasons.push(edit.reason);
						existing.dates.push(getSourceDate(run));
						sectionCounts.set(key, existing);
					}
				}

				if (sectionCounts.size === 0) {
					output.push("No per-edit data yet. Run /reflect to start collecting.");
				} else {
					const sorted = [...sectionCounts.entries()].sort((a, b) => b[1].count - a[1].count);
					const recidivists = sorted.filter(([, v]) => v.count >= 2);
					const resolved = sorted.filter(([, v]) => v.count === 1);

					if (recidivists.length > 0) {
						output.push("**Recurring (not sticking):**");
						for (const [section, data] of recidivists) {
							const strengthened = data.types.filter((t) => t === "strengthen").length;
							const added = data.types.filter((t) => t === "add").length;
							const dateRange = `${data.dates[0]} \u2192 ${data.dates[data.dates.length - 1]}`;
							output.push(`- **${section}** \u00d7${data.count} (${strengthened} strengthen, ${added} add) [${dateRange}]`);
							const lastReason = data.reasons[data.reasons.length - 1];
							if (lastReason) {
								output.push(`  Last: ${lastReason.length > 120 ? lastReason.slice(0, 120) + "..." : lastReason}`);
							}
						}
					} else {
						output.push("**No recurring violations.** All rules stuck after first edit.");
					}

					if (resolved.length > 0) {
						output.push("");
						output.push(`**Resolved (edited once, not repeated):** ${resolved.length} rule(s)`);
						for (const [section] of resolved.slice(0, 5)) {
							output.push(`- ${section}`);
						}
						if (resolved.length > 5) {
							output.push(`  ...and ${resolved.length - 5} more`);
						}
					}
				}

				targetIdx++;
			}

			const text = output.join("\n");
			if (ctx.hasUI) {
				ctx.ui.notify(text, "info");
			} else {
				console.log(text);
			}
		},
	});

	// /reflect-backfill — analyze all historical session dates to bootstrap stats
	pi.registerCommand("reflect-backfill", {
		description: "Backfill reflection stats for all available session dates (dry run — no file edits)",
		handler: async (_args, ctx) => {
			modelRegistryRef = ctx.modelRegistry;

			if (!ctx.hasUI) {
				console.error("reflect-backfill requires interactive mode.");
				return;
			}

			const config = loadConfig();
			if (config.targets.length === 0) {
				ctx.ui.notify("No targets configured. Use /reflect <path> to add one.", "info");
				return;
			}

			// Only backfill pi-sessions targets
			const piSessionTargets = config.targets.filter(
				(t) => !t.transcriptSource || t.transcriptSource.type === "pi-sessions",
			);

			if (piSessionTargets.length === 0) {
				ctx.ui.notify("No pi-sessions targets to backfill. Command-based transcript sources are not supported for backfill.", "info");
				return;
			}

			const allDates = getAvailableSessionDates();
			if (allDates.length === 0) {
				ctx.ui.notify("No session files found.", "info");
				return;
			}

			// For each target, find dates already covered
			const history = loadHistory();
			const plan: { target: ReflectTarget; dates: string[] }[] = [];

			for (const target of piSessionTargets) {
				const targetPath = resolvePath(target.path);
				const coveredDates = new Set(
					history
						.filter((r) => r.targetPath === targetPath)
						.map((r) => r.sourceDate ?? (r as any).date)
						.filter(Boolean),
				);

				const missingDates = allDates.filter((d) => !coveredDates.has(d));
				if (missingDates.length > 0) {
					plan.push({ target, dates: missingDates });
				}
			}

			if (plan.length === 0) {
				ctx.ui.notify("All dates already covered. Nothing to backfill.", "info");
				return;
			}

			// Resolve model for cost estimation
			const { getModel } = await import("@mariozechner/pi-ai");
			const target0 = plan[0].target;
			const [provider, modelId] = target0.model.split("/", 2);
			let model = getModel(provider as any, modelId as any);
			if (!model) { model = modelRegistryRef?.find(provider, modelId); }

			const totalCalls = plan.reduce((s, p) => s + p.dates.length, 0);
			const estInputTokensPerCall = 150_000;
			const estOutputTokensPerCall = 2_000;

			let costEstimate = "unknown";
			if (model?.cost) {
				const inputCost = (totalCalls * estInputTokensPerCall * model.cost.input) / 1_000_000;
				const outputCost = (totalCalls * estOutputTokensPerCall * model.cost.output) / 1_000_000;
				const totalCost = inputCost + outputCost;
				costEstimate = `$${totalCost.toFixed(2)}`;
			}

			const planLines: string[] = [];
			planLines.push("**Backfill plan (dry run — no file edits):**");
			planLines.push("");
			for (const p of plan) {
				const fileName = targetLabel(p.target.path);
				planLines.push(`- **${fileName}**: ${p.dates.length} date(s) [${p.dates[0]} \u2192 ${p.dates[p.dates.length - 1]}]`);
			}
			planLines.push("");
			planLines.push(`**Total:** ${totalCalls} LLM call(s) using ${target0.model}`);
			planLines.push(`**Estimated cost:** ${costEstimate}`);

			ctx.ui.notify(planLines.join("\n"), "info");

			const proceed = await ctx.ui.confirm(
				"Run backfill?",
				`This will make ${totalCalls} LLM calls (~${costEstimate}). No files will be modified — only stats history is updated.`,
			);

			if (!proceed) {
				ctx.ui.notify("Backfill cancelled.", "info");
				return;
			}

			let completed = 0;
			let failed = 0;
			const updatedHistory = loadHistory();

			for (const p of plan) {
				const fileName = targetLabel(p.target.path);

				for (const date of p.dates) {
					ctx.ui.notify(`[${completed + failed + 1}/${totalCalls}] ${fileName} — ${date}...`, "info");

					const transcriptResult = await collectTranscriptsForDate(date, p.target.maxSessionBytes);

					if (!transcriptResult.transcripts || transcriptResult.includedCount === 0) {
						ctx.ui.notify(`  ${date}: no substantive sessions, skipping`, "info");
						failed++;
						continue;
					}

					const notify: NotifyFn = (msg, level) => {
						ctx.ui.notify(`  ${date}: ${msg}`, level);
					};

					const run = await runReflection(p.target, modelRegistryRef, notify, undefined, {
						sourceDateOverride: date,
						transcriptsOverride: transcriptResult,
						dryRun: true,
					});

					if (run) {
						updatedHistory.push(run);
						saveHistory(updatedHistory);
						completed++;
					} else {
						failed++;
					}
				}
			}

			ctx.ui.notify(
				`Backfill complete: ${completed} succeeded, ${failed} skipped/failed out of ${totalCalls} dates.`,
				completed > 0 ? "info" : "warning",
			);
		},
	});
}
