import { NextResponse } from 'next/server'
import { PDFGenerateSchema } from '@resume/validators/resume'
import { renderResumeHTML } from '@resume/services/pdfService'

// Returns a fully self-contained, Tailwind-inlined, paginated HTML document for
// the resume — the SAME markup the server PDF renders, but WITHOUT Puppeteer or
// Chromium. The client opens it and prints (Save as PDF), which always produces
// a correctly-formatted document for every template, with no serverless memory
// limit to hit. This is the reliable fallback when the Chromium PDF route fails.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Browsers print CSS px at 96dpi, but the resume is authored at 595px = A4 @
// 72dpi. Without a scale the printed page fills only ~75% of the sheet. Scale
// the page CONTENT (not the page boundary) by 96/72 so each .resume-page fills a
// full A4 sheet, while the page-break boundary itself stays untransformed so
// pagination is preserved. Auto-print once pagination has built the pages.
const PRINT_AUGMENT = `
<style>
@media print {
  @page { size: A4; margin: 0; }
  html, body { margin: 0; padding: 0; }
  #resume-measure-root { display: none !important; }
  .resume-page {
    width: 794px !important;
    height: 1123px !important;
    page-break-after: always;
    overflow: hidden;
  }
  .resume-page:last-child { page-break-after: auto; }
  .resume-page-inner {
    transform: scale(1.3334);
    transform-origin: top left;
  }
}
</style>
<script>
  (function autoPrint() {
    var tries = 0;
    function ready() {
      return window.__resumePagesReady === true || tries > 60;
    }
    function go() {
      if (ready()) { window.focus(); window.print(); return; }
      tries++; setTimeout(go, 100);
    }
    if (document.readyState === 'complete') go();
    else window.addEventListener('load', go);
  })();
</script>
`

export async function POST(req: Request) {
  // Intentionally NOT auth-gated. This endpoint only renders the resume data the
  // client posts into self-contained HTML (no DB reads, no Chromium, no other
  // user's data), and the "Print PDF" button is available to anonymous draft
  // editors. Gating it would regress the previously client-only print path.
  const body = await req.json()
  const parsed = PDFGenerateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid data' }, { status: 400 })
  }

  const html = renderResumeHTML(parsed.data.resumeData, parsed.data.templateId)
  // Inject the print scale + auto-print just before </body> so they run after
  // the template markup and the existing pagination script.
  const withPrint = html.includes('</body>')
    ? html.replace('</body>', `${PRINT_AUGMENT}</body>`)
    : html + PRINT_AUGMENT

  return new Response(withPrint, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
