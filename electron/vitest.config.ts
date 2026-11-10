import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Run only tests in the renderer and shared source trees.
    // The main/preload trees use Electron-only APIs that cannot run in a plain Node environment.
    include: ['src/renderer/src/__tests__/**/*.test.ts', 'src/shared/__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
