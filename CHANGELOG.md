# Changelog

All notable changes to `pi-flipbook` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-27

### Added
- `input` hook: detect video file paths in user messages (drag-drop, quoted,
  `file://` URLs, `~/` paths), extract frames via `ffmpeg`, and replace the
  path with a chronological flipbook of JPG `ImageContent` attachments.
- Hybrid frame selection: scene-change detection (`select='gt(scene,X)'`)
  seeded with first + last frame, filled to 6 minimum, capped at 12 maximum.
- Token-aware defaults: frames resized to 1280px longest edge, JPG q85 —
  a 12-frame 5s clip ≈ 17k vision tokens instead of 82k at retina native.
- Soft duration cap (5s default): longer clips are truncated with a warning;
  the message still goes through.
- Ephemeral frame storage: tmpdir cleaned up on `turn_end`.
- `session_start` ffmpeg/ffprobe PATH check with friendly notify on missing.
- Soft failure policy: any error (missing ffmpeg, file not found, corrupt
  clip) emits a notification and falls through with the message unchanged.
- Environment variable configuration: `PI_FLIPBOOK_MAX_FRAMES`,
  `PI_FLIPBOOK_MAX_EDGE`, `PI_FLIPBOOK_MAX_DURATION`,
  `PI_FLIPBOOK_SCENE_THRESHOLD`.
- Full path detection for macOS terminal drag-drop variants: backslash-escaped
  spaces, single/double-quoted, `file://` URLs with percent-encoding.
- Code-block exclusion: paths inside fenced or inline code are ignored.
- Unit test suites for path detection and frame timestamp selection.
