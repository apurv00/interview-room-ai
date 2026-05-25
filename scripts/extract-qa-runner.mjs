import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), 'modules/qa/browser');
const parts = [];
for (let i = 0; i < 4; i++) {
  const text = fs.readFileSync(path.join(dir, `inject-chunk-${i}.txt`), 'utf8');
  const m = text.match(/sessionStorage\.setItem\('qa_chunk_\d+',"([\s\S]*)"\)\)/);
  if (!m) throw new Error(`Failed to parse chunk ${i}`);
  parts.push(JSON.parse(`"${m[1]}"`));
}
const out = path.join(dir, 'qa-matrix-runner.js');
fs.writeFileSync(out, parts.join(''));
console.log(`Wrote ${out} (${parts.join('').length} chars)`);
