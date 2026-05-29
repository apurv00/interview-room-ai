import type { TemplateProps } from './index'
import ModernLayout from '../layouts/ModernLayout'

export default function ModernRoseTemplate({ data }: TemplateProps) {
  return <ModernLayout data={data} variantId="modern-rose" />
}
