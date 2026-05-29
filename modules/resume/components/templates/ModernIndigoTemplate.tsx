import type { TemplateProps } from './index'
import ModernLayout from '../layouts/ModernLayout'

export default function ModernIndigoTemplate({ data }: TemplateProps) {
  return <ModernLayout data={data} variantId="modern-indigo" />
}
