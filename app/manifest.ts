import type { MetadataRoute } from 'next'
import { siteConfig } from '@/lib/siteConfig'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: siteConfig.name,
    short_name: 'InterviewGuru',
    description: siteConfig.shortDescription,
    start_url: '/',
    display: 'standalone',
    theme_color: '#070b14',
    background_color: '#070b14',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  }
}
