# Changelog

## 0.1.5

- Added the `network_capture` and `responses` session tools: subscribe to URL prefixes,
  navigate/interact, then poll the captured XHR/fetch response bodies. Capture reuses the
  page driver's single CDP attach (no second debugger, no focus change); the Network
  domain is enabled lazily with 64 MiB/8 MiB response buffers and disabled when the
  subscription clears.
- Records keep every response's metadata in one 500-entry window, while bodies are kept
  only for subscribed hits up to 200 records and a 16 MiB budget. Each body is capped at
  1 MiB (`body_truncated`); base64 payloads report `body_error: "binary"` instead of a
  lossy UTF-8 decode, and queued bodies report `"pending"`. Query envelopes use
  `has_more`, not `truncated`, so they cannot be confused with `body_truncated`.
- Capture state is session-private and in memory only: bodies never reach logs, evidence,
  traces or run reports, and `MaloNetworkInfo` is unchanged. A capture subsystem failure
  surfaces as `E_CAPTURE_UNAVAILABLE` (`ok: false`) instead of an empty list.

## 0.1.4

- `--mode=record` now leaves failed evidence for every pre-encode throw, including
  opening the stage. An unreachable page writes `<out>/<label>.evidence.json` with
  `status: "failed"`, `video: null`, the real Chromium code (`ERR_CONNECTION_REFUSED`),
  the failing `error.step`, the steps captured so far and any partial `artifacts`; the
  original error and exit code 2 are unchanged. Covered by
  `tests/unit/phase0-failed-evidence.test.ts`.
- `resolveTool` keeps resolving `ffmpeg`/`ffprobe` from `PATH` first and only then from
  the documented Homebrew/local directories; a real miss now throws a typed
  `DemoError` (`E_FFMPEG_MISSING`, exit 3) and the policy is unit-tested via
  `resolveToolOnPath`.

## 0.1.3

- Removed `docs/phase0-report.md`, `docs/phase1.md`, `docs/phase1b.md`: internal
  engineering reports, never linked from the README, the skill or any test.
- Removed `scripts/baseline_chrome.py`. It rebuilt a Chrome baseline from the
  author's private `~/recorder-pipe` virtualenv, so it could not run on another
  machine; `scripts/compare.cjs` still compares two recordings.

## 0.1.2

- `README.md` is English again and `README_CN.md` is its Chinese translation with
  the same section structure (install / run / scene scripts / recording and
  evidence / control API / troubleshooting / side effects / limitations). Both were
  re-checked against the current code for commands, flags, ports, paths and artifact
  names; the plugin packaging notes moved into the shared structure.
- An `assert` failure now uses the same contract as a failed `run_steps` batch:
  HTTP 200 with `result.ok: false`, per-check `expected`/`actual` on
  `result.checks` and `result.error.details.checks`, and the failure screenshot.
  Invalid arguments stay 4xx and real server failures stay 5xx. Callers that keyed
  on the old HTTP 500 must read `result.ok` instead — a 0.1.x contract change.
- App mode now leaves failed evidence when a take dies before encoding: a zero-frame
  `recordStop` (`E_RECORDER_NO_FRAMES`) and any other recorder stop failure write the
  take's `.evidence.json` with `status: "failed"`, `video: null`, `error.code` and
  `error.message` instead of only logging a line, matching `--mode=record`. Exit
  codes and control-API errors are unchanged.

## 0.1.1

- A failed step keeps one error-code prefix: `E_SELECTOR_NOT_FOUND: 找不到元素
  #m` instead of `E_SELECTOR_NOT_FOUND: E_SELECTOR_NOT_FOUND: ...` in stderr,
  the run snapshot and evidence step details.
- An autorun take that fails on a step now stops the recorder and writes
  failed evidence with the real cause, instead of exiting 2 with no artifact.
- Evidence no longer says `passed` for a run with a failed step: it records
  `status: failed`, the run error and `video.partial`, and `recorder.stop` only
  reports `E_EVIDENCE_MISMATCH` when a recording self-check fails.
- The human-handoff toolbar no longer shrinks the page: session `width`/`height`
  are the page viewport again (a 1280x800 session rendered 1280x756 before), and
  screenshots match the requested size. `npm run smoke:toolbar` checks it.
- An invalid scene lists the actual field errors in the message instead of only
  `N error(s)`.
- A busy broker/lease port points at `--daemon-port` / `--port-min`--`--port-max`
  instead of telling the user to change `--control-port`.
- Documented the handoff toolbar, `run_steps`, the session viewport rule, the
  `overlay-before` frame and the `smoke:toolbar` / `smoke:control` scripts;
  `package.json` now declares the published `files` list.

## 0.1.0

- Scene-driven Electron stage, hidden 1920x1080@30fps recording with evidence
  files, window modes, director console and loopback control API.
- `malo-browser` agent runtime: broker daemon, port leases, isolated sessions,
  page tools, `assert`, `run_steps`, login handoff, persistent profiles.
