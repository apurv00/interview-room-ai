import type { Metadata } from 'next'
import ModulesWorkspace from './ModulesWorkspace'

export const metadata: Metadata = {
  title: 'Modules | IPG Hire',
}

export default function ModulesPage() {
  return <ModulesWorkspace />
}
