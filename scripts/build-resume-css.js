/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Compiles a minimal Tailwind CSS bundle scoped to the resume template
 * components and writes it out as a JSON module.
 *
 * Why a JSON module instead of a plain CSS file? Next.js's serverless
 * function bundler automatically includes files imported via `import`
 * statements. By importing the result as JSON from pdfService.ts we
 * guarantee the CSS travels with the function code on every
 * deployment target (Vercel, Docker, self-hosted).
 */
const fs = require('fs')
const path = require('path')
const postcss = require('postcss')
const tailwindcss = require('tailwindcss')

const ROOT = path.join(__dirname, '..')
const CONFIG_PATH = path.join(ROOT, 'tailwind.config.resume-pdf.js')
const INPUT_CSS = '@tailwind base;\n@tailwind components;\n@tailwind utilities;'
const OUTPUT_PATH = path.join(
  ROOT,
  'modules',
  'resume',
  'styles',
  'resume-pdf-css.json',
)

async function build() {
  const result = await postcss([tailwindcss(CONFIG_PATH)]).process(INPUT_CSS, {
    from: undefined,
  })
  const css = result.css
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true })
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ css }))
  // eslint-disable-next-line no-console
  console.log(
    `[build-resume-css] wrote ${OUTPUT_PATH} (${(css.length / 1024).toFixed(1)} KB)`,
  )
}

build().catch(err => {
  // eslint-disable-next-line no-console
  console.error('[build-resume-css] failed:', err)
  process.exit(1)
})
