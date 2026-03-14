import type { TemplateProps } from './index'

export default function AcademicTemplate({ data }: TemplateProps) {
  const contact = data.contactInfo || { fullName: '', email: '' }

  return (
    <div className="text-gray-900 leading-snug" style={{ fontSize: 'var(--r-body, 9px)' }}>
      {/* Header */}
      <div className="text-center border-b-2 border-blue-700 pb-1.5 mb-2">
        <h1 className="font-bold tracking-wide" style={{ fontSize: 'var(--r-title, 18px)' }}>{contact.fullName || 'Your Name'}</h1>
        <div className="flex items-center justify-center gap-2 text-[8px] text-gray-600 mt-0.5 flex-wrap">
          {contact.email && <span>{contact.email}</span>}
          {contact.phone && <><span>|</span><span>{contact.phone}</span></>}
          {contact.location && <><span>|</span><span>{contact.location}</span></>}
          {contact.linkedin && <><span>|</span><span>{contact.linkedin}</span></>}
          {contact.website && <><span>|</span><span>{contact.website}</span></>}
          {contact.github && <><span>|</span><span>{contact.github}</span></>}
        </div>
      </div>

      {/* Summary / Research Interests */}
      {data.summary && (
        <div className="mb-2">
          <h2 className="font-bold uppercase tracking-widest text-blue-700 border-b border-blue-300 pb-0.5 mb-1">Research Interests</h2>
          <p className="text-gray-700 leading-relaxed">{data.summary}</p>
        </div>
      )}

      {/* Education First */}
      {data.education && data.education.length > 0 && (
        <div className="mb-2">
          <h2 className="font-bold uppercase tracking-widest text-blue-700 border-b border-blue-300 pb-0.5 mb-1">Education</h2>
          {data.education.map(edu => (
            <div key={edu.id} className="mb-1">
              <div className="flex justify-between items-baseline">
                <div>
                  <span className="font-bold">{edu.degree}</span>
                  {edu.field && <span> in {edu.field}</span>}
                  {edu.institution && <span> — {edu.institution}</span>}
                </div>
                {edu.graduationDate && <span className="text-[8px] text-gray-500 shrink-0 ml-2">{edu.graduationDate}</span>}
              </div>
              {(edu.gpa || edu.honors) && (
                <div className="text-[8px] text-gray-500">
                  {edu.gpa && <span>GPA: {edu.gpa}</span>}
                  {edu.gpa && edu.honors && <span> | </span>}
                  {edu.honors && <span>{edu.honors}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Experience (Research Experience) */}
      {data.experience && data.experience.length > 0 && (
        <div className="mb-2">
          <h2 className="font-bold uppercase tracking-widest text-blue-700 border-b border-blue-300 pb-0.5 mb-1">Research Experience</h2>
          {data.experience.map(exp => (
            <div key={exp.id} className="mb-1.5">
              <div className="flex justify-between items-baseline">
                <div>
                  <span className="font-bold">{exp.title}</span>
                  {exp.company && <span> — {exp.company}</span>}
                </div>
                <span className="text-[8px] text-gray-500 shrink-0 ml-2">{exp.startDate} - {exp.endDate || 'Present'}</span>
              </div>
              {exp.location && <div className="text-[8px] text-gray-500">{exp.location}</div>}
              {exp.bullets.filter(b => b.trim()).length > 0 && (
                <ul className="mt-0.5 space-y-0.5">
                  {exp.bullets.filter(b => b.trim()).map((bullet, i) => (
                    <li key={i} className="text-gray-700 flex items-start gap-1">
                      <span className="shrink-0 mt-[3px] w-1 h-1 bg-blue-700 rounded-full" />
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Skills */}
      {data.skills && data.skills.length > 0 && (
        <div className="mb-2">
          <h2 className="font-bold uppercase tracking-widest text-blue-700 border-b border-blue-300 pb-0.5 mb-1">Technical Skills</h2>
          {data.skills.map((cat, i) => (
            <div key={i} className="mb-0.5">
              <span className="font-semibold">{cat.category}:</span>{' '}
              <span className="text-gray-700">{cat.items.join(', ')}</span>
            </div>
          ))}
        </div>
      )}

      {/* Projects */}
      {data.projects && data.projects.length > 0 && (
        <div className="mb-2">
          <h2 className="font-bold uppercase tracking-widest text-blue-700 border-b border-blue-300 pb-0.5 mb-1">Projects</h2>
          {data.projects.map(proj => (
            <div key={proj.id} className="mb-1">
              <span className="font-bold">{proj.name}</span>
              {proj.technologies?.length ? <span className="text-[8px] text-gray-500"> ({proj.technologies.join(', ')})</span> : null}
              {proj.url && <span className="text-[8px] text-blue-700 ml-1">{proj.url}</span>}
              <p className="text-gray-700">{proj.description}</p>
            </div>
          ))}
        </div>
      )}

      {/* Certifications */}
      {data.certifications && data.certifications.length > 0 && (
        <div className="mb-2">
          <h2 className="font-bold uppercase tracking-widest text-blue-700 border-b border-blue-300 pb-0.5 mb-1">Certifications</h2>
          {data.certifications.map((cert, i) => (
            <div key={i} className="mb-0.5">
              <span className="font-semibold">{cert.name}</span> — {cert.issuer}
              {cert.date && <span className="text-gray-500"> ({cert.date})</span>}
            </div>
          ))}
        </div>
      )}

      {/* Custom Sections (Publications, Research, etc.) */}
      {data.customSections?.map(section => (
        <div key={section.id} className="mb-2">
          <h2 className="font-bold uppercase tracking-widest text-blue-700 border-b border-blue-300 pb-0.5 mb-1">{section.title}</h2>
          <p className="text-gray-700 whitespace-pre-wrap">{section.content}</p>
        </div>
      ))}
    </div>
  )
}
