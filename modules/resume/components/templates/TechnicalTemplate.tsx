import type { TemplateProps } from './index'
import TechnicalLayout from '../layouts/TechnicalLayout'

export default function TechnicalTemplate({ data }: TemplateProps) {
  return <TechnicalLayout data={data} variantId="technical" />
}
