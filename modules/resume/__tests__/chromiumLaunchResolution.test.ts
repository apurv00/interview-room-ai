import { describe, it, expect, vi } from 'vitest'

import { resolveChromiumLaunch } from '../services/pdfService'

// Migration guard (Vercel → arm64 self-host): CHROMIUM_PATH must win over
// @sparticuz/chromium outright. The old catch-based fallback never engaged on
// arm64 because sparticuz require()s and extracts cleanly there — its x86_64
// binary only fails later, inside puppeteer.launch().
describe('resolveChromiumLaunch', () => {
  it('uses CHROMIUM_PATH when set and never consults @sparticuz/chromium', async () => {
    const loadSparticuz = vi.fn()

    const result = await resolveChromiumLaunch(
      { CHROMIUM_PATH: '/usr/bin/chromium-browser' },
      loadSparticuz,
    )

    expect(result.executablePath).toBe('/usr/bin/chromium-browser')
    expect(result.args).toContain('--no-sandbox')
    expect(result.args).toContain('--disable-dev-shm-usage')
    expect(loadSparticuz).not.toHaveBeenCalled()
  })

  it('resolves via @sparticuz/chromium when CHROMIUM_PATH is unset', async () => {
    const loadSparticuz = vi.fn(() => ({
      args: ['--flag-from-sparticuz'],
      executablePath: async () => '/tmp/sparticuz/chromium',
    }))

    const result = await resolveChromiumLaunch({}, loadSparticuz)

    expect(result.executablePath).toBe('/tmp/sparticuz/chromium')
    expect(result.args).toEqual([
      '--flag-from-sparticuz',
      '--hide-scrollbars',
      '--disable-web-security',
    ])
  })

  it('unwraps a default-exported sparticuz module', async () => {
    const loadSparticuz = () => ({
      default: { args: ['--a'], executablePath: async () => '/tmp/x' },
    })

    const result = await resolveChromiumLaunch({}, loadSparticuz)

    expect(result.executablePath).toBe('/tmp/x')
    expect(result.args).toEqual(['--a', '--hide-scrollbars', '--disable-web-security'])
  })

  it('keeps minimal sandbox flags when sparticuz provides no args', async () => {
    const loadSparticuz = () => ({ args: [], executablePath: async () => '/tmp/y' })

    const result = await resolveChromiumLaunch({}, loadSparticuz)

    expect(result.args).toEqual(['--no-sandbox', '--disable-setuid-sandbox'])
  })

  it('propagates sparticuz failures when no CHROMIUM_PATH is configured', async () => {
    const loadSparticuz = () => {
      throw new Error('binary not bundled')
    }

    await expect(resolveChromiumLaunch({}, loadSparticuz)).rejects.toThrow(
      'binary not bundled',
    )
  })
})
