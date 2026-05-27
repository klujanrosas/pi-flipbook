/**
 * pi-flipbook — drag-and-drop short video clips into pi and the agent receives a flipbook of
 * still frames instead of a useless raw path string.
 *
 * Wiring:
 *   - `session_start`: one-shot ffmpeg PATH check, surface a friendly notify if it's missing.
 *   - `input`: detect video paths in the user's text, run ffprobe + ffmpeg, splice the path
 *     with a readable `[video: name | Ns | K frames]` tag, and append the JPG frames as
 *     ImageContent attachments.
 *   - `turn_end`: rm -rf the tmpdirs we mkdtemp'd this turn.
 *
 * Failure policy is "soft": any unrecoverable error (missing ffmpeg, file not found, corrupt
 * clip, ffmpeg crash) emits a `notify` and falls through with the message unchanged so the user
 * still gets a response from the agent.
 */

import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { isAbsolute, basename, resolve as resolvePath, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ImageContent } from "@mariozechner/pi-ai";
import { detectVideoPaths, type DetectedVideoPath } from "./detect-paths.ts";
import { selectTimestamps } from "./select-frames.ts";
import { checkFfmpeg, probeDuration, findSceneChanges, extractFrame } from "./ffmpeg.ts";

// ─── config (env vars; no config file for MVP) ───────────────────────────────────────────────

const MAX_FRAMES = clampInt(process.env.PI_FLIPBOOK_MAX_FRAMES, 12, 1, 32);
const MIN_FRAMES = Math.min(6, MAX_FRAMES);
const MAX_EDGE = clampInt(process.env.PI_FLIPBOOK_MAX_EDGE, 1280, 240, 4096);
const MAX_DURATION = clampFloat(process.env.PI_FLIPBOOK_MAX_DURATION, 5, 0.5, 60);
const SCENE_THRESHOLD = clampFloat(process.env.PI_FLIPBOOK_SCENE_THRESHOLD, 0.1, 0.01, 0.99);

export default function (pi: ExtensionAPI): void {
	/** State shared across event handlers — closed-over per extension instance. */
	let ffmpegStatus: { ok: boolean; missing: readonly string[] } | null = null;
	let warnedAboutMissing = false;
	/** Tmpdirs created this turn that need rm -rf'ing on `turn_end`. */
	const pendingCleanup = new Set<string>();

	pi.on("session_start", async (_event, ctx) => {
		ffmpegStatus = await checkFfmpeg(ctx.signal);
	});

	pi.on("input", async (event, ctx) => {
		// Don't second-guess injected/programmatic input — only humans drag videos onto the TUI.
		if (event.source === "extension") return { action: "continue" };

		const detections = detectVideoPaths(event.text);
		if (detections.length === 0) return { action: "continue" };

		// ffmpeg may not have been probed yet (e.g. first turn racing session_start), do it now.
		if (!ffmpegStatus) {
			ffmpegStatus = await checkFfmpeg(ctx.signal);
		}
		if (!ffmpegStatus.ok) {
			if (!warnedAboutMissing && ctx.hasUI) {
				ctx.ui.notify(
					`pi-flipbook: ${ffmpegStatus.missing.join(" + ")} not found on PATH — install with \`brew install ffmpeg\` and restart pi.`,
					"warning",
				);
				warnedAboutMissing = true;
			}
			return { action: "continue" };
		}

		// Process each detection in parallel — they're independent clips.
		const results = await Promise.all(
			detections.map((d) => processOne(d, ctx, pendingCleanup)),
		);

		// Splice replacements back into the original text in reverse order so earlier offsets
		// stay valid. Successful results carry a tag string; failures keep the raw token in place.
		const sortedByStartDesc = results
			.map((r, i) => ({ r, d: detections[i] }))
			.sort((a, b) => b.d.start - a.d.start);

		let newText = event.text;
		const newImages: ImageContent[] = [];
		for (const { r, d } of sortedByStartDesc) {
			if (r.kind === "ok") {
				newText = newText.slice(0, d.start) + r.tag + newText.slice(d.end);
			}
			// On failure, leave the raw path untouched — the model still sees something coherent.
		}
		// Frames must end up in chronological / document order. We collected them per-clip; flatten
		// in the original detection order (which is left-to-right in the text).
		for (const r of results) {
			if (r.kind === "ok") newImages.push(...r.images);
		}

		if (newImages.length === 0) {
			// Every detection failed → don't transform; the warnings already fired via notify.
			return { action: "continue" };
		}

		return {
			action: "transform",
			text: newText,
			images: [...(event.images ?? []), ...newImages],
		};
	});

	pi.on("turn_end", async () => {
		if (pendingCleanup.size === 0) return;
		const dirs = [...pendingCleanup];
		pendingCleanup.clear();
		await Promise.all(
			dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
		);
	});
}

// ─── per-clip pipeline ───────────────────────────────────────────────────────────────────────

type ProcessResult =
	| { kind: "ok"; tag: string; images: ImageContent[] }
	| { kind: "fail" };

async function processOne(
	d: DetectedVideoPath,
	ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
	pendingCleanup: Set<string>,
): Promise<ProcessResult> {
	const absPath = toAbsolute(d.path, ctx.cwd);
	const name = basename(absPath);

	// 1. File must exist + be readable. If not, soft-warn and pass through.
	try {
		await access(absPath);
	} catch {
		notifyIfUI(ctx, `pi-flipbook: video path looked valid but file not found: ${absPath}`, "warning");
		return { kind: "fail" };
	}

	// 2. Probe duration. Corrupt / zero-byte clips fail here.
	let duration: number;
	try {
		duration = await probeDuration(absPath, ctx.signal);
	} catch (err) {
		notifyIfUI(ctx, `pi-flipbook: could not read ${name}: ${errMsg(err)}`, "warning");
		return { kind: "fail" };
	}

	// 3. Soft duration cap.
	let effectiveDuration = duration;
	if (duration > MAX_DURATION) {
		notifyIfUI(
			ctx,
			`pi-flipbook: ${name} is ${duration.toFixed(1)}s, extracting first ${MAX_DURATION}s only.`,
			"warning",
		);
		effectiveDuration = MAX_DURATION;
	}

	// 4. Scene change pass — non-fatal if it fails (we can still do evenly-spaced).
	let scenes: number[] = [];
	try {
		scenes = await findSceneChanges(absPath, effectiveDuration, SCENE_THRESHOLD, ctx.signal);
	} catch (err) {
		notifyIfUI(ctx, `pi-flipbook: scene detection skipped for ${name}: ${errMsg(err)}`, "info");
	}

	// 5. Pick final timestamps (pure function — easy to reason about).
	const timestamps = selectTimestamps(effectiveDuration, scenes, {
		minFrames: MIN_FRAMES,
		maxFrames: MAX_FRAMES,
	});

	// 6. Extract every chosen timestamp in parallel into a fresh tmpdir.
	let tmpDir: string;
	try {
		tmpDir = await mkdtemp(join(tmpdir(), "pi-flipbook-"));
	} catch (err) {
		notifyIfUI(ctx, `pi-flipbook: could not create tmpdir: ${errMsg(err)}`, "warning");
		return { kind: "fail" };
	}
	pendingCleanup.add(tmpDir);

	let frames: ImageContent[];
	try {
		frames = await Promise.all(
			timestamps.map(async (t, i): Promise<ImageContent> => {
				const out = join(tmpDir, `frame-${String(i).padStart(2, "0")}.jpg`);
				await extractFrame(absPath, t, out, MAX_EDGE, ctx.signal);
				const buf = await readFile(out);
				return { type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" };
			}),
		);
	} catch (err) {
		notifyIfUI(ctx, `pi-flipbook: frame extraction failed for ${name}: ${errMsg(err)}`, "warning");
		return { kind: "fail" };
	}

	const tag = formatTag(name, effectiveDuration, timestamps);
	return { kind: "ok", tag, images: frames };
}

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────

function formatTag(name: string, duration: number, timestamps: readonly number[]): string {
	const stamps = timestamps.map((t) => `${t.toFixed(2)}s`).join(", ");
	return `[video: ${name} | ${duration.toFixed(1)}s | ${timestamps.length} frames @ ${stamps}]`;
}

function toAbsolute(p: string, cwd: string): string {
	// detect-paths already expanded `~`, but a relative path could still come via drag-drop on
	// some terminals. Resolve against the agent's cwd in that case.
	if (p.startsWith("~")) {
		// Belt-and-suspenders: detect-paths handles this, but in case a caller passes a raw path.
		if (p === "~") return homedir();
		if (p.startsWith("~/")) return homedir() + p.slice(1);
	}
	return isAbsolute(p) ? p : resolvePath(cwd, p);
}

function notifyIfUI(
	ctx: { hasUI: boolean; ui: { notify: (msg: string, type?: "info" | "warning" | "error") => void } },
	msg: string,
	type: "info" | "warning" | "error",
): void {
	if (ctx.hasUI) ctx.ui.notify(msg, type);
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

function clampFloat(raw: string | undefined, fallback: number, min: number, max: number): number {
	if (!raw) return fallback;
	const n = Number.parseFloat(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}
