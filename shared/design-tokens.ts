export const tokens = {
  color: {
    bg: {
      page: '#ffffff',
      card: '#ffffff',
      surface: '#f7f9f9',
      raised: '#eff3f4',
      overlay: 'rgba(0,0,0,0.4)',
    },
    border: {
      subtle: '#eff3f4',
      default: '#e1e8ed',
      strong: '#cfd9de',
      focus: '#2563eb',
    },
    text: {
      primary: '#0f1419',
      secondary: '#536471',
      tertiary: '#71767b',
      muted: '#8b98a5',
      disabled: '#cfd9de',
    },
    primary: {
      text: '#2563eb',
      surface: 'rgba(37,99,235,0.08)',
      border: 'rgba(37,99,235,0.15)',
      solid: '#2563eb',
      hover: '#1d4ed8',
    },
    success: {
      text: '#059669',
      surface: 'rgba(16,185,129,0.08)',
      border: 'rgba(16,185,129,0.2)',
    },
    caution: {
      text: '#d97706',
      surface: 'rgba(245,158,11,0.08)',
      border: 'rgba(245,158,11,0.2)',
    },
    danger: {
      text: '#f4212e',
      surface: 'rgba(244,33,46,0.06)',
      border: 'rgba(244,33,46,0.15)',
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
    sm: '0 2px 8px rgba(0,0,0,0.06)',
    md: '0 8px 24px rgba(0,0,0,0.08)',
    glow: '0 0 20px rgba(37,99,235,0.25)',
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
