import { ImageResponse } from 'next/og'
import { siteConfig } from '@/lib/siteConfig'

export const runtime = 'edge'
export const alt = siteConfig.name
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #070b14 0%, #1e1b4b 50%, #070b14 100%)',
          fontFamily: 'sans-serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 80,
            height: 80,
            borderRadius: 20,
            background: '#4f46e5',
            marginBottom: 32,
          }}
        >
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
          </svg>
        </div>
        <div
          style={{
            fontSize: 56,
            fontWeight: 800,
            color: 'white',
            letterSpacing: '-0.02em',
            marginBottom: 16,
          }}
        >
          {siteConfig.name}
        </div>
        <div
          style={{
            fontSize: 24,
            color: '#94a3b8',
            maxWidth: 700,
            textAlign: 'center',
            lineHeight: 1.4,
          }}
        >
          AI-powered mock interviews with realistic HR screening simulation
        </div>
      </div>
    ),
    { ...size }
  )
}
