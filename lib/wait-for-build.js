/**
 * Block until the first dev build has produced `.tmp/build/static/index.html`.
 *
 * `npm run dev` runs `watch` and `serve` in parallel. `serve` would otherwise
 * bind :5000 instantly — before Rollup's first build exists — and `tauri dev`
 * (which waits only for the port to be reachable) opens its window against the
 * half-built directory, showing a 404 with no auto-reload. Gating `serve` on
 * index.html makes Tauri wait for a real build, so the window opens to the app.
 */
const fs = require('fs');
const path = require('path');

const target = path.join('.tmp', 'build', 'static', 'index.html');
const timeoutMs = 5 * 60 * 1000;
const start = Date.now();

console.log(`Waiting for first build (${target})…`);

(function check() {
  if (fs.existsSync(target)) {
    console.log('First build ready — starting server.');
    process.exit(0);
  }
  if (Date.now() - start > timeoutMs) {
    console.error(
      `wait-for-build: timed out after 5 min waiting for ${target}`,
    );
    process.exit(1);
  }
  setTimeout(check, 200);
})();
