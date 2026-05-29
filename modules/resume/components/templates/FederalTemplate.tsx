import type { TemplateProps } from './index'
import ClassicLayout from '../layouts/ClassicLayout'

export default function FederalTemplate({ data }: TemplateProps) {
  return <ClassicLayout data={data} variantId="federal" />
}
