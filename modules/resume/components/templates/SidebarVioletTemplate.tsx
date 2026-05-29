import type { TemplateProps } from './index'
import SidebarLayout from '../layouts/SidebarLayout'

export default function SidebarVioletTemplate({ data }: TemplateProps) {
  return <SidebarLayout data={data} variantId="sidebar-violet" />
}
