import type { TemplateProps } from './index'
import ClassicLayout from '../layouts/ClassicLayout'

export default function ProfessionalTemplate({ data }: TemplateProps) {
  return <ClassicLayout data={data} variantId="professional" />
}
