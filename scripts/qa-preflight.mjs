#!/usr/bin/env node
/**
 * Pre-flight checks before overnight QA matrix run.
 * Usage: node scripts/qa-preflight.mjs [--prod]
 */
import fs from 'node:fs';
import path from 'node:path';
import { validateStorageState } from '../modules/qa/runner/validateAuth.mjs';
import { defaultAuthPath } from '../modules/qa/orchestrator/runManifest.mjs';
import { qaAutomationConfig, loadQaEnv } from '../modules/qa/runner/loadEnv.mjs';

loadQaEnv();

const prod = process.argv.includes('--prod');
const { secret, email } = qaAutomationConfig();
const base = prod ? 'https://www.interviewprep.guru' : 'http://localhost:3000';
const inngestBase = prod ? 'https://api.inngest.com' : 'http://127.0.0.1:8288';

const checks = [];

function pass(name, detail) {
  checks.push({ name, ok: true, detail });
  console.log(`✅ ${name}: ${detail}`);
}

function fail(name, detail) {
  checks.push({ name, ok: false, detail });
  console.error(`❌ ${name}: ${detail}`);
}

function warn(name, detail) {
  checks.push({ name, ok: true, detail, warn: true });
  console.warn(`⚠️  ${name}: ${detail}`);
}

// Harness version
const runnerPath = path.join(process.cwd(), 'modules/qa/browser/qa-matrix-runner.js');
const runner = fs.readFileSync(runnerPath, 'utf8');
const version = runner.match(/HARNESS_VERSION = '([^']+)'/)?.[1] ?? 'unknown';
if (version.startsWith('2.')) {
  pass('Harness', `v${version} (telemetry + pathway poll + strong persona)`);
} else {
  warn('Harness', `v${version} — expected v2.1.x for v3 build`);
}

if (!runner.includes("'succeeded'") || /pathwayGenerationStatus[\s\S]{0,120}'completed'/.test(runner)) {
  fail('Harness pathway poll', 'Still polling for completed instead of succeeded');
} else {
  pass('Harness pathway poll', 'Polls succeeded/failed/skipped');
}

// Manifest freshness
const manifestPath = path.join(process.cwd(), 'modules/qa/browser/inject-manifest.json');
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.harnessVersion === version) {
    pass('Inject manifest', `matches runner v${version}`);
  } else {
    fail('Inject manifest', `stale — run npm run qa:build:browser (manifest=${manifest.harnessVersion}, runner=${version})`);
  }
} else {
  fail('Inject manifest', 'missing — run npm run qa:build:browser');
}

// App health
try {
  const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10000) });
  if (res.ok) pass('App health', `${base} responded ${res.status}`);
  else fail('App health', `${base} returned ${res.status}`);
} catch (e) {
  fail('App health', `${base} unreachable (${e.message})`);
}

// Inngest function count (local dev only without signing key)
if (!prod) {
  try {
    const res = await fetch(`${inngestBase}/dev`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) pass('Inngest dev', 'dashboard reachable at :8288');
    else warn('Inngest dev', `dashboard returned ${res.status}`);
  } catch {
    warn('Inngest dev', 'not running — npm run dev:inngest (only needed for local runs)');
  }
} else {
  warn('Inngest Cloud', 'Manually verify 8 functions including pathway-regenerate in Inngest dashboard');
}

// v3 Playwright auth
const authPath = defaultAuthPath(prod);
if (secret && email) {
  pass('Playwright auth', `automation login configured (${email}) — matrix auto-authenticates`);
} else if (fs.existsSync(authPath)) {
  const v = validateStorageState(authPath);
  if (v.ok) {
    pass('Playwright auth', `${authPath} (session cookie present)`);
  } else {
    fail('Playwright auth', v.message);
    console.error('  Fix: set QA_AUTOMATION_* env vars or npm run qa:auth:import:prod');
  }
} else {
  fail('Playwright auth', 'missing — set QA_AUTOMATION_* or npm run qa:auth:automation:prod');
}

const pwRunner = path.join(process.cwd(), 'modules/qa/runner/playwrightMatrix.mjs');
if (fs.existsSync(pwRunner)) {
  pass('Playwright runner', 'playwrightMatrix.mjs ready');
} else {
  fail('Playwright runner', 'modules/qa/runner/playwrightMatrix.mjs missing');
}

console.log('\n---');
const failed = checks.filter((c) => !c.ok);
if (failed.length) {
  console.error(`${failed.length} check(s) failed — fix before starting matrix`);
  process.exit(1);
}
console.log('Pre-flight OK — v3: npm run qa:v3:matrix:prod');
