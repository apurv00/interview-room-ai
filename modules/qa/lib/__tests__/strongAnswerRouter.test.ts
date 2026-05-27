import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  pickStrongAnswer,
  scoreQuestionGates,
  findCoverageGaps,
} from '../strongAnswerRouter.mjs';

const configPath = path.join(process.cwd(), 'modules/qa/config/strongAnswers.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

describe('pickStrongAnswer', () => {
  it('routes by competency bucket when flowMeta present', () => {
    const { answer, route } = pickStrongAnswer(config, {
      domain: 'backend',
      depth: 'behavioral',
      flowMeta: { slotId: 'conflict-resolution', competencyBucket: 'collaboration' },
    });
    expect(route).toBe('bucket:collaboration');
    expect(answer).toContain('Situation:');
  });

  it('prefers domain+bucket override over generic bucket', () => {
    const { route } = pickStrongAnswer(config, {
      domain: 'sdet',
      depth: 'technical',
      flowMeta: { slotId: 'test-pyramid', competencyBucket: 'test-strategy' },
    });
    expect(route).toBe('domain-bucket:sdet:test-strategy');
  });

  it('falls back to depth when flowMeta missing', () => {
    const { route, answer } = pickStrongAnswer(config, {
      domain: 'pm',
      depth: 'case-study',
      flowMeta: null,
    });
    expect(route).toBe('no-flowMeta:case-study');
    expect(answer).toContain('MAU');
  });
});

describe('scoreQuestionGates', () => {
  it('G3 relevance does not block strong bandOk when avg below 60', () => {
    const gates = scoreQuestionGates(45, 'strong', true);
    expect(gates.g3Relevance).toBe(false);
    expect(gates.bandOk).toBe(true);
  });

  it('G2 separation blocks weak when avg above 55', () => {
    const gates = scoreQuestionGates(70, 'weak', true);
    expect(gates.g2Separation).toBe(false);
    expect(gates.bandOk).toBe(false);
  });
});

describe('findCoverageGaps', () => {
  it('reports no missing buckets for full template scan', () => {
    const templatesDir = path.join(process.cwd(), 'modules/interview/flow/templates');
    const buckets = new Set<string>();
    for (const file of fs.readdirSync(templatesDir)) {
      if (!file.endsWith('.ts') || file === 'index.ts') continue;
      const text = fs.readFileSync(path.join(templatesDir, file), 'utf8');
      const re = /\['[a-z0-9-]+',\s*'[^']*',\s*'([^']+)'/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) buckets.add(m[1]);
    }
    const { missingBuckets } = findCoverageGaps(config, buckets);
    expect(missingBuckets).toEqual([]);
  });
});
