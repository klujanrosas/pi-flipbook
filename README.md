# pi-flipbook

> Drop a short video into pi → the agent sees a flipbook of frames. Built for debugging UI bugs
> that happen between "I clicked" and "it navigated somewhere wrong", without manually
> screenshotting.

pi natively accepts image attachments but ignores video files — they get pasted as raw path text
and the LLM has no idea what to do. `pi-flipbook` hooks pi's `input` event, detects video paths
in your message (including macOS / iTerm drag-drop escaping and `file://` URLs), runs `ffmpeg`,
and swaps the path for a chronological batch of JPG frames. The model receives them as normal
`ImageContent` blocks — nothing model-side changes.

## What you get

- **Zero new commands.** Drag a `.mov` / `.mp4` onto the pi TUI, type your question, hit Enter.
- **Hybrid frame selection.** Scene-change detection (catches "before click" vs "after click"),
  always including the first and last frame, filled to at least 6 and capped at 12 frames per clip.
- **Token-aware defaults.** Frames are resized to 1280px on the longest edge and encoded as
  JPG q85 — a 12-frame 5s clip is roughly 17k tokens of vision input instead of 82k.
- **Soft limits.** Clips longer than 5s emit a warning and only the first 5s gets extracted;
  your message still goes through.
- **Ephemeral.** Frames live in `os.tmpdir()` only until the turn ends, then get cleaned up.

## Install

```bash
pi install npm:pi-flipbook
```

Or from git:

```bash
pi install git:github.com/klujanrosas/pi-flipbook
```

### From source (dev)

```bash
git clone https://github.com/klujanrosas/pi-flipbook.git
pi -e ~/path/to/pi-flipbook/src/index.ts
```

Or add the absolute path to the `extensions` array in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/absolute/path/to/pi-flipbook/src/index.ts"]
}
```

### Requirements

- `ffmpeg` + `ffprobe` on `$PATH`. On macOS: `brew install ffmpeg`.

## Usage

Just drag-drop. Terminal.app, iTerm2, Ghostty, and WezTerm all paste the dropped file's path
into the editor — pi-flipbook takes it from there.

```
> /Users/ken/Desktop/bug.mov what changes when I click the ✕ button?
```

After pi-flipbook runs, the model actually receives:

```
[video: bug.mov | 3.8s | 8 frames @ 0.00s, 0.42s, 0.83s, 1.67s, 2.00s, 2.50s, 3.17s, 3.75s]
what changes when I click the ✕ button?

(+ 8 image attachments)
```

### Per-video frame count

Append `frames:N` right after the path to override the default frame count for that clip:

```
> /Users/ken/Desktop/bug.mov frames:20 walk me through every state change
```

`N` is clamped to **1–32**. This overrides both the floor (6) and the cap (12) for that video
only — other clips in the same message keep the defaults.

You can also pass a video via pi's built-in `@file` CLI syntax:

```bash
pi "@~/Desktop/bug.mov what goes wrong after the click?"
```

## Configuration

MVP uses two env vars, no config file:

| Env var | Default | What |
|---|---|---|
| `PI_FLIPBOOK_MAX_FRAMES` | `12` | Hard cap on frames per clip. |
| `PI_FLIPBOOK_MAX_EDGE` | `1280` | Longest-edge pixel cap per frame (aspect-preserving). |
| `PI_FLIPBOOK_MAX_DURATION` | `5` | Soft duration cap in seconds. Longer clips get truncated with a warning. |
| `PI_FLIPBOOK_SCENE_THRESHOLD` | `0.10` | ffmpeg `select='gt(scene,X)'` sensitivity. Lower = more frames kept. |

Per-video overrides (appended after the path in your message):

| Annotation | Example | What |
|---|---|---|
| `frames:N` | `clip.mov frames:20` | Override frame count for this clip (1–32). |

## How it picks frames (hybrid strategy)

1. `ffprobe` for the duration `D`. `D = min(D, PI_FLIPBOOK_MAX_DURATION)`.
2. `ffmpeg` with `select='gt(scene,<thr>)'` → list of scene-change timestamps `S`.
3. Seed the candidate set with `{0, D − 0.05}` (always include first + last frame).
4. Union with `S`.
5. If fewer than 6 candidates, fill the largest gaps with evenly-spaced samples.
6. If more than 12 candidates, drop the scene changes closest to their neighbors (endpoints and
   widest-separated scenes always survive).
7. Extract each chosen timestamp in parallel, scaled + JPG q85.

## Token math (why we resize)

Claude vision bills ≈ `(width × height) / 750` tokens per image:

| Resolution | 1 frame | 12 frames |
|---|---|---|
| 2880 × 1800 (retina native) | ~6.9k | ~82k |
| 1920 × 1200 | ~3.1k | ~37k |
| **1280 × 800 (default)** | **~1.4k** | **~17k** |
| 960 × 600 | ~0.8k | ~9k |

## Troubleshooting

- **"pi-flipbook: ffmpeg not found on PATH"** — `brew install ffmpeg`, then restart pi.
- **"pi-flipbook: <file> is 7.3s, extracting first 5s only"** — working as intended; bump
  `PI_FLIPBOOK_MAX_DURATION` if you really want the full clip.
- **Path didn't get picked up** — quote it or use backslashes. Dropping from Finder on macOS
  usually produces one of: `/path/with\ spaces.mov`, `'/path/with spaces.mov'`, or `file:///…`.
  All three are supported.
- **Path inside a fenced code block is ignored on purpose** so documentation examples don't
  trigger extraction.

## License

MIT
