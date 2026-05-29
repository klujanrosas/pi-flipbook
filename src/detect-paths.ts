/**
 * Extract video-file path candidates from raw user input.
 *
 * Handles the three shapes macOS / iTerm2 / Ghostty / WezTerm emit when you drag a file onto the
 * terminal:
 *   - Unquoted, with backslash-escaped spaces:  /Users/me/Screen\ Recording.mov
 *   - Quoted (single or double):                '/Users/me/Screen Recording.mov'
 *   - file:// URL:                              file:///Users/me/Screen%20Recording.mov
 *
 * Plus:
 *   - `~/...` home-relative (expanded via `homedir()`).
 *   - Paths inside fenced or inline code blocks are ignored on purpose, so documentation
 *     examples don't trigger extraction.
 *
 * This module is deliberately filesystem-unaware: it returns string tokens and offsets; the
 * caller (index.ts) is responsible for `resolveReadPath` / `access` checks.
 */

import { homedir } from "node:os";

const VIDEO_EXTS = ["mp4", "mov", "webm", "mkv", "avi", "m4v"] as const;
const VIDEO_EXT_ALT = VIDEO_EXTS.join("|"); // "mp4|mov|webm|..."

/** Regex matching a video extension at the end of a captured group (case-insensitive). */
const EXT_RE = new RegExp(`\\.(?:${VIDEO_EXT_ALT})\\b`, "i");

export interface DetectedVideoPath {
	/** Exact substring as it appeared in the input (for splicing a replacement back in). */
	raw: string;
	/** Inclusive start offset in the original text. */
	start: number;
	/** Exclusive end offset in the original text. */
	end: number;
	/** Unquoted, unescaped, URL-decoded, `~`-expanded path. Still may be relative. */
	path: string;
	/** Per-video frame count override from a trailing `frames:N` annotation (1–32). */
	frames?: number;
}

/**
 * Find candidate video paths in `text`.
 * Matches are returned in document order and are guaranteed not to overlap.
 */
export function detectVideoPaths(text: string): DetectedVideoPath[] {
	const codeRanges = getCodeRanges(text);
	const raw: DetectedVideoPath[] = [];

	// Order matters: we try the most specific shapes first (quoted, file://) before the greedy
	// unquoted matcher, and dedupe by offset overlap afterwards.
	collectFileUrl(text, raw);
	collectQuoted(text, raw, '"');
	collectQuoted(text, raw, "'");
	collectUnquoted(text, raw);

	// Sort by start, then drop overlaps (keep first = most specific since file:// / quoted run first
	// but stable-sort puts equal-start matches in insertion order anyway).
	raw.sort((a, b) => a.start - b.start);

	const out: DetectedVideoPath[] = [];
	for (const m of raw) {
		if (inCode(m.start, codeRanges)) continue;
		const last = out[out.length - 1];
		if (last && m.start < last.end) continue;
		out.push(m);
	}
	// Extract per-video annotations (e.g. `frames:N`) trailing each path.
	for (const m of out) {
		const after = text.slice(m.end);
		const annoMatch = /^\s+frames:(\d+)/i.exec(after);
		if (annoMatch) {
			const n = Number.parseInt(annoMatch[1]!, 10);
			if (Number.isFinite(n) && n > 0) {
				m.frames = Math.min(32, Math.max(1, n));
				m.end += annoMatch[0].length;
				m.raw = text.slice(m.start, m.end);
			}
		}
	}

	return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Path extraction (one regex per shape)
// ─────────────────────────────────────────────────────────────────────────────────────────────

function collectFileUrl(text: string, out: DetectedVideoPath[]): void {
	const re = new RegExp(`\\bfile://[^\\s'"<>\`]+\\.(?:${VIDEO_EXT_ALT})\\b`, "gi");
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const raw = m[0];
		if (!raw) continue;
		let decoded: string;
		try {
			// Strip file:// prefix (file:// or file:///) then URL-decode.
			const withoutScheme = raw.replace(/^file:\/\/\/?/i, "/");
			decoded = decodeURIComponent(withoutScheme);
		} catch {
			// Malformed percent-encoding → skip this match entirely.
			continue;
		}
		out.push({
			raw,
			start: m.index,
			end: m.index + raw.length,
			path: expandTilde(decoded),
		});
	}
}

function collectQuoted(text: string, out: DetectedVideoPath[], quote: '"' | "'"): void {
	// Non-greedy body, must not contain the quote char or CR/LF, must end in a video ext.
	const re = new RegExp(`${quote}([^${quote}\\r\\n]+\\.(?:${VIDEO_EXT_ALT}))${quote}`, "gi");
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const raw = m[0];
		const inner = m[1];
		if (!raw || !inner) continue;
		out.push({
			raw,
			start: m.index,
			end: m.index + raw.length,
			path: expandTilde(inner),
		});
	}
}

function collectUnquoted(text: string, out: DetectedVideoPath[]): void {
	// An unquoted path in drag-drop form:
	//   - Starts at a whitespace boundary (or string start).
	//   - Consists of non-whitespace chars OR backslash-escaped spaces (`\ `).
	//   - Ends in a video extension followed by a hard word boundary: whitespace, EOL, or
	//     a small set of terminal punctuation (. , ; : ! ?).
	// We intentionally don't cross quotes or backticks — those are handled by collectQuoted / code ranges.
	const re = new RegExp(
		// Start boundary: beginning of string or whitespace.
		`(?:^|(?<=\\s))` +
			// Body: runs of (\ escape) or non-whitespace/non-quote chars.
			`((?:\\\\ |[^\\s'"\`])+?\\.(?:${VIDEO_EXT_ALT}))` +
			// End boundary: whitespace, EOL, or mild trailing punctuation.
			`(?=$|\\s|[.,;:!?](?:\\s|$))`,
		"gi",
	);
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const full = m[0];
		const raw = m[1];
		if (!full || !raw) continue;
		// Skip file:// URLs — those are handled authoritatively by collectFileUrl, which may
		// have deliberately rejected a malformed one (invalid percent-encoding, etc.).
		// Letting the greedy unquoted matcher resurrect them would defeat that check.
		if (/^file:\/\//i.test(raw)) continue;
		const unescaped = raw.replace(/\\ /g, " ").replace(/\\\\/g, "\\");
		out.push({
			raw,
			start: m.index + (full.length - raw.length), // m[0] may include the whitespace pre-anchor
			end: m.index + (full.length - raw.length) + raw.length,
			path: expandTilde(unescaped),
		});
	}
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Code-block detection (to avoid matching inside docs / examples)
// ─────────────────────────────────────────────────────────────────────────────────────────────

function getCodeRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];

	// Fenced: ```...``` (non-greedy, multi-line).
	const fenceRe = /```[\s\S]*?```/g;
	let m: RegExpExecArray | null;
	while ((m = fenceRe.exec(text)) !== null) {
		ranges.push([m.index, m.index + m[0].length]);
	}

	// Inline: `...` on a single line — but only outside already-captured fences.
	const inlineRe = /`[^`\r\n]+`/g;
	while ((m = inlineRe.exec(text)) !== null) {
		const start = m.index;
		const end = start + m[0].length;
		if (ranges.some(([fs, fe]) => start >= fs && end <= fe)) continue;
		ranges.push([start, end]);
	}

	return ranges;
}

function inCode(idx: number, ranges: Array<[number, number]>): boolean {
	for (const [s, e] of ranges) if (idx >= s && idx < e) return true;
	return false;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return homedir() + p.slice(1);
	return p;
}

export const VIDEO_EXTENSIONS: readonly string[] = VIDEO_EXTS;
export const VIDEO_EXTENSION_REGEX = EXT_RE;
