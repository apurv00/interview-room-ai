#!/usr/bin/env node
/**
 * Rebuild inject-chunk-*.txt + inject-manifest.json from qa-matrix-runner.js.
 * Run after editing modules/qa/browser/qa-matrix-runner.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bakeStrongAnswersIntoRunner } from '../modules/qa/runner/bakeRunnerStrongAnswers.mjs';
import { bakeRosterIntoRunner } from '../modules/qa/runner/bakeRosterIntoRunner.mjs';

const dir = path.join(process.cwd(), 'modules/qa/browser');
const srcPath = path.join(dir, 'qa-matrix-runner.js');
let source = bakeRosterIntoRunner(bakeStrongAnswersIntoRunner(fs.readFileSync(srcPath, 'utf8')));
fs.writeFileSync(srcPath, source, 'utf8');
let code = source;

const hashPrefix = "location.hash='mode=full&questions=3&autostart=1';\r\n";
if (!code.startsWith('location.hash')) {
  code = hashPrefix + code.replace(/^;\s*/, '');
}

code = code.replace(/\r?\n/g, '\r\n');

const splitApi = code.indexOf('\r\n  async function api(');
const splitFeedback = code.indexOf('\r\n  async function runFeedback(');
const splitMatrix = code.indexOf('\r\n  async function runMatrix() {');

if (splitApi < 0 || splitFeedback < 0 || splitMatrix < 0) {
  console.error('Split markers not found — qa-matrix-runner.js structure changed');
  process.exit(1);
}

const chunks = [
  code.slice(0, splitApi),
  code.slice(splitApi, splitFeedback),
  code.slice(splitFeedback, splitMatrix),
  code.slice(splitMatrix),
];

function bookmarkletPayload(chunk) {
  return JSON.stringify(chunk).slice(1, -1);
}

const chunkUrls = [];
for (let i = 0; i < 4; i++) {
  const url = `javascript:void(sessionStorage.setItem('qa_chunk_${i}',"${bookmarkletPayload(chunks[i])}"))`;
  fs.writeFileSync(path.join(dir, `inject-chunk-${i}.txt`), url);
  chunkUrls.push(url);
}

const loader =
  "javascript:void((()=>{let s='';for(let i=0;i<4;i++)s+=sessionStorage.getItem('qa_chunk_'+i);const el=document.createElement('script');el.textContent=s;document.documentElement.appendChild(el)})())";

const versionMatch = code.match(/HARNESS_VERSION = '([^']+)'/);
const manifest = {
  harnessVersion: versionMatch?.[1] ?? 'unknown',
  mode: 'full',
  questions: '3',
  urls: [...chunkUrls, loader],
};

fs.writeFileSync(path.join(dir, 'inject-manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`Built inject chunks (v${manifest.harnessVersion}): ${chunks.map((c) => c.length).join(', ')} bytes`);
