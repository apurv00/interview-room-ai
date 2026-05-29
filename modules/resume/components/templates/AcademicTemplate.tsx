import type { TemplateProps } from './index'
import EarlyCareerLayout from '../layouts/EarlyCareerLayout'

export default function AcademicTemplate({ data }: TemplateProps) {
  return <EarlyCareerLayout data={data} variantId="academic" />
}
