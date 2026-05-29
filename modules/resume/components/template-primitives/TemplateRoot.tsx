import type { ReactNode } from 'react'

interface Props {
  className: string
  children: ReactNode
}

export default function TemplateRoot({ className, children }: Props) {
  return (
    <div className={className} style={{ fontSize: 'var(--r-body, 9px)' }}>
      {children}
    </div>
  )
}
