/**
 * Pure function: given a clip duration and a list of scene-change timestamps, pick the final
 * timestamps to extract frames at.
 *
 * Hybrid strategy:
 *   1. Always include the first frame (t=0) and the last frame (t ≈ duration).
 *   2. Union with detected scene-change timestamps.
 *   3. If we have fewer than `minFrames` total, fill the largest gaps with evenly-spaced samples.
 *   4. If we have more than `maxFrames` total, drop the scene frames whose closest neighbor is
 *      nearest (keep endpoints and widest-separated scene changes).
 *
 * No I/O, no ffmpeg — makes this trivially unit-testable.
 */

export interface SelectFramesOptions {
	/** Hard lower bound on total frames (seeded with first + last + scenes, then filled). */
	minFrames?: number;
	/** Hard upper bound on total frames (scene frames pruned to fit). */
	maxFrames?: number;
	/** Timestamps closer together than this are treated as duplicates (seconds). */
	minGapSeconds?: number;
}

const DEFAULTS: Required<SelectFramesOptions> = {
	minFrames: 6,
	maxFrames: 12,
	minGapSeconds: 0.2,
};

export function selectTimestamps(
	duration: number,
	sceneTimestamps: readonly number[],
	opts: SelectFramesOptions = {},
): number[] {
	const { minFrames, maxFrames, minGapSeconds } = { ...DEFAULTS, ...opts };

	if (!Number.isFinite(duration) || duration <= 0) {
		return [0];
	}

	// Last frame is slightly before duration to avoid ffmpeg seeking past EOF on some containers.
	const last = Math.max(0, duration - 0.05);

	// Seed: first + last (deduped if clip is tiny).
	const seed = last > minGapSeconds ? [0, last] : [0];

	// Union with scenes that are within the clip and not hugging the endpoints.
	const inRangeScenes = sceneTimestamps
		.filter((t) => t > minGapSeconds && t < last - minGapSeconds)
		.sort((a, b) => a - b);

	let candidates = dedupeSorted(
		[...seed, ...inRangeScenes].sort((a, b) => a - b),
		minGapSeconds,
	);

	// Fill gaps if under minFrames.
	while (candidates.length < minFrames && candidates.length < maxFrames) {
		const insert = findLargestGapMidpoint(candidates);
		if (insert === null) break;
		const prev = candidates.length;
		candidates = dedupeSorted(
			[...candidates, insert].sort((a, b) => a - b),
			minGapSeconds,
		);
		// If the midpoint was deduped (too close to an existing candidate), no progress is
		// possible — bail out to avoid an infinite loop on very short clips.
		if (candidates.length <= prev) break;
	}

	// Prune if over maxFrames — always preserve first (index 0) and last (last index).
	while (candidates.length > maxFrames) {
		const dropIdx = findNearestInteriorIndex(candidates);
		if (dropIdx === -1) break;
		candidates.splice(dropIdx, 1);
	}

	return candidates.map(round3);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────

function dedupeSorted(xs: number[], minGap: number): number[] {
	if (xs.length === 0) return xs;
	const first = xs[0]!;
	const out = [first];
	for (let i = 1; i < xs.length; i++) {
		if (xs[i]! - out[out.length - 1]! >= minGap) out.push(xs[i]!);
	}
	return out;
}

function findLargestGapMidpoint(xs: number[]): number | null {
	if (xs.length < 2) return null;
	let bestGap = 0;
	let bestMid: number | null = null;
	for (let i = 1; i < xs.length; i++) {
		const gap = xs[i]! - xs[i - 1]!;
		if (gap > bestGap) {
			bestGap = gap;
			bestMid = (xs[i - 1]! + xs[i]!) / 2;
		}
	}
	return bestMid;
}

/**
 * Among interior candidates (not first, not last), return the index of the one whose closer
 * neighbor is nearest — i.e., the most "redundant" point. Returns -1 if no interior exists.
 */
function findNearestInteriorIndex(xs: number[]): number {
	if (xs.length < 3) return -1;
	let bestIdx = -1;
	let bestNearest = Infinity;
	for (let i = 1; i < xs.length - 1; i++) {
		const nearest = Math.min(xs[i]! - xs[i - 1]!, xs[i + 1]! - xs[i]!);
		if (nearest < bestNearest) {
			bestNearest = nearest;
			bestIdx = i;
		}
	}
	return bestIdx;
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}
