import { test, expect } from "vitest";
import { homedir } from "node:os";
import { detectVideoPaths } from "./detect-paths.ts";

test("detects a bare macOS drag-drop path with backslash-escaped spaces", () => {
	const text = "/Users/me/Desktop/Screen\\ Recording\\ 2024-01-02\\ at\\ 10.00.00.mov what changed?";
	const [m, ...rest] = detectVideoPaths(text);
	expect(rest.length).toBe(0);
	expect(m.raw).toBe("/Users/me/Desktop/Screen\\ Recording\\ 2024-01-02\\ at\\ 10.00.00.mov");
	expect(m.path).toBe("/Users/me/Desktop/Screen Recording 2024-01-02 at 10.00.00.mov");
	expect(text.slice(m.start, m.end)).toBe(m.raw);
});

test("detects a double-quoted path with spaces", () => {
	const text = 'look at "/tmp/bug recording.mov" please';
	const [m, ...rest] = detectVideoPaths(text);
	expect(rest.length).toBe(0);
	expect(m.raw).toBe('"/tmp/bug recording.mov"');
	expect(m.path).toBe("/tmp/bug recording.mov");
});

test("detects a single-quoted path (iTerm2 style drag-drop)", () => {
	const text = "here: '/Users/me/Movies/clip one.mov' thanks";
	const [m, ...rest] = detectVideoPaths(text);
	expect(rest.length).toBe(0);
	expect(m.raw).toBe("'/Users/me/Movies/clip one.mov'");
	expect(m.path).toBe("/Users/me/Movies/clip one.mov");
});

test("detects a file:// URL and URL-decodes percent-encoding", () => {
	const text = "file:///Users/me/Desktop/Screen%20Recording.mov is broken";
	const [m, ...rest] = detectVideoPaths(text);
	expect(rest.length).toBe(0);
	expect(m.raw).toBe("file:///Users/me/Desktop/Screen%20Recording.mov");
	expect(m.path).toBe("/Users/me/Desktop/Screen Recording.mov");
});

test("expands ~ to the user's home directory", () => {
	const text = "~/Desktop/foo.mp4";
	const [m] = detectVideoPaths(text);
	expect(m.path).toBe(`${homedir()}/Desktop/foo.mp4`);
});

test("finds multiple videos in one message, in document order", () => {
	const text = 'first "/tmp/a.mov" then /tmp/b.mp4 and "/tmp/c.webm" done';
	const results = detectVideoPaths(text);
	expect(results.length).toBe(3);
	expect(results.map((r) => r.path)).toEqual(["/tmp/a.mov", "/tmp/b.mp4", "/tmp/c.webm"]);
	// Offsets must be strictly increasing and non-overlapping.
	for (let i = 1; i < results.length; i++) {
		expect(results[i].start, `match ${i} overlaps match ${i - 1}`).toBeGreaterThanOrEqual(
			results[i - 1].end,
		);
	}
});

test("does NOT match non-video extensions (images, audio, etc.)", () => {
	const samples = [
		"/tmp/shot.png what is this",
		"look at /tmp/song.mp3",
		"/tmp/image.gif",
		"/tmp/notes.txt",
	];
	for (const text of samples) {
		expect(detectVideoPaths(text), `unexpected match in: ${text}`).toEqual([]);
	}
});

test("ignores paths inside fenced code blocks", () => {
	const text = [
		"here is how you run it:",
		"```",
		"ffmpeg -i /tmp/example.mov -vf scene",
		"```",
		"but please analyze /tmp/real.mov",
	].join("\n");
	const results = detectVideoPaths(text);
	expect(results.length).toBe(1);
	expect(results[0].path).toBe("/tmp/real.mov");
});

test("ignores paths inside inline code (single backticks)", () => {
	const text = "I tried `/tmp/ignored.mov` but /tmp/checkthis.mov is the real one";
	const results = detectVideoPaths(text);
	expect(results.length).toBe(1);
	expect(results[0].path).toBe("/tmp/checkthis.mov");
});

test("handles all supported extensions", () => {
	const exts = ["mp4", "mov", "webm", "mkv", "avi", "m4v"];
	for (const ext of exts) {
		const [m] = detectVideoPaths(`/tmp/vid.${ext}`);
		expect(m, `failed to match .${ext}`).toBeTruthy();
		expect(m.path).toBe(`/tmp/vid.${ext}`);
	}
});

test("is case-insensitive on the extension", () => {
	const [m] = detectVideoPaths("/tmp/UPPER.MOV check this");
	expect(m).toBeTruthy();
	expect(m.path).toBe("/tmp/UPPER.MOV");
});

test("skips malformed percent-encoding in file:// URLs (doesn't throw)", () => {
	// %ZZ is invalid percent-encoding; decodeURIComponent would throw — we catch and skip.
	const text = "file:///tmp/broken%ZZ.mov";
	const results = detectVideoPaths(text);
	expect(results).toEqual([]);
});

test("does not match inside a longer word (e.g. .mp4extra)", () => {
	// The trailing extension must be followed by a word boundary / whitespace / mild punctuation.
	const text = "/tmp/video.mp4extra and /tmp/real.mp4.";
	const results = detectVideoPaths(text);
	expect(results.length).toBe(1);
	expect(results[0].path).toBe("/tmp/real.mp4");
});

test("start/end offsets correctly locate the raw token for splicing", () => {
	const prefix = "hey look here: ";
	const raw = "/tmp/clip.mov";
	const suffix = " thanks";
	const text = prefix + raw + suffix;
	const [m] = detectVideoPaths(text);
	expect(m.start).toBe(prefix.length);
	expect(m.end).toBe(prefix.length + raw.length);
	expect(text.slice(m.start, m.end)).toBe(raw);

	// Splice-replace must produce a clean result.
	const replaced = text.slice(0, m.start) + "[video]" + text.slice(m.end);
	expect(replaced).toBe("hey look here: [video] thanks");
});
