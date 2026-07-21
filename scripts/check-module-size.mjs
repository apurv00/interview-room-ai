#!/usr/bin/env node

/**
 * Module size budget check.
 *
 * Fails CI when any domain module exceeds its LOC or file-count budget.
 * Run manually: node scripts/check-module-size.mjs
 * Wired into CI via .github/workflows/ci.yml.
 *
 * Budgets are intentionally generous — they're early-warning tripwires,
 * not hard limits. If a module legitimately needs to grow past its budget,
 * update the budget here and add an ADR explaining why.
 */

import { execSync } from 'child_process'
import { readdirSync, statSync } from 'fs'
import { join, extname } from 'path'

const BUDGETS = {
  // interview bumped to 32k on 2026-05-14: replay-upload race fix added the
  // resumableUpload lease/cap layers. See docs/adr/0003-interview-module-budget-bump.md.
  // Bumped LOC 32k→33k and files 160→168 on 2026-05-16: feedback-page Round 2
  // added 4 new components + 2 utils (Q-chip system + Learning tab + ideal-answer
  // comparison card). See docs/adr/0004-interview-module-budget-bump-feedback.md.
  // Bumped LOC 33k→35k and files 168→180 on 2026-05-16: Multimodal tab Round 4
  // full visual + IA redesign added 9 new components + tokens (multimodal/
  // subdirectory). See docs/adr/0005-interview-module-budget-bump-multimodal.md.
  // Reset LOC 35k→30k and files 180→140 on 2026-05-16: feedback-page UI carved
  // out into the new modules/feedback/ module, dead components/replay/* purged.
  // 30k chosen empirically — post-split actual is ~27.3k, leaving ~10% headroom.
  // Next bump-pressure should carve out services/analysis/ + jobs/analysisJob.ts
  // (post-interview pipeline) rather than re-bumping. See ADR 0006.
  // Bumped files 140→142 on 2026-06-02 (PR #432): adds ONE counted file —
  // shared config/fillerMetrics.ts, the single-source filler tokenizer that
  // de-duplicates speechMetrics + prosodyService. The module already sat at the
  // 140 cap, so that one file trips it to 141. Its companion test
  // (__tests__/speechMetrics.test.ts) does NOT count — countFiles() skips
  // __tests__/ (see below) and the LOC find greps it out. LOC unaffected
  // (~28k/30k): a count-shape change, not bloat. +1 headroom keeps the tripwire
  // close per ADR 0006. See docs/adr/0009-interview-module-budget-bump-filler-metrics.md.
  // 2026-06-17: flow/templates/ now excluded from the count as declarative content
  // (see EXCLUDED_PATHS + ADR 0012). Budget unchanged at 30k/142 — it now governs the
  // interview ENGINE/UI code only (~25.2k/107 post-exclusion), not the domain catalog.
  'modules/interview': { maxLOC: 30_000, maxFiles: 142 },
  'modules/feedback':  { maxLOC: 10_000, maxFiles: 60 },
  // Bumped maxFiles 80 → 82 on 2026-06-09 (PR #435): adds ONE counted file —
  // services/resolvePathwayNextHref.ts, the server-side CTA next-step resolver
  // that decouples the homepage hero CTA from the heavy /api/learn/pathway
  // fetch (fixes the "Loading your next step…" stall). The paired test is not
  // counted (countFiles skips __tests__/). LOC stays well under budget
  // (~14k/25k) — a small-util add, not bloat. +1 headroom keeps the tripwire
  // tight. See docs/adr/0010-learn-module-budget-bump-cta-resolver.md.
  'modules/learn':     { maxLOC: 25_000, maxFiles: 82 },
  // Bumped maxFiles 70 → 100 on 2026-05-29 (PR #411): the flat 10-template
  // catalog was refactored into a family → layout → theme → primitive system
  // (7 layouts + ~12 shared primitives + per-family theme configs + thin legacy
  // shims). This deliberately trades many small files for reuse — LOC is still
  // well under budget (~10.6k/20k). +12 headroom covers near-term config-only
  // variants; a bump past ~100 should move themes to a subdir, not re-bump.
  // See docs/adr/0008-resume-module-budget-bump-template-families.md.
  // Bumped maxFiles 100 → 104 on 2026-07-02 (PRs #492/#491): adds TWO counted
  // files, neither a template variant (ADR 0008's re-bump caveat targeted
  // theme sprawl): hooks/useDebouncedValue.ts (preview re-measure debounce,
  // unit-tested standalone) and lib/structuredContent.ts (client-safe
  // structured-content predicate shared by saveResume and the builder page —
  // extracted precisely so the client page doesn't import the mongoose-backed
  // service). LOC ~12.1k/20k. +2 headroom keeps the tripwire tight.
  // See docs/adr/0014-resume-module-budget-bump-cross-cutting-helpers.md.
  'modules/resume':    { maxLOC: 20_000, maxFiles: 104 },
  'modules/b2b':       { maxLOC: 5_000,  maxFiles: 20 },
  'modules/cms':       { maxLOC: 5_000,  maxFiles: 20 },
  // Bumped maxFiles 130 → 132 on 2026-05-23 (PR #402): added
  // shared/hooks/useOnboardingProfile.ts (cross-module client data
  // hook consumed by both @interview/InterviewSetupForm and
  // @learn/ResourceLinks — must live in shared/ to avoid a module
  // cycle). Net +1 file; +2 headroom slot intentional. See
  // docs/adr/0007-shared-budget-bump-onboarding-hook.md.
  // Bumped maxFiles 132 → 134 on 2026-06-09 (PR #437): adds ONE counted file —
  // shared/taxonomy/categoryMaps.ts, the client-safe legacy<->new category
  // translation shared by the seed (server) and the CMS domain forms (client)
  // so they cannot drift. The paired test is not counted. LOC well under budget
  // (~13k/25k). +1 headroom. See docs/adr/0011-shared-budget-bump-category-maps.md.
  // Bumped maxFiles 134 → 136 on 2026-06-24 (PR #463): adds ONE counted file —
  // shared/services/providers/azureTTS.ts, the opt-in Azure AI Speech TTS adapter
  // (Indian-accent interviewer voice; feedback #4), alongside the other provider
  // adapters. The paired test (__tests__/azureTTS.test.ts) is NOT counted
  // (countFiles skips __tests__/). LOC unaffected, well under budget (~13.8k/25k)
  // — a count-shape change, not bloat. +1 headroom. See
  // docs/adr/0013-shared-budget-bump-azure-tts.md.
  // Bumped maxFiles 136 → 137 on 2026-07-05 (PR #496): adds ONE counted file —
  // shared/lib/answerSuggestion.ts, the deterministic per-answer coaching-tip
  // helper (weakest-dimension + domain-aware) shared by @feedback
  // (QuestionBreakdown) and @learn (SourceFeedbackDrawer) so the two surfaces
  // cannot drift — same cross-module-dedup rationale as ADR 0011. The paired
  // test (__tests__/answerSuggestion.test.ts) is NOT counted (countFiles skips
  // __tests__/). LOC well under budget. +1 headroom. See
  // docs/adr/0015-shared-budget-bump-answer-suggestion.md.
  // Bumped maxFiles 137 → 145 on 2026-07-12 (jobs Wave 0.3/1): the Jobs
  // feature adds SEVEN counted shared files across two PRs, all following
  // the repo's own models-live-in-shared convention (barrel header):
  // JobPosting, JobSourceConfig, JobIngestCursor, JobIngestCycle (Wave
  // 0.3), JobApplication + ProductEvent (Wave 1), and
  // shared/fetchJSONWithRetry.ts (adapter helper). 137 + 7 = 144, +1
  // headroom = 145. LOC well under budget (~15k/25k) — model files, not
  // logic sprawl. See docs/adr/0016-shared-budget-bump-jobs-models.md.
  // Bumped maxFiles 145 → 148 on 2026-07-15 (email wave PR-A): adds THREE
  // counted files — JobsEmailSend + JobsEmailConfig models and the
  // signedActionToken helper (EMAILS.md §6). See
  // docs/adr/0017-shared-budget-bump-jobs-email-infra.md.
  // Bumped maxFiles 148 → 149 on 2026-07-16 (readiness PR-R1): adds ONE
  // counted file — the JobPracticeEvidence model (own collection so the
  // replace-not-duplicate unique index is real). See
  // docs/adr/0018-readiness-wave-budgets.md.
  // Bumped maxFiles 149 → 152 on 2026-07-21 (Jobs audit A02): adds TWO
  // counted persistence models — the permanent source-control audit and its
  // global lineage/control fence. They follow the shared-model convention;
  // +1 headroom keeps the tripwire tight. See
  // docs/adr/0019-shared-budget-bump-jobs-source-control.md.
  'shared':            { maxLOC: 25_000, maxFiles: 152 },
  // Added 2026-07-16 (readiness PR-R1): modules/jobs had NO budget row —
  // generous tripwire per this file's philosophy. Same ADR as above.
  'modules/jobs':      { maxLOC: 14_000, maxFiles: 70 },
}

const TS_EXTENSIONS = new Set(['.ts', '.tsx'])

// Directories excluded from the size budget because they are declarative interview
// CONTENT, not application logic — the .ts analogue of the skills/*.md files the count
// already skips by extension. The flow ENGINE (slotBuilder, resolver, promptBuilder,
// coveragePressure, jdOverlayBuilder, types) lives outside this dir and stays counted.
// Content grows linearly with the domain catalog; it must not trip a code-sprawl
// tripwire. See docs/adr/0012-exclude-flow-templates-from-size-budget.md.
const EXCLUDED_PATHS = new Set(['modules/interview/flow/templates'])

function countFiles(dir) {
  let count = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue
        if (EXCLUDED_PATHS.has(fullPath)) continue
        count += countFiles(fullPath)
      } else if (TS_EXTENSIONS.has(extname(entry.name))) {
        count++
      }
    }
  } catch { /* dir doesn't exist */ }
  return count
}

function countLOC(dir) {
  try {
    const output = execSync(
      `find "${dir}" -name '*.ts' -o -name '*.tsx' | grep -v __tests__ | grep -v node_modules | grep -v 'modules/interview/flow/templates/' | xargs wc -l 2>/dev/null | tail -1`,
      { encoding: 'utf-8' }
    ).trim()
    const match = output.match(/^\s*(\d+)/)
    return match ? parseInt(match[1], 10) : 0
  } catch {
    return 0
  }
}

let failed = false

console.log('Module size budget check')
console.log('========================\n')

for (const [dir, budget] of Object.entries(BUDGETS)) {
  const files = countFiles(dir)
  const loc = countLOC(dir)
  const fileOver = files > budget.maxFiles
  const locOver = loc > budget.maxLOC

  const fileStatus = fileOver ? '❌' : '✓'
  const locStatus = locOver ? '❌' : '✓'

  console.log(`${dir}`)
  console.log(`  ${fileStatus} Files: ${files} / ${budget.maxFiles}`)
  console.log(`  ${locStatus} LOC:   ${loc} / ${budget.maxLOC}`)

  if (fileOver || locOver) {
    failed = true
    if (fileOver) console.log(`  ⚠  File count exceeds budget by ${files - budget.maxFiles}`)
    if (locOver) console.log(`  ⚠  LOC exceeds budget by ${loc - budget.maxLOC}`)
  }
  console.log()
}

if (failed) {
  console.log('FAILED: One or more modules exceed their size budget.')
  console.log('If this growth is intentional, update the budget in scripts/check-module-size.mjs')
  console.log('and add an ADR to docs/adr/ explaining why.')
  process.exit(1)
} else {
  console.log('All modules within budget. ✓')
}
