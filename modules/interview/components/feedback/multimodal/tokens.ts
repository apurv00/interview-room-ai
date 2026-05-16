/**
 * Multimodal Tab — Round 4 design tokens.
 *
 * Warm-neutral palette (Stone scale) chosen to give the Multimodal tab its
 * own moment-of-focus identity, distinct from the cool gray of the rest of
 * the feedback page. Mirrors the prototype's `COLORS_A` + `mc.minimal`.
 *
 * Why centralize: all of MultimodalReplayShell, Scrubber, SignalTrack,
 * VideoMetricChips, MomentsTabBody, TranscriptTabBody, CoachingTipsTabBody
 * import from one place. Single source of truth prevents per-component
 * drift.
 */

export const PALETTE = {
  bg: '#FAFAF9',           // stone-50
  surface: '#FFFFFF',
  surfaceAlt: '#F4F4F2',   // stone-100
  border: '#E7E5E4',       // stone-200
  borderStrong: '#D6D3D1', // stone-300
  text: '#1C1917',         // stone-900
  textSoft: '#57534E',     // stone-600
  textMuted: '#A8A29E',    // stone-400
  accent: '#2563EB',       // blue-600 (matches existing brand-600)
  accentSoft: '#EFF4FF',
  filler: '#FCE7E7',       // rose-100-ish
  fillerText: '#9F1239',   // rose-800
} as const

export type SignalKind = 'strength' | 'improvement' | 'coaching'

interface KindStyle {
  fg: string       // foreground (e.g. badge text, timestamp)
  bg: string       // soft background (expanded card surface)
  border: string   // soft border on cards
  dot: string      // solid marker color (timeline dots, signal-track bands)
}

export const KIND_STYLES: Record<SignalKind, KindStyle> = {
  strength: {
    fg: '#0F7A4D',
    bg: '#E6F4EC',
    border: '#BFE2CF',
    dot: '#10A368',
  },
  improvement: {
    fg: '#A55A09',
    bg: '#FDF3E2',
    border: '#F4D9A6',
    dot: '#E08E25',
  },
  coaching: {
    fg: '#4F3AA6',
    bg: '#EEE9FF',
    border: '#D7CCFF',
    dot: '#7A5CF0',
  },
}

/**
 * Map a TimelineEvent.type to the prototype's SignalKind taxonomy.
 * `coaching_tip` → `coaching`; everything else maps 1:1. The 'observation'
 * type isn't shown on this surface (filtered upstream in page.tsx's keyMoments
 * memo), so a default to 'coaching' there is just a safety fallback.
 */
export function timelineTypeToKind(type: string): SignalKind {
  if (type === 'strength') return 'strength'
  if (type === 'improvement') return 'improvement'
  return 'coaching' // coaching_tip + safety fallback
}

/**
 * Mono font stack — used for timestamps, metric labels, kind chip labels.
 * The project doesn't currently load Geist Mono; falls back to JetBrains
 * Mono → Menlo → ui-monospace. Geist adoption is a separate one-line PR.
 */
export const FONT_MONO = `"Geist Mono", "JetBrains Mono", ui-monospace, Menlo, monospace`

/** Tailwind class helper for the warm-neutral surface card. */
export const SURFACE_CARD_CLS = 'bg-white border border-stone-200 rounded-xl'
