import type { TemplateProps } from './index'
import TechnicalLayout from '../layouts/TechnicalLayout'

export default function TechnicalSlateTemplate({ data }: TemplateProps) {
  return <TechnicalLayout data={data} variantId="technical-slate" />
}
