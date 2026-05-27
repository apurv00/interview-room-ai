#!/usr/bin/env node
/**
 * Ensures every competency bucket used in flow templates has a strong answer template.
 * Usage: node scripts/validate-qa-answer-coverage.mjs [--strict]
 */
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { findCoverageGaps } from '../modules/qa/lib/strongAnswerRouter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const templatesDir = path.join(root, 'modules/interview/flow/templates');
const configPath = path.join(root, 'modules/qa/config/strongAnswers.json');

const strict = process.argv.includes('--strict');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const buckets = new Set();

for (const file of fs.readdirSync(templatesDir)) {
  if (!file.endsWith('.ts') || file === 'index.ts') continue;
  const text = fs.readFileSync(path.join(templatesDir, file), 'utf8');
  const re = /\['[a-z0-9-]+',\s*'[^']*',\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(text))) buckets.add(m[1]);
}

const { missingBuckets } = findCoverageGaps(config, buckets);

if (missingBuckets.length) {
  console.error(`Missing strongAnswers.byBucket entries (${missingBuckets.length}):`);
  for (const b of missingBuckets) console.error(`  - ${b}`);
  process.exit(strict ? 1 : 0);
}

console.log(`QA answer coverage OK — ${buckets.size} competency buckets covered`);
