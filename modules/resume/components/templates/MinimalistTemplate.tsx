import type { TemplateProps } from './index'
import ClassicLayout from '../layouts/ClassicLayout'

export default function MinimalistTemplate({ data }: TemplateProps) {
  return <ClassicLayout data={data} variantId="minimalist" />
}
