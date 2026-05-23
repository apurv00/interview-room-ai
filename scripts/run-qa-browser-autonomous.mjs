#!/usr/bin/env node
/**
 * Autonomous QA matrix via Cursor browser session on production.
 * Loads runner from GitHub raw (after push) — no Playwright, no cookie export.
 *
 * Usage: node scripts/run-qa-browser-autonomous.mjs --full --questions 3
 * Prints the javascript: bootstrap URL for Cursor browser navigate.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const mode = args.includes('--full') ? 'full' : args.includes('--smoke') ? 'smoke' : 'smoke'
const qIdx = args.indexOf('--questions')
const questions = qIdx >= 0 ? args[qIdx + 1] : '3'
const branch = process.env.QA_GITHUB_BRANCH || 'fix/uat-waves-1-4'
const runnerUrl = `https://raw.githubusercontent.com/apurv00/interview-room-ai/${branch}/public/qa-matrix-runner.js`

const bootstrap = `javascript:void((()=>{location.hash='mode=${mode}&questions=${questions}&autostart=1';const s=document.createElement('script');s.src='${runnerUrl}';s.onerror=()=>document.title='QA_LOAD_FAILED';document.head.appendChild(s)})())`

const out = join(root, 'modules/qa/browser/bootstrap-url.txt')
import { writeFileSync } from 'fs'
writeFileSync(out, bootstrap, 'utf-8')
console.log('Bootstrap URL written:', out)
console.log('Mode:', mode, 'questions:', questions)
console.log('Runner:', runnerUrl)
console.log('Length:', bootstrap.length)
