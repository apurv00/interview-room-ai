import type { TemplateProps } from './index'
import CareerChangeLayout from '../layouts/CareerChangeLayout'

export default function CareerChangeTemplate({ data }: TemplateProps) {
  return <CareerChangeLayout data={data} variantId="career-change" />
}
