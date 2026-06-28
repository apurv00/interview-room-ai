import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const moduleRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Playwright-bundled Chromium is blocked by Google OAuth — use installed Chrome. */
export const QA_BROWSER_LAUNCH = {
  channel: 'chrome',
  args: ['--disable-blink-features=AutomationControlled'],
  ignoreDefaultArgs: ['--enable-automation'],
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.headless]
 * @param {string} [opts.storageStatePath]
 */
export async function launchQaBrowser(opts = {}) {
  const { headless = false, storageStatePath, allowChromiumFallback = false } = opts
  try {
    const browser = await chromium.launch({ ...QA_BROWSER_LAUNCH, headless })
    const context = await browser.newContext(
      storageStatePath ? { storageState: storageStatePath } : {},
    )
    return { browser, context, kind: 'chrome' }
  } catch (err) {
    // Headed OAuth login needs real Chrome, so by default headless callers rethrow rather
    // than silently fall back. Callers that don't need Chrome-specific behavior (e.g. an
    // API-only auth check) can opt into the bundled-Chromium fallback so headless/CI
    // containers without system Chrome still work.
    if ((headless && !allowChromiumFallback) || !String(err.message).includes('chrome')) throw err
    console.warn('Google Chrome not found — falling back to Chromium (Google OAuth may fail).')
    console.warn('Install Chrome or use: npx playwright codegen --channel=chrome --save-storage=...')
    const browser = await chromium.launch({ headless })
    const context = await browser.newContext(
      storageStatePath ? { storageState: storageStatePath } : {},
    )
    return { browser, context, kind: 'chromium' }
  }
}

/**
 * Persistent Chrome profile — log in once; cookies survive restarts.
 * @param {string} profileName e.g. 'prod' | 'local'
 */
export async function launchQaPersistentContext(profileName = 'prod') {
  const profileDir = join(moduleRoot, '.auth', `chrome-profile-${profileName}`)
  try {
    const context = await chromium.launchPersistentContext(profileDir, {
      ...QA_BROWSER_LAUNCH,
      headless: false,
      viewport: null,
    })
    return { context, profileDir, kind: 'chrome' }
  } catch (err) {
    throw new Error(
      `Could not launch Google Chrome for OAuth login. Install Chrome, then run:\n` +
        `  npx playwright codegen --channel=chrome --save-storage=modules/qa/.auth/${profileName === 'prod' ? 'prod' : 'local'}-qa.json ` +
        `https://www.interviewprep.guru/signin\n` +
        `Original error: ${err.message}`,
    )
  }
}

export function chromeProfileDir(profileName = 'prod') {
  return join(moduleRoot, '.auth', `chrome-profile-${profileName}`)
}

export function hasChromeStorageState(prod = true) {
  return existsSync(join(moduleRoot, '.auth', prod ? 'prod-qa.json' : 'local-qa.json'))
}
