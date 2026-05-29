import type { TemplateProps } from './index'
import ExecutiveLayout from '../layouts/ExecutiveLayout'

export default function ExecutiveGoldTemplate({ data }: TemplateProps) {
  return <ExecutiveLayout data={data} variantId="executive-gold" />
}
