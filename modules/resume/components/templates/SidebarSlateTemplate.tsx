import type { TemplateProps } from './index'
import SidebarLayout from '../layouts/SidebarLayout'

export default function SidebarSlateTemplate({ data }: TemplateProps) {
  return <SidebarLayout data={data} variantId="sidebar-slate" />
}
