// Isolated build config for the uiohook-napi utilityProcess smoke test.
// Produces output in out-smoke/main/ so it never touches the production out/ directory.
// This file and its outputs are temporary — delete after the smoke test completes.
//
// Build:   cd electron && npx electron-vite build --config electron.vite.smoke.config.ts
// Run:     npx electron out-smoke/main/smokeMain.js
// Cleanup: rm this file, rm src/main/smokeMain.ts, rm src/main/smokeTestWorker.ts, rm -rf out-smoke/

import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // Explicit absolute outDir so this never overlaps with the production out/ directory.
      // 'out-smoke/main' is the FINAL path — electron-vite 2.3.0 uses an explicit section-level
      // outDir as-is and does NOT append '/main' again (unlike the global --outDir CLI flag which
      // does append the target subdirectory). Output: out-smoke/main/smokeMain.js ✓
      outDir: resolve('out-smoke/main'),
      rollupOptions: {
        input: {
          smokeMain:       resolve('src/main/smokeMain.ts'),
          smokeTestWorker: resolve('src/main/smokeTestWorker.ts'),
        },
      },
    },
  },
  // renderer and preload are intentionally omitted — the smoke test is main-process only
})
