import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // AWS SDK and other Node deps are kept external (not bundled) in the main process
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Two entries: index.ts is the app entry (outputs index.js, matches package.json "main"),
        // GlobalInputWorker.ts is the utilityProcess worker (outputs GlobalInputWorker.js).
        input: {
          index: resolve('src/main/index.ts'),
          GlobalInputWorker: resolve('src/main/GlobalInputWorker.ts'),
        },
      },
    },
  },
  preload: {
    // Preload scripts are kept lean — only expose the typed IPC bridge
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        // Two entry points: overlay windows (index.html) and the notch window (notch.html)
        input: {
          index: resolve('src/renderer/index.html'),
          notch: resolve('src/renderer/notch.html'),
        },
      },
    },
  }
})
