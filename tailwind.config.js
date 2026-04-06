/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './modules/**/*.{js,ts,jsx,tsx,mdx}',
    './shared/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eff6ff',
          100: '#dbeafe',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          900: '#1e3a5f',
        },
        page: 'var(--color-page)',
        card: 'var(--color-card)',
        surface: 'var(--color-surface)',
        raised: 'var(--color-raised)',
        border: 'var(--color-border)',
        // New design system tokens (blue-600 accent)
        'ds-primary': '#2563eb',
        'ds-primary-hover': '#1d4ed8',
        'ds-primary-light': '#eff6ff',
        'ds-primary-border': '#bfdbfe',
        'ds-page': '#f8fafc',
        'ds-card': '#ffffff',
        'ds-surface': '#f1f5f9',
        'ds-border': '#e2e8f0',
        'ds-text-primary': '#0f172a',
        'ds-text-secondary': '#64748b',
        'ds-text-tertiary': '#94a3b8',
      },
      boxShadow: {
        'card': 'var(--shadow-card)',
        'card-hover': 'var(--shadow-card-hover)',
        'dropdown': 'var(--shadow-dropdown)',
      },
      spacing: {
        'inline': '6px',
        'element': '12px',
        'component': '16px',
        'section': '32px',
        'region': '56px',
      },
      borderRadius: {
        DEFAULT: '10px',
      },
      borderColor: {
        DEFAULT: 'var(--color-border)',
      },
      animation: {
        'pulse-slow': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'blink': 'blink 4s ease-in-out infinite',
        'talk': 'talk 0.15s ease-in-out infinite alternate',
        'fade-in': 'fadeIn 0.3s ease-out',
        'score-fill': 'scoreFill 1s ease-out forwards',
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
      keyframes: {
        blink: {
          '0%, 90%, 100%': { transform: 'scaleY(1)' },
          '95%': { transform: 'scaleY(0.05)' },
        },
        talk: {
          '0%': { d: 'path("M 75 155 Q 100 162 125 155")' },
          '100%': { d: 'path("M 75 155 Q 100 170 125 155")' },
        },
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        scoreFill: {
          from: { width: '0%' },
          to: { width: 'var(--score-width)' },
        },
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
    },
  },
  plugins: [],
}
