export const tokens = {
  color: {
    bg: {
      page: '#070b14',
      card: '#0c1220',
      surface: '#151d2e',
      raised: '#1c2539',
      overlay: 'rgba(0,0,0,0.65)',
    },
    border: {
      subtle: 'rgba(255,255,255,0.06)',
      default: 'rgba(255,255,255,0.10)',
      strong: 'rgba(255,255,255,0.15)',
      focus: '#6366f1',
    },
    text: {
      primary: '#f0f2f5',
      secondary: '#b0b8c4',
      tertiary: '#6b7280',
      muted: '#4b5563',
      disabled: '#374151',
    },
    primary: {
      text: '#818cf8',
      surface: 'rgba(99,102,241,0.08)',
      border: 'rgba(99,102,241,0.15)',
      solid: '#6366f1',
      hover: '#5558e6',
    },
    success: {
      text: '#34d399',
      surface: 'rgba(16,185,129,0.08)',
      border: 'rgba(16,185,129,0.15)',
    },
    caution: {
      text: '#fbbf24',
      surface: 'rgba(245,158,11,0.08)',
      border: 'rgba(245,158,11,0.15)',
    },
    danger: {
      text: '#f87171',
      surface: 'rgba(239,68,68,0.08)',
      border: 'rgba(239,68,68,0.15)',
    },
  },

  text: {
    display: { size: '2.25rem', weight: '700', tracking: '-0.02em', height: '1.2' },
    heading: { size: '1.5rem', weight: '600', tracking: '-0.01em', height: '1.3' },
    subheading: { size: '1rem', weight: '600', tracking: '0', height: '1.4' },
    body: { size: '0.875rem', weight: '400', tracking: '0', height: '1.6' },
    caption: { size: '0.75rem', weight: '500', tracking: '0', height: '1.5' },
    micro: { size: '0.6875rem', weight: '500', tracking: '0.02em', height: '1.4' },
  },

  space: {
    inline: '6px',
    element: '12px',
    component: '16px',
    section: '32px',
    region: '56px',
  },

  radius: {
    sm: '6px',
    md: '10px',
    lg: '14px',
    full: '9999px',
  },

  shadow: {
    sm: '0 2px 8px rgba(0,0,0,0.3)',
    md: '0 8px 24px rgba(0,0,0,0.4)',
    glow: '0 0 20px rgba(99,102,241,0.3)',
  },

  motion: {
    fast: '120ms',
    normal: '250ms',
    slow: '400ms',
    easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
    spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  },

  layout: {
    maxWidth: {
      narrow: '640px',
      content: '800px',
      page: '1000px',
      wide: '1200px',
    },
    headerHeight: '52px',
  },
} as const;
