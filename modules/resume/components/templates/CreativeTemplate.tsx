import type { TemplateProps } from './index'
import SidebarLayout from '../layouts/SidebarLayout'

export default function CreativeTemplate({ data }: TemplateProps) {
  return <SidebarLayout data={data} variantId="creative" />
}
