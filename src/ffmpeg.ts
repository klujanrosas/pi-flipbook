/**
 * Thin async wrappers around the `ffmpeg` and `ffprobe` CLIs.
 *
 * No business logic lives here — frame selection is in `select-frames.ts` and orchestration is
 * in `index.ts`. This module only knows how to spawn the right command, parse the right line
 * out of stderr/stdout, and surface a clean error/result.
 *
 * All commands are spawned with an optional `AbortSignal` so the agent can cancel mid-extraction
 * (e.g. user hits Ctrl+C during a turn).
 */

import { spawn } from "node:child_process";

export interface FfmpegProbe {
	/** `true` if both `ffmpeg` and `ffprobe` resolved on PATH. */
	ok: boolean;
	/** Names of binaries that could NOT be resolved (e.g. `["ffmpeg"]`). */
	missing: readonly string[];
}

export interface RunResult {
	stdout: string;
	stderr: string;
	code: number | null;
}

/**
 * Spawn a command, collect stdout/stderr, resolve when it exits.
 * Rejects with a descriptive Error if the binary couldn't be spawned (ENOENT) or the signal
 * fires. Non-zero exit is *not* a rejection — callers decide what's fatal.
 */
function run(cmd: string, args: readonly string[], signal?: AbortSignal): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error(`${cmd}: aborted before spawn`));
			return;
		}
		let proc;
		try {
			proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
			return;
		}
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (d) => {
			stdout += d.toString("utf8");
		});
		proc.stderr?.on("data", (d) => {
			stderr += d.toString("utf8");
		});
		const onAbort = () => {
			proc.kill("SIGTERM");
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		proc.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			reject(err);
		});
		proc.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			if (signal?.aborted) {
				reject(new Error(`${cmd}: aborted`));
				return;
			}
			resolve({ stdout, stderr, code });
		});
	});
}

/**
 * Probe whether both required binaries are on `$PATH`.
 * We use `-version` (instead of `which`) so this works identically on macOS, Linux, and the
 * weird half-PATH inside `pi -e` extensions.
 */
export async function checkFfmpeg(signal?: AbortSignal): Promise<FfmpegProbe> {
	const missing: string[] = [];
	for (const bin of ["ffmpeg", "ffprobe"] as const) {
		try {
			const { code } = await run(bin, ["-version"], signal);
			if (code !== 0) missing.push(bin);
		} catch {
			missing.push(bin);
		}
	}
	return { ok: missing.length === 0, missing };
}

/**
 * Return the clip duration in seconds. Throws if ffprobe fails or returns a non-numeric value
 * (corrupt / zero-byte / non-video file).
 */
export async function probeDuration(filePath: string, signal?: AbortSignal): Promise<number> {
	const { stdout, stderr, code } = await run(
		"ffprobe",
		["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
		signal,
	);
	if (code !== 0) {
		throw new Error(`ffprobe failed (exit ${code}): ${stderr.trim() || "no output"}`);
	}
	const trimmed = stdout.trim();
	const n = Number.parseFloat(trimmed);
	if (!Number.isFinite(n) || n <= 0) {
		throw new Error(`ffprobe returned non-numeric duration: ${JSON.stringify(trimmed)}`);
	}
	return n;
}

/**
 * Run a scene-detection pass and return the timestamps of detected scene changes.
 *
 * The trick: we abuse the `null` muxer with `-f null -` to get ffmpeg to walk the whole stream
 * and emit `pts_time:<t>` lines for every frame the `select` filter passes. Then we parse those
 * timestamps from stderr.
 *
 * @param maxDuration  Hard cap on how far into the clip we look (seconds). Anything beyond is
 *                     ignored — keeps long clips cheap.
 * @param threshold    `select='gt(scene,X)'` sensitivity, 0..1. Lower = more frames kept.
 *                     0.10 is a good default for screen recordings (catches click → navigation).
 */
export async function findSceneChanges(
	filePath: string,
	maxDuration: number,
	threshold: number,
	signal?: AbortSignal,
): Promise<number[]> {
	const { stderr, code } = await run(
		"ffmpeg",
		[
			"-hide_banner",
			"-nostats",
			"-ss",
			"0",
			"-t",
			String(maxDuration),
			"-i",
			filePath,
			"-vf",
			`select='gt(scene,${threshold})',showinfo`,
			"-vsync",
			"vfr",
			"-f",
			"null",
			"-",
		],
		signal,
	);
	// ffmpeg returns 0 on success even when no frames pass the filter; non-zero is genuinely bad.
	if (code !== 0) {
		throw new Error(`ffmpeg scene-detect failed (exit ${code}): ${tailLines(stderr, 4)}`);
	}
	const ts: number[] = [];
	const re = /pts_time:([\d.]+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(stderr)) !== null) {
		const t = Number.parseFloat(m[1]);
		if (Number.isFinite(t)) ts.push(t);
	}
	// Already in stream order, but be defensive in case ffmpeg ever interleaves.
	return ts.sort((a, b) => a - b);
}

/**
 * Extract a single frame at `timestamp` seconds, scale so the longest edge ≤ `maxEdge` (preserving
 * aspect ratio + even dimensions, which JPG encoders require), encode as JPG, and write to
 * `outPath`. Throws on non-zero exit.
 *
 * `-ss` placed before `-i` does an input-side seek which is fast and accurate enough for the
 * single-frame use case (sub-keyframe accuracy isn't worth the 10x slowdown of output-side seek).
 */
export async function extractFrame(
	filePath: string,
	timestamp: number,
	outPath: string,
	maxEdge: number,
	signal?: AbortSignal,
): Promise<void> {
	// scale='if(gt(iw,ih),min(EDGE,iw),-2)':'if(gt(iw,ih),-2,min(EDGE,ih))'
	//   - landscape (iw > ih): width = min(EDGE, iw), height = -2 (auto, even).
	//   - portrait  (ih ≥ iw): height = min(EDGE, ih), width = -2 (auto, even).
	// `-2` (vs `-1`) forces the auto-computed dimension to be divisible by 2.
	const scale =
		`scale='if(gt(iw,ih),min(${maxEdge},iw),-2)':'if(gt(iw,ih),-2,min(${maxEdge},ih))'`;
	const { stderr, code } = await run(
		"ffmpeg",
		[
			"-hide_banner",
			"-nostats",
			"-loglevel",
			"error",
			"-y",
			"-ss",
			timestamp.toFixed(3),
			"-i",
			filePath,
			"-frames:v",
			"1",
			"-vf",
			scale,
			"-q:v",
			"3", // JPG quality ~85.
			outPath,
		],
		signal,
	);
	if (code !== 0) {
		throw new Error(`ffmpeg extract @${timestamp}s failed (exit ${code}): ${tailLines(stderr, 4)}`);
	}
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

function tailLines(s: string, n: number): string {
	const lines = s.split(/\r?\n/).filter(Boolean);
	return lines.slice(-n).join(" | ");
}
