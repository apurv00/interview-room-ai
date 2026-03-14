import type { TemplateProps } from './index'

export default function TechnicalTemplate({ data }: TemplateProps) {
  const contact = data.contactInfo || { fullName: '', email: '' }

  return (
    <div className="text-gray-900 leading-snug" style={{ fontSize: 'var(--r-body, 9px)' }}>
      {/* Header */}
      <div className="border-b-2 border-emerald-600 pb-2 mb-3">
        <h1 className="font-bold" style={{ fontSize: 'var(--r-title, 18px)' }}>{contact.fullName || 'Your Name'}</h1>
        <div className="flex items-center gap-2 text-[8px] text-gray-600 mt-0.5 flex-wrap">
          {contact.email && <span>{contact.email}</span>}
          {contact.phone && <><span>|</span><span>{contact.phone}</span></>}
          {contact.location && <><span>|</span><span>{contact.location}</span></>}
          {contact.github && <><span>|</span><span>{contact.github}</span></>}
          {contact.linkedin && <><span>|</span><span>{contact.linkedin}</span></>}
        </div>
      </div>

      {/* Skills first for technical template */}
      {data.skills && data.skills.length > 0 && (
        <div className="mb-3">
          <h2 className="font-bold uppercase text-emerald-700 mb-1">Technical Skills</h2>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            {data.skills.map((cat, i) => (
              <div key={i}>
                <span className="font-semibold">{cat.category}:</span>{' '}
                <span className="text-gray-700">{cat.items.join(', ')}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Summary */}
      {data.summary && (
        <div className="mb-3">
          <h2 className="font-bold uppercase text-emerald-700 mb-1">Summary</h2>
          <p className="text-gray-700">{data.summary}</p>
        </div>
      )}

      {/* Experience */}
      {data.experience && data.experience.length > 0 && (
        <div className="mb-3">
          <h2 className="font-bold uppercase text-emerald-700 mb-1">Experience</h2>
          {data.experience.map(exp => (
            <div key={exp.id} className="mb-2">
              <div className="flex justify-between">
                <span className="font-bold">{exp.title} @ {exp.company}</span>
                <span className="text-[8px] text-gray-500">{exp.startDate} - {exp.endDate || 'Present'}</span>
              </div>
              {exp.bullets.filter(b => b.trim()).length > 0 && (
                <ul className="mt-0.5 space-y-0.5 ml-2">
                  {exp.bullets.filter(b => b.trim()).map((b, i) => (
                    <li key={i} className="text-gray-700 before:content-['▸'] before:mr-1 before:text-emerald-500">{b}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Projects */}
      {data.projects && data.projects.length > 0 && (
        <div className="mb-3">
          <h2 className="font-bold uppercase text-emerald-700 mb-1">Projects</h2>
          {data.projects.map(proj => (
            <div key={proj.id} className="mb-1.5">
              <div className="flex items-baseline gap-1">
                <span className="font-bold">{proj.name}</span>
                {proj.url && <span className="text-[8px] text-emerald-600">[{proj.url}]</span>}
              </div>
              {proj.technologies?.length ? <div className="text-[8px] text-gray-500">Stack: {proj.technologies.join(' · ')}</div> : null}
              <p className="text-gray-700">{proj.description}</p>
            </div>
          ))}
        </div>
      )}

      {/* Education */}
      {data.education && data.education.length > 0 && (
        <div className="mb-3">
          <h2 className="font-bold uppercase text-emerald-700 mb-1">Education</h2>
          {data.education.map(edu => (
            <div key={edu.id} className="mb-1">
              <span className="font-bold">{edu.degree}</span>
              {edu.field && <span> in {edu.field}</span>}
              {edu.institution && <span> — {edu.institution}</span>}
              {edu.graduationDate && <span className="text-gray-500"> ({edu.graduationDate})</span>}
            </div>
          ))}
        </div>
      )}

      {data.certifications && data.certifications.length > 0 && (
        <div className="mb-3">
          <h2 className="font-bold uppercase text-emerald-700 mb-1">Certifications</h2>
          {data.certifications.map((c, i) => <div key={i}>{c.name} — {c.issuer} {c.date && `(${c.date})`}</div>)}
        </div>
      )}

      {data.customSections?.map(s => (
        <div key={s.id} className="mb-3">
          <h2 className="font-bold uppercase text-emerald-700 mb-1">{s.title}</h2>
          <p className="text-gray-700 whitespace-pre-wrap">{s.content}</p>
        </div>
      ))}
    </div>
  )
}
