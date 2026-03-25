import type { MetadataRoute } from 'next'
import { siteConfig } from '@shared/siteConfig'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: siteConfig.name,
    short_name: 'InterviewGuru',
    description: siteConfig.shortDescription,
    start_url: '/',
    display: 'standalone',
    theme_color: '#ffffff',
    background_color: '#ffffff',
    icons: [
      { src: '/icon', sizes: '32x32', type: 'image/png' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  }
}
