/**
 * Standalone Tailwind config for the resume PDF pipeline.
 *
 * Scans the resume rendering surface so the generated CSS is small and
 * deterministic. This file is processed by scripts/build-resume-css.js and
 * emitted as a JSON module the server imports — no filesystem reads at runtime.
 *
 * IMPORTANT: the family refactor moved template classes out of templates/ (now
 * thin shims) into layouts/, template-primitives/, ResumeSkillsSection, and the
 * per-family theme strings in config/. ALL of these must be scanned or exported
 * PDFs render unstyled while the browser preview (full Tailwind) still works.
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './modules/resume/components/templates/**/*.{js,ts,jsx,tsx}',
    './modules/resume/components/layouts/**/*.{js,ts,jsx,tsx}',
    './modules/resume/components/template-primitives/**/*.{js,ts,jsx,tsx}',
    './modules/resume/components/ResumeSkillsSection.tsx',
    // Theme configs hold class strings (accent colors, section titles, etc.)
    // that only appear here now — they must be scanned too.
    './modules/resume/config/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
