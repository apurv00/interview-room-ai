/**
 * Standalone Tailwind config for the resume PDF pipeline.
 *
 * Scans ONLY the resume template components so the generated CSS is small
 * (~20-40KB) and deterministic. This file is processed by
 * scripts/build-resume-css.js and emitted as a JSON module the server
 * imports — no filesystem reads at runtime.
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './modules/resume/components/templates/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
