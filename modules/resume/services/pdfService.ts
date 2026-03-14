import type { ResumeData } from '../validators/resume'

// ─── HTML Template Generators for PDF ──────────────────────────────────────
// These generate static HTML+CSS (no Tailwind, no React) for Puppeteer rendering

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function contactLine(data: ResumeData): string {
  const c = data.contactInfo || { fullName: '', email: '' }
  const parts = [c.email, c.phone, c.location, c.linkedin, c.website, c.github].filter(Boolean)
  return parts.map(p => `<span>${escapeHtml(p!)}</span>`).join('<span class="sep">|</span>')
}

export function generateResumeHTML(data: ResumeData, templateId: string): string {
  const contact = data.contactInfo || { fullName: '', email: '' }

  // Template-specific accent colors
  const accentColors: Record<string, string> = {
    professional: '#1f2937',
    technical: '#059669',
    creative: '#6366f1',
    executive: '#1e3a5f',
    'career-change': '#0891b2',
    'entry-level': '#f43f5e',
    minimalist: '#374151',
    academic: '#1d4ed8',
    federal: '#991b1b',
    startup: '#f97316',
  }
  const accent = accentColors[templateId] || '#1f2937'

  const sectionsHTML: string[] = []

  // Summary
  if (data.summary) {
    sectionsHTML.push(`
      <div class="section">
        <h2>Professional Summary</h2>
        <p>${escapeHtml(data.summary)}</p>
      </div>
    `)
  }

  // Experience
  if (data.experience?.length) {
    const items = data.experience.map(exp => `
      <div class="entry">
        <div class="entry-header">
          <div><strong>${escapeHtml(exp.title)}</strong>${exp.company ? ` — ${escapeHtml(exp.company)}` : ''}</div>
          <div class="date">${escapeHtml(exp.startDate)} - ${escapeHtml(exp.endDate || 'Present')}</div>
        </div>
        ${exp.location ? `<div class="subtitle">${escapeHtml(exp.location)}</div>` : ''}
        ${exp.bullets.filter(b => b.trim()).length > 0 ? `
          <ul>${exp.bullets.filter(b => b.trim()).map(b => `<li>${escapeHtml(b)}</li>`).join('')}</ul>
        ` : ''}
      </div>
    `).join('')
    sectionsHTML.push(`<div class="section"><h2>Experience</h2>${items}</div>`)
  }

  // Education
  if (data.education?.length) {
    const items = data.education.map(edu => `
      <div class="entry">
        <div class="entry-header">
          <div><strong>${escapeHtml(edu.degree)}</strong>${edu.field ? ` in ${escapeHtml(edu.field)}` : ''}${edu.institution ? ` — ${escapeHtml(edu.institution)}` : ''}</div>
          ${edu.graduationDate ? `<div class="date">${escapeHtml(edu.graduationDate)}</div>` : ''}
        </div>
        ${edu.gpa || edu.honors ? `<div class="subtitle">${[edu.gpa ? `GPA: ${edu.gpa}` : '', edu.honors].filter(Boolean).join(' | ')}</div>` : ''}
      </div>
    `).join('')
    sectionsHTML.push(`<div class="section"><h2>Education</h2>${items}</div>`)
  }

  // Skills
  if (data.skills?.length) {
    const items = data.skills.map(cat =>
      `<div class="skill-row"><strong>${escapeHtml(cat.category)}:</strong> ${cat.items.map(s => escapeHtml(s)).join(', ')}</div>`
    ).join('')
    sectionsHTML.push(`<div class="section"><h2>Skills</h2>${items}</div>`)
  }

  // Projects
  if (data.projects?.length) {
    const items = data.projects.map(proj => `
      <div class="entry">
        <div><strong>${escapeHtml(proj.name)}</strong>${proj.technologies?.length ? ` <span class="tech">(${proj.technologies.map(t => escapeHtml(t)).join(', ')})</span>` : ''}</div>
        <p>${escapeHtml(proj.description)}</p>
      </div>
    `).join('')
    sectionsHTML.push(`<div class="section"><h2>Projects</h2>${items}</div>`)
  }

  // Certifications
  if (data.certifications?.length) {
    const items = data.certifications.map(c =>
      `<div class="cert"><strong>${escapeHtml(c.name)}</strong> — ${escapeHtml(c.issuer)}${c.date ? ` (${escapeHtml(c.date)})` : ''}</div>`
    ).join('')
    sectionsHTML.push(`<div class="section"><h2>Certifications</h2>${items}</div>`)
  }

  // Custom Sections
  if (data.customSections?.length) {
    for (const sec of data.customSections) {
      sectionsHTML.push(`
        <div class="section">
          <h2>${escapeHtml(sec.title)}</h2>
          <p style="white-space: pre-wrap;">${escapeHtml(sec.content)}</p>
        </div>
      `)
    }
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Georgia', 'Times New Roman', serif;
      font-size: 10.5pt;
      line-height: 1.4;
      color: #1f2937;
      padding: 40px 50px;
    }
    .header {
      text-align: center;
      border-bottom: 2px solid ${accent};
      padding-bottom: 10px;
      margin-bottom: 16px;
    }
    .header h1 {
      font-size: 20pt;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: ${accent};
    }
    .header .contact {
      font-size: 8.5pt;
      color: #6b7280;
      margin-top: 4px;
    }
    .header .contact .sep {
      margin: 0 6px;
    }
    .section {
      margin-bottom: 14px;
    }
    .section h2 {
      font-size: 9.5pt;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      border-bottom: 1px solid #d1d5db;
      padding-bottom: 2px;
      margin-bottom: 6px;
      color: ${accent};
    }
    .section p {
      font-size: 9.5pt;
      color: #374151;
    }
    .entry {
      margin-bottom: 8px;
    }
    .entry-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      font-size: 9.5pt;
    }
    .date {
      font-size: 8.5pt;
      color: #6b7280;
      white-space: nowrap;
      margin-left: 8px;
    }
    .subtitle {
      font-size: 8.5pt;
      color: #6b7280;
    }
    ul {
      margin-top: 3px;
      padding-left: 14px;
    }
    li {
      font-size: 9.5pt;
      color: #374151;
      margin-bottom: 2px;
    }
    .skill-row {
      font-size: 9.5pt;
      margin-bottom: 2px;
    }
    .tech {
      font-size: 8.5pt;
      color: #6b7280;
    }
    .cert {
      font-size: 9.5pt;
      margin-bottom: 2px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(contact.fullName || 'Your Name')}</h1>
    <div class="contact">${contactLine(data)}</div>
  </div>
  ${sectionsHTML.join('\n')}
</body>
</html>`
}

export async function generatePDF(data: ResumeData, templateId: string): Promise<Buffer> {
  const html = generateResumeHTML(data, templateId)

  // Dynamic import to handle environments without Puppeteer
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const puppeteer = require('puppeteer-core')

  let executablePath: string
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const chromium = require('@sparticuz/chromium')
    executablePath = await chromium.executablePath()
  } catch {
    // Fallback to common Chromium paths
    executablePath = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser'
  }

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    executablePath,
    headless: true,
  })

  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle0' })
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    })
    return Buffer.from(pdfBuffer)
  } finally {
    await browser.close()
  }
}
