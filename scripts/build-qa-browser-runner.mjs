#!/usr/bin/env node
/** Copy modules/qa/browser/inPageRunner.js → public/qa-matrix-runner.js for same-origin browser runs. */
import { copyFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'modules/qa/browser/inPageRunner.js')
const dest = join(root, 'public/qa-matrix-runner.js')
mkdirSync(dirname(dest), { recursive: true })
copyFileSync(src, dest)
console.log('Wrote public/qa-matrix-runner.js')
