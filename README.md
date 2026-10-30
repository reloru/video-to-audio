# Video to Audio

A mobile-first web app that pulls the audio out of videos as **M4A**, **MP3** or **WAV**.
All processing happens in the browser, on the device: files are never uploaded.

Live: <https://video-to-audio.reloru.workers.dev> (installable to the iPhone home screen and
usable offline after the first visit).

## What each format does

The video stream (HEVC, H.264, HDR10, …) is never decoded, so its codec doesn't matter.
Only the selected audio track is read.

| Output | From AAC (iPhone recordings, most MP4/MOV) | Notes |
| --- | --- | --- |
| M4A | Exact copy of the AAC packets, edit list included | Bit-identical audio. ALAC sources are copied too; other codecs become Apple Lossless. |
| WAV | Decoded once to PCM | 24-bit by default (lossless sources keep their own depth); 16-bit (TPDF-dithered) and 32-bit float are options. Trimmed to the length the container declares, so encoder priming/padding is removed. |
| MP3 | Encoded with LAME 3.100 | 320 kbps CBR (or VBR V0), LAME `-q 2`. Rates MP3 players don't universally support are resampled to 44.1/48 kHz; more than two channels are downmixed. |

Metadata is stripped: container tags (title, date, location, `udta`/`meta`/`ilst`,
QuickTime keys), chapters and encoder stamps. What players need stays: the M4A edit list
that hides encoder priming, and the MP3 LAME/Info header used for gapless playback.

## How it works

- `core/` builds the FFmpeg command-line tool to WebAssembly with only audio components
  (demuxers for MOV/MP4/MKV/WebM/AVI/TS/…, AAC/ALAC/PCM/MP3/Opus/AC-3/… decoders, LAME,
  ALAC and PCM encoders). The result is 2.6 MB (1.3 MB compressed), versus ~32 MB for the
  stock ffmpeg.wasm core.
- `core/probe.c` adds a `probe()` export that describes a file's streams as JSON.
- `core/patches/` holds one FFmpeg patch: the MP4 muxer otherwise always writes an empty
  iTunes metadata box (`udta/meta/ilst`).
- `src/lib/plan.ts` decides how each output is produced and builds the ffmpeg arguments.
- `src/engine/` runs ffmpeg in a Web Worker. The picked file is mounted without copying
  (with read-ahead, since each synchronous Blob read costs ~1.5 ms), and outputs are written
  straight to the Origin Private File System, so large WAVs don't have to fit in memory.
  Private browsing in Safari has no OPFS; outputs then stay in memory.
- `src/app/` is the Preact UI.

## Run locally

Requires Node 22+. Tests also need native `ffmpeg`/`ffprobe` on `PATH` (they are the
independent reference outputs are checked against).

```sh
npm install
npm run dev          # http://localhost:5173
npm run typecheck
npm test             # planner unit tests + the wasm core against native ffmpeg
npm run build
npm run test:e2e     # Playwright: WebKit (iPhone profile) and Chromium (Android profile)
```

`npm run check` runs all of the above in order.

## Rebuilding the converter

`core/dist/` is committed so normal builds don't need Emscripten. To rebuild it:

```sh
npm run build:core   # core/build.sh; work files go to .core-build/
```

The script pins Emscripten 3.1.40, FFmpeg n5.1.4, LAME 3.100 (sha256-checked) and the
ffmpeg.wasm v0.12.10 fftools, and writes `core/dist/BUILD-INFO.txt` with the resulting hashes.
No absolute paths end up in the binary, so rebuilding gives byte-identical files regardless of
the work directory (checked with two separate from-scratch work directories).
Test fixtures are regenerated with `npm run fixtures` (needs ffmpeg with libx264, libx265, libopus).

## Deployment

GitHub Actions (`.github/workflows/ci.yml`) runs typecheck, unit/core tests, the build,
both browser test suites and a Wrangler dry run on every push and pull request. On `main` it
then deploys the tested `dist/` as a static-assets-only Cloudflare Worker (`wrangler.jsonc`)
and checks that the live `sw.js` matches the build. Required secrets: `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`.

## Third-party code

The compiled converter in `core/dist/` contains:

- [FFmpeg](https://ffmpeg.org) n5.1.4, LGPL-2.1-or-later, with the patch in `core/patches/`
- [LAME](https://lame.sourceforge.io) 3.100, LGPL-2.0-or-later
- fftools glue from [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) v0.12.10 (MIT bindings around FFmpeg's LGPL fftools)
- The [Emscripten](https://emscripten.org) runtime, MIT

`core/build.sh` fetches those exact sources and rebuilds the binary. No GPL components are enabled.
The rest of this repository is MIT licensed (see `LICENSE`).
