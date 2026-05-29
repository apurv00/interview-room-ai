import type { TemplateProps } from './index'
import ClassicLayout from '../layouts/ClassicLayout'

export default function ClassicNavyTemplate({ data }: TemplateProps) {
  return <ClassicLayout data={data} variantId="classic-navy" />
}
