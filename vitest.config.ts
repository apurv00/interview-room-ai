import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
      '@modules': path.resolve(__dirname, 'modules'),
      '@customer-billing': path.resolve(
        __dirname,
        'modules/customer-billing',
      ),
      '@financial-ledger': path.resolve(
        __dirname,
        'modules/financial-ledger',
      ),
      '@payment-subscription-dunning': path.resolve(
        __dirname,
        'modules/payment-subscription-dunning',
      ),
      '@interview': path.resolve(__dirname, 'modules/interview'),
      '@learn': path.resolve(__dirname, 'modules/learn'),
      '@b2b': path.resolve(__dirname, 'modules/b2b'),
      '@cms': path.resolve(__dirname, 'modules/cms'),
      '@resume': path.resolve(__dirname, 'modules/resume'),
      '@feedback': path.resolve(__dirname, 'modules/feedback'),
      '@jobs': path.resolve(__dirname, 'modules/jobs'),
      '@payments/customer-billing-authority': path.resolve(
        __dirname,
        'modules/payments/services/customerBillingReadService.ts',
      ),
      '@payments': path.resolve(__dirname, 'modules/payments'),
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/__tests__/**/*.{test,spec}.{ts,tsx}', '**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**'],
    css: false,
  },
})
