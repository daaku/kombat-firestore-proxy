import { resolve } from 'path'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    sourcemap: true,
    rollupOptions: {
      input: resolve(__dirname, 'test/index.html'),
    },
  },
})
