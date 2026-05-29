import type { TemplateProps } from './index'
import StartupLayout from '../layouts/StartupLayout'

export default function StartupTemplate({ data }: TemplateProps) {
  return <StartupLayout data={data} variantId="startup" />
}
