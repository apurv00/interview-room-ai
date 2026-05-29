import type { TemplateProps } from './index'
import ExecutiveLayout from '../layouts/ExecutiveLayout'

export default function ExecutiveTemplate({ data }: TemplateProps) {
  return <ExecutiveLayout data={data} variantId="executive" />
}
