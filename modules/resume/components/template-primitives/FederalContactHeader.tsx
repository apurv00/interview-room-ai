import type { ResumeData } from '../../validators/resume'
import type { ClassicTheme } from '../../config/classicThemes'

interface Props {
  contact: NonNullable<ResumeData['contactInfo']>
  theme: ClassicTheme
}

/** USAJobs-style stacked contact block (not inline pipes). */
export default function FederalContactHeader({ contact, theme }: Props) {
  const { contact: c } = theme

  return (
    <div className={c.wrapperClass}>
      <h1 className={c.nameClass} style={{ fontSize: 'var(--r-title, 16px)' }}>
        {contact.fullName || 'Your Name'}
      </h1>
      <div className={c.rowClass}>
        {contact.email && <div>{contact.email}</div>}
        {contact.phone && <div>{contact.phone}</div>}
        {contact.location && <div>{contact.location}</div>}
        {contact.linkedin && <div>{contact.linkedin}</div>}
        {contact.website && <div>{contact.website}</div>}
        {contact.github && <div>{contact.github}</div>}
      </div>
    </div>
  )
}
