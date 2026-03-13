import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      '@shared': path.resolve(__dirname, 'shared'),
      '@modules': path.resolve(__dirname, 'modules'),
      '@interview': path.resolve(__dirname, 'modules/interview'),
      '@learn': path.resolve(__dirname, 'modules/learn'),
      '@b2b': path.resolve(__dirname, 'modules/b2b'),
      '@cms': path.resolve(__dirname, 'modules/cms'),
      '@resume': path.resolve(__dirname, 'modules/resume'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/__tests__/**/*.{test,spec}.{ts,tsx}', '**/*.{test,spec}.{ts,tsx}'],
    css: false,
  },
})
