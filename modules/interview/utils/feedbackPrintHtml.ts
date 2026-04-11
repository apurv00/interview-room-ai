import type { FeedbackData, StoredInterviewData } from '@shared/types'

/** Escape user-supplied strings before embedding in the print HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function scoreBand(score: number): { label: string; color: string } {
  if (score >= 75) return { label: 'Strong', color: '#10b981' }
  if (score >= 55) return { label: 'Competent', color: '#3b82f6' }
  return { label: 'Needs development', color: '#f59e0b' }
}

export interface FeedbackPrintOptions {
  feedback: FeedbackData
  data: StoredInterviewData
  domainLabel: string
  sessionDate?: string
}

/** Build a self-contained, print-optimized HTML document for a feedback
 *  scorecard. Opened in a new window and auto-printed; the user's browser
 *  produces the final PDF via "Print to PDF".
 *
 *  Why client-side and not server puppeteer? The resume module already
 *  ships a full puppeteer PDF stack, but feedback scorecards are simpler,
 *  benefit from already-loaded data, and need no external deps — so this
 *  implementation matches the resume Editor's print fallback pattern
 *  instead of adding a new API route. */
export function buildFeedbackPrintHtml(opts: FeedbackPrintOptions): string {
  const { feedback, data, domainLabel, sessionDate } = opts
  const overall = feedback.overall_score
  const band = scoreBand(overall)

  const aq = feedback.dimensions.answer_quality
  const comm = feedback.dimensions.communication
  const eng = feedback.dimensions.engagement_signals

  const config = data.config
  const headerMeta = [
    domainLabel,
    config?.experience ? `${config.experience} yrs` : null,
    config?.duration ? `${config.duration} min` : null,
  ]
    .filter(Boolean)
    .map((v) => escapeHtml(String(v)))
    .join(' · ')

  const date = sessionDate || new Date().toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  const strengths = (aq.strengths || []).slice(0, 5)
  const weaknesses = (aq.weaknesses || []).slice(0, 5)
  const improvements = (feedback.top_3_improvements || []).slice(0, 5)

  const strengthsHtml = strengths.length
    ? strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join('')
    : '<li class="muted">No strengths recorded</li>'

  const weaknessesHtml = weaknesses.length
    ? weaknesses.map((s) => `<li>${escapeHtml(s)}</li>`).join('')
    : '<li class="muted">No weaknesses recorded</li>'

  const improvementsHtml = improvements.length
    ? improvements.map((s, i) => `<li><span class="num">${i + 1}</span>${escapeHtml(s)}</li>`).join('')
    : '<li class="muted">No improvement suggestions</li>'

  const redFlagsHtml = (feedback.red_flags || []).length
    ? `<section class="panel red">
        <h3>Red flags</h3>
        <ul>${feedback.red_flags.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
       </section>`
    : ''

  // Transcript: include the full Q&A log so the printed scorecard is a
  // self-contained record. Clamp extremely long transcripts so the PDF
  // stays readable.
  const transcriptEntries = (data.transcript || []).slice(0, 200)
  const transcriptHtml = transcriptEntries.length
    ? transcriptEntries
        .map(
          (e) => `
          <div class="tx-entry ${e.speaker === 'ai' ? 'tx-ai' : 'tx-you'}">
            <div class="tx-speaker">${e.speaker === 'ai' ? 'Interviewer' : 'You'}</div>
            <div class="tx-text">${escapeHtml(e.text)}</div>
          </div>`
        )
        .join('')
    : '<p class="muted">No transcript recorded.</p>'

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Interview Scorecard — ${escapeHtml(domainLabel)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  @page { size: A4; margin: 14mm; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    color: #0f1419;
    background: #fff;
    font-size: 11pt;
    line-height: 1.45;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .doc { max-width: 180mm; margin: 0 auto; }
  .brand {
    font-size: 9pt;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #3b82f6;
    font-weight: 600;
    margin-bottom: 4mm;
  }
  h1 {
    font-size: 22pt;
    font-weight: 800;
    letter-spacing: -0.02em;
    margin-bottom: 2mm;
  }
  .meta { color: #71767b; font-size: 10pt; margin-bottom: 8mm; }

  .hero {
    display: flex;
    align-items: center;
    gap: 10mm;
    padding: 6mm;
    border: 1pt solid #e1e8ed;
    border-radius: 4mm;
    margin-bottom: 6mm;
    page-break-inside: avoid;
  }
  .ring {
    width: 32mm;
    height: 32mm;
    border-radius: 50%;
    border: 3mm solid ${band.color};
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20pt;
    font-weight: 800;
    color: ${band.color};
    flex-shrink: 0;
  }
  .hero .label { font-size: 14pt; font-weight: 700; margin-bottom: 1mm; }
  .hero .sub   { color: #71767b; font-size: 10pt; }
  .pill {
    display: inline-block;
    padding: 1mm 3mm;
    border-radius: 10mm;
    font-size: 9pt;
    font-weight: 600;
    margin-top: 2mm;
    background: ${band.color}22;
    color: ${band.color};
  }

  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 5mm;
    margin-bottom: 6mm;
  }
  .panel {
    padding: 5mm;
    border: 1pt solid #e1e8ed;
    border-radius: 3mm;
    page-break-inside: avoid;
  }
  .panel h3 {
    font-size: 10pt;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #71767b;
    margin-bottom: 3mm;
    font-weight: 700;
  }
  .panel.red h3 { color: #dc2626; }
  .panel ul { list-style: none; }
  .panel li {
    padding: 1.5mm 0;
    font-size: 10pt;
    border-bottom: 1pt solid #f1f5f9;
  }
  .panel li:last-child { border-bottom: none; }
  .panel li .num {
    display: inline-block;
    width: 5mm;
    height: 5mm;
    border-radius: 50%;
    background: #3b82f6;
    color: #fff;
    font-size: 8pt;
    font-weight: 700;
    text-align: center;
    line-height: 5mm;
    margin-right: 2mm;
  }
  .panel li.muted { color: #94a3b8; font-style: italic; }

  .dims { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; margin-bottom: 6mm; }
  .dim {
    padding: 4mm;
    border: 1pt solid #e1e8ed;
    border-radius: 3mm;
    text-align: center;
    page-break-inside: avoid;
  }
  .dim .k { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.08em; color: #71767b; }
  .dim .v { font-size: 18pt; font-weight: 800; color: #0f1419; margin-top: 2mm; }
  .dim .sub { font-size: 8pt; color: #94a3b8; margin-top: 1mm; }

  .section-title {
    font-size: 12pt;
    font-weight: 700;
    margin: 6mm 0 3mm;
    padding-bottom: 2mm;
    border-bottom: 1pt solid #e1e8ed;
  }
  .tx-entry { margin-bottom: 3mm; page-break-inside: avoid; }
  .tx-speaker {
    font-size: 8pt;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
    margin-bottom: 0.5mm;
  }
  .tx-ai .tx-speaker { color: #3b82f6; }
  .tx-you .tx-speaker { color: #10b981; }
  .tx-text { font-size: 10pt; color: #334155; }

  .footer {
    margin-top: 10mm;
    padding-top: 4mm;
    border-top: 1pt solid #e1e8ed;
    color: #94a3b8;
    font-size: 8pt;
    text-align: center;
  }

  @media print {
    body { margin: 0; }
  }
</style>
</head>
<body>
<div class="doc">
  <div class="brand">Interview Prep Guru · Scorecard</div>
  <h1>Interview Feedback</h1>
  <div class="meta">${headerMeta} &nbsp;·&nbsp; ${escapeHtml(date)}</div>

  <div class="hero">
    <div class="ring">${Math.round(overall)}</div>
    <div>
      <div class="label">${band.label} performance</div>
      <div class="sub">Overall score out of 100 · ${escapeHtml(feedback.pass_probability)} pass probability</div>
      <div class="pill">${escapeHtml(feedback.confidence_level)} confidence</div>
    </div>
  </div>

  <div class="dims">
    <div class="dim">
      <div class="k">Answer quality</div>
      <div class="v">${Math.round(aq.score)}</div>
      <div class="sub">Structure, specificity, ownership</div>
    </div>
    <div class="dim">
      <div class="k">Communication</div>
      <div class="v">${Math.round(comm.score)}</div>
      <div class="sub">${Math.round(comm.wpm)} wpm · ${Math.round((comm.filler_rate || 0) * 100)}% filler</div>
    </div>
    <div class="dim">
      <div class="k">Engagement</div>
      <div class="v">${Math.round(eng?.score ?? 50)}</div>
      <div class="sub">Energy &amp; composure</div>
    </div>
  </div>

  <div class="grid-2">
    <section class="panel">
      <h3>Strengths</h3>
      <ul>${strengthsHtml}</ul>
    </section>
    <section class="panel">
      <h3>Areas to improve</h3>
      <ul>${weaknessesHtml}</ul>
    </section>
  </div>

  <section class="panel" style="margin-bottom: 6mm;">
    <h3>Top improvements</h3>
    <ul>${improvementsHtml}</ul>
  </section>

  ${redFlagsHtml}

  <h2 class="section-title">Transcript</h2>
  ${transcriptHtml}

  <div class="footer">
    Generated by Interview Prep Guru · interviewprep.guru
  </div>
</div>
<script>
  // Auto-launch the print dialog a moment after load so fonts and layout
  // settle. The user's browser handles the actual PDF generation via
  // "Save as PDF" — no server puppeteer required.
  window.addEventListener('load', function () {
    setTimeout(function () { window.print(); }, 400);
  });
</script>
</body>
</html>`
}
