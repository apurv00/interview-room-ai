import { ImageResponse } from 'next/og'
import { siteConfig } from '@shared/siteConfig'

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
          background: 'linear-gradient(135deg, #ffffff 0%, #eef2ff 50%, #ffffff 100%)',
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
            background: '#1d4ed8',
            marginBottom: 32,
          }}
        >
          <svg width="48" height="48" viewBox="0 0 64 64" fill="none">
            <path d="M32 16 L52 26 L32 36 L12 26 Z" fill="white" />
            <path d="M22 32 V40 C22 43 26.5 45 32 45 C37.5 45 42 43 42 40 V32" fill="white" />
            <path d="M50 26 V40" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
            <circle cx="50" cy="44" r="3" fill="white" />
          </svg>
        </div>
        <div
          style={{
            fontSize: 56,
            fontWeight: 800,
            color: '#0f1419',
            letterSpacing: '-0.02em',
            marginBottom: 16,
          }}
        >
          {siteConfig.name}
        </div>
        <div
          style={{
            fontSize: 24,
            color: '#536471',
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
