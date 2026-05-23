#!/usr/bin/env node
/**
 * Build chunked javascript: URLs for injecting QA runner into logged-in Cursor browser.
 * Avoids Playwright and cookie export. Chunks stored in sessionStorage then eval'd.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const runner = readFileSync(join(root, 'modules/qa/browser/inPageRunner.js'), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

const args = process.argv.slice(2)
const mode = args.includes('--full') ? 'full' : 'smoke'
const qIdx = args.indexOf('--questions')
const questions = qIdx >= 0 ? args[qIdx + 1] : '3'

const prefix = `location.hash='mode=${mode}&questions=${questions}&autostart=1';`
const payload = prefix + runner
const CHUNK = 3500
const chunks = []
for (let i = 0; i < payload.length; i += CHUNK) {
  chunks.push(payload.slice(i, i + CHUNK))
}

const urls = chunks.map((c, i) =>
  `javascript:void(sessionStorage.setItem('qa_chunk_${i}',${JSON.stringify(c)}))`,
)
urls.push(
  `javascript:void((()=>{let s='';for(let i=0;i<${chunks.length};i++)s+=sessionStorage.getItem('qa_chunk_'+i);const el=document.createElement('script');el.textContent=s;document.documentElement.appendChild(el)})())`,
)

const outDir = join(root, 'modules/qa/browser')
mkdirSync(outDir, { recursive: true })
const manifest = join(outDir, 'inject-manifest.json')
writeFileSync(manifest, JSON.stringify({ mode, questions, urls }, null, 2), 'utf-8')
console.log(`Mode: ${mode}, questions: ${questions}, chunks: ${chunks.length}, navigations: ${urls.length}`)
console.log(`Written: ${manifest}`)
