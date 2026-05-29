import type { ResumeData } from '../../validators/resume'
import type { ClassicTheme } from '../../config/classicThemes'

interface Props {
  contact: NonNullable<ResumeData['contactInfo']>
  theme: ClassicTheme
}

export default function ClassicContactHeader({ contact, theme }: Props) {
  const { contact: c } = theme

  return (
    <div className={c.wrapperClass}>
      <h1 className={c.nameClass} style={{ fontSize: 'var(--r-title, 18px)' }}>
        {contact.fullName || 'Your Name'}
      </h1>
      <div className={c.rowClass}>
        {contact.email && <span>{contact.email}</span>}
        {contact.phone && (
          c.usePipeSeparators ? (
            <><span>|</span><span>{contact.phone}</span></>
          ) : (
            <span>{contact.phone}</span>
          )
        )}
        {contact.location && (
          c.usePipeSeparators ? (
            <><span>|</span><span>{contact.location}</span></>
          ) : (
            <span>{contact.location}</span>
          )
        )}
        {contact.linkedin && (
          c.usePipeSeparators ? (
            <><span>|</span><span>{contact.linkedin}</span></>
          ) : (
            <span>{contact.linkedin}</span>
          )
        )}
        {contact.website && (
          c.usePipeSeparators ? (
            <><span>|</span><span>{contact.website}</span></>
          ) : (
            <span>{contact.website}</span>
          )
        )}
        {c.showGithub && contact.github && <span>{contact.github}</span>}
      </div>
      {c.trailingHr ? <hr className="mt-2 border-t border-gray-200" /> : null}
    </div>
  )
}
