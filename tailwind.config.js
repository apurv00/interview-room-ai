/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef2ff',
          100: '#e0e7ff',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          900: '#1e1b4b',
        },
        page: '#070b14',
        card: '#0c1220',
        surface: '#151d2e',
        raised: '#1c2539',
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
        DEFAULT: 'rgba(255,255,255,0.10)',
      },
      animation: {
        'pulse-slow': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'blink': 'blink 4s ease-in-out infinite',
        'talk': 'talk 0.15s ease-in-out infinite alternate',
        'fade-in': 'fadeIn 0.3s ease-out',
        'score-fill': 'scoreFill 1s ease-out forwards',
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
      },
    },
  },
  plugins: [],
}
