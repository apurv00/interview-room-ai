import type { TemplateProps } from './index'
import EarlyCareerLayout from '../layouts/EarlyCareerLayout'

export default function EntryLevelTemplate({ data }: TemplateProps) {
  return <EarlyCareerLayout data={data} variantId="entry-level" />
}
