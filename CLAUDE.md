# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Squoosh is a client-side image compression PWA. All compression happens locally in the browser using WebAssembly codecs (no server upload). The UI is built with Preact, and encode/decode/processing work runs in Web Workers off the main thread.

Node 20.16.0 is expected (see `.nvmrc`).

## Commands

- `npm install` — install dependencies.
- `npm run build` — full production build via Rollup, then `lib/move-output.js` moves `.tmp/build/static` to `build/`. This is the only step CI runs (`.github/workflows/node.js.yml`, on Ubuntu + Windows).
- `npm run dev` — Rollup watch + a static server on `http://localhost:5000` (`run-p watch serve`). Serves `.tmp/build/static` (which `watch` regenerates live), using `serve.json` for the COOP/COEP headers that `SharedArrayBuffer`/multithreaded WASM need. To change the port, edit the `--listen` flag in the `serve` script.
- `npm run watch` — Rollup watch only (no server).
- `npm run debug` — run the Rollup build under the Node inspector.
- `npm run app:dev` — run the native desktop app (Tauri) against the live dev server.
- `npm run app:build` — build native desktop installers for the current OS.

There is no test runner and no separate lint script; `lint-staged` + Husky run `prettier` (and `clang-format`/`rustfmt` for codec sources) on staged files at commit time. Type checking happens as part of the Rollup build via `lib/simple-ts.js`.

## Desktop app (Tauri)

`src-tauri/` wraps the same web build in a native window via Tauri v2 (requires Rust/Cargo). `tauri.conf.json` points `frontendDist` at `../build` and `devUrl` at `http://localhost:5000`; `beforeBuildCommand`/`beforeDevCommand` invoke `npm run build`/`npm run dev`, so the desktop app and web app are the exact same frontend. The Tauri config re-declares the COOP/COEP headers under `app.security.headers` (the web server's `serve.json` doesn't apply inside Tauri) — these are required for `SharedArrayBuffer`/multithreaded WASM codecs.

macOS binaries **cannot** be cross-compiled from Windows/Linux — each OS builds on its own runner. `.github/workflows/tauri-build.yml` builds Windows + macOS (universal) installers on a tag push (`v*`) and attaches them to a draft release.

## Architecture

### Build pipeline (custom Rollup setup)

`rollup.config.js` orchestrates a two-stage build with many custom plugins in `lib/`:

1. The outer bundle prerenders the app to static HTML using `src/static-build/index.tsx` (run at build time via `runScript`). `__PRERENDER__` and `__PRODUCTION__` are compile-time `replace` flags.
2. `clientBundlePlugin` produces the actual browser bundle (AMD format), using `@surma/rollup-plugin-off-main-thread` (OMT) so worker code bundles correctly.
3. `resolveDirsPlugin` sets up bare-specifier imports for top-level source dirs (`client`, `shared`, `features`, `codecs`, etc.) — that's why imports look like `from 'features/worker-utils'` or `from 'codecs/mozjpeg/enc/mozjpeg_enc'` rather than relative paths.

Custom import prefixes handled by `lib/` plugins: `add-css:` / `.css` imports (`css-plugin`, PostCSS modules), `omt:` (worker entry, `worker-bridge`), `url:` (`url-plugin`), data URLs (`data-url-plugin`), service worker (`sw-plugin`).

### The feature system (most important concept)

**`lib/feature-plugin.js` autogenerates code at build start — do not hand-edit the generated files.** It scans the `src/features/` tree and generates:

- `src/features-worker/index.ts` — the worker entry that `expose`s every feature via Comlink.
- `src/client/lazy-app/worker-bridge/meta.ts` — typed client-side method names/signatures.
- `src/client/lazy-app/feature-meta/index.ts` — `encoderMap`, `EncoderState`, `ProcessorState`, `PreprocessorState`, and their defaults, aggregated from every feature's `shared/meta.ts`.

Each feature under `src/features/{encoders,decoders,processors,preprocessors}/<name>/` follows a fixed folder convention that the generator relies on:

- `shared/meta.ts` — `label`, `mimeType`, `extension`, `defaultOptions`, and the `EncodeOptions`/`Options` types. Runs on both client and worker.
- `worker/<name>Encode.ts` (etc.) — the actual work; a default-exported function. Loads the WASM codec via `initEmscriptenModule` (`src/features/worker-utils`) and runs it. These run inside the worker.
- `client/index.tsx` — exports an `encode(signal, workerBridge, imageData, options)` wrapper that calls the bridge, plus a Preact `Options` component for the UI.

To add a codec/processor, create this folder structure; the generator wires it into the worker, the bridge, and the UI automatically.

### Client ↔ worker flow

`src/client/lazy-app/worker-bridge/index.ts` is a `WorkerBridge` class whose methods (named per `meta.ts`) are dynamically attached. Each call: serializes onto an internal promise queue, lazily spawns the worker, forwards to the Comlink-wrapped worker API, supports `AbortSignal` cancellation (aborting terminates the worker), and terminates the worker after 10s idle.

`src/client/lazy-app/Compress/index.tsx` is the core UI/state controller. It holds the source image plus a two-sided (`[Side, Side]`) comparison state and drives the pipeline: decode → preprocess (e.g. rotate) → process (resize/quantize) → encode, each step going through the worker bridge. Decoding prefers the browser's built-in decoders and falls back to WASM decoders (`avif`/`webp`/`jxl`/`wp2`/`qoi`) when the browser can't handle the type. `ResultCache` avoids re-encoding identical settings.

The app is split into `initial-app` (loaded immediately) and `lazy-app` (the `Compress` experience, lazy-loaded) under `src/client/`.

### WASM codecs (`codecs/`)

`codecs/` is a set of self-contained C/C++/Rust sub-projects (mozjpeg, webp, avif, jxl, wp2, oxipng, imagequant, resize, rotate, etc.), each built with Emscripten/wasm-bindgen via its own `Makefile`/`build.sh`/`Dockerfile`. The committed `.js`/`.wasm` artifacts (e.g. `codecs/mozjpeg/enc/mozjpeg_enc.js`) are what the app imports — rebuilding a codec requires its Docker/Emscripten toolchain and is independent of the main `npm run build`. Codecs ship `_node_` variants for use outside the browser.
