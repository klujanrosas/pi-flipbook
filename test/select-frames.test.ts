import { expect, test } from "vitest";
import { selectTimestamps } from "../src/select-frames.ts";

test("no scene changes → falls back to min-frame evenly spaced samples, includes first + last", () => {
	const ts = selectTimestamps(5, [], { minFrames: 6, maxFrames: 12 });
	expect(ts.length).toBe(6);
	expect(ts[0]).toBe(0);
	expect(ts[ts.length - 1]!, "last frame should be near end").toBeGreaterThanOrEqual(4.9);
	// Strictly increasing.
	for (let i = 1; i < ts.length; i++) {
		expect(ts[i]!, `not strictly increasing at ${i}: ${ts}`).toBeGreaterThan(ts[i - 1]!);
	}
});

test("few scene changes (2) → scenes + endpoints + filler up to minFrames", () => {
	const ts = selectTimestamps(5, [1.5, 3.5], { minFrames: 6, maxFrames: 12 });
	expect(ts.length).toBe(6);
	expect(ts[0]).toBe(0);
	expect(ts).toContain(1.5);
	expect(ts).toContain(3.5);
	expect(ts[ts.length - 1]!).toBeGreaterThanOrEqual(4.9);
});

test("many scene changes (20) → pruned to maxFrames, endpoints preserved", () => {
	const scenes: number[] = [];
	for (let i = 1; i <= 20; i++) scenes.push(i * 0.2); // 0.2, 0.4, ..., 4.0
	const ts = selectTimestamps(5, scenes, { minFrames: 6, maxFrames: 12 });
	expect(ts.length).toBe(12);
	expect(ts[0]).toBe(0);
	expect(ts[ts.length - 1]!).toBeGreaterThanOrEqual(4.9);
});

test("sub-gap dedupe: two scenes at 1.00 and 1.01 collapse to one", () => {
	const ts = selectTimestamps(5, [1.0, 1.01, 3.0], { minFrames: 6, maxFrames: 12, minGapSeconds: 0.2 });
	const withinGap = ts.filter((t) => t >= 0.99 && t <= 1.02);
	expect(withinGap.length, `expected one frame in the 1.0–1.01 window, got ${ts}`).toBe(1);
});

test("scenes hugging the endpoints are dropped (would collide with first/last)", () => {
	const ts = selectTimestamps(5, [0.05, 2.5, 4.99], { minFrames: 6, maxFrames: 12, minGapSeconds: 0.2 });
	// 0.05 and 4.99 are inside the endpoint exclusion zone and shouldn't survive.
	expect(ts).not.toContain(0.05);
	expect(ts).not.toContain(4.99);
	expect(ts).toContain(2.5);
	expect(ts[0]).toBe(0);
});

test("very short clip (0.3s) stays coherent — no negative / duplicate timestamps", () => {
	const ts = selectTimestamps(0.3, [0.1, 0.2], { minFrames: 6, maxFrames: 12 });
	expect(ts.length).toBeGreaterThanOrEqual(1);
	expect(ts[0]).toBe(0);
	for (const t of ts) {
		expect(t).toBeGreaterThanOrEqual(0);
		expect(t).toBeLessThanOrEqual(0.3);
	}
	// All strictly increasing.
	for (let i = 1; i < ts.length; i++) {
		expect(ts[i]!).toBeGreaterThan(ts[i - 1]!);
	}
});

test("zero / invalid duration → single frame at 0", () => {
	expect(selectTimestamps(0, [1, 2])).toEqual([0]);
	expect(selectTimestamps(-5, [1, 2])).toEqual([0]);
	expect(selectTimestamps(NaN, [])).toEqual([0]);
});

test("timestamps are rounded to millisecond precision", () => {
	const ts = selectTimestamps(5, [1.23456789, 3.14159265]);
	for (const t of ts) {
		// Must have no more than 3 decimal digits.
		const frac = t.toString().split(".")[1] ?? "";
		expect(frac.length, `timestamp ${t} has more than 3 decimal places`).toBeLessThanOrEqual(3);
	}
});

test("minFrames=2 only requires endpoints — no filler needed", () => {
	const ts = selectTimestamps(5, [], { minFrames: 2, maxFrames: 12 });
	expect(ts.length).toBe(2);
	expect(ts[0]).toBe(0);
	expect(ts[1]!).toBeGreaterThanOrEqual(4.9);
});

test("is idempotent when already at exactly minFrames", () => {
	const ts = selectTimestamps(5, [1, 2, 3, 4], { minFrames: 6, maxFrames: 12 });
	// Seeded with [0, 4.95] + 4 scenes = 6 total. No filler, no pruning needed.
	expect(ts.length).toBe(6);
});
