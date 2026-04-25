import { ImageResponse } from 'next/og'

export const runtime = 'edge'
export const size = { width: 32, height: 32 }
export const contentType = 'image/png'

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: '#1d4ed8',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg width="20" height="20" viewBox="0 0 64 64" fill="none">
          <path d="M32 16 L52 26 L32 36 L12 26 Z" fill="white" />
          <path d="M22 32 V40 C22 43 26.5 45 32 45 C37.5 45 42 43 42 40 V32" fill="white" />
          <path d="M50 26 V40" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="50" cy="44" r="3" fill="white" />
        </svg>
      </div>
    ),
    { ...size }
  )
}
