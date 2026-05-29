import type { ResumeData } from '../../validators/resume'
import type { ExecutiveVariantId } from '../../config/executiveThemes'
import { getExecutiveTheme } from '../../config/executiveThemes'
import TemplateRoot from '../template-primitives/TemplateRoot'
import ResumeSkillsSection from '../ResumeSkillsSection'

interface Props {
  data: ResumeData
  variantId: ExecutiveVariantId
}

function ContactRow({ contact }: { contact: ResumeData['contactInfo'] }) {
  const c = contact || { fullName: '', email: '' }
  const sep = <span>|</span>
  return (
    <div className="flex items-center justify-center gap-2 text-[8px] text-gray-600 flex-wrap">
      {c.email && <span>{c.email}</span>}
      {c.phone && (
        <>
          {sep}
          <span>{c.phone}</span>
        </>
      )}
      {c.location && (
        <>
          {sep}
          <span>{c.location}</span>
        </>
      )}
      {c.linkedin && (
        <>
          {sep}
          <span>{c.linkedin}</span>
        </>
      )}
      {c.website && (
        <>
          {sep}
          <span>{c.website}</span>
        </>
      )}
      {c.github && (
        <>
          {sep}
          <span>{c.github}</span>
        </>
      )}
    </div>
  )
}

export default function ExecutiveLayout({ data, variantId }: Props) {
  const theme = getExecutiveTheme(variantId)
  const contact = data.contactInfo || { fullName: '', email: '' }
  const titleClass = theme.sectionTitleClass

  return (
    <TemplateRoot className="text-gray-900 leading-snug">
      <div className="text-center mb-3">
        <h1
          className={`font-bold ${theme.nameColorClass} tracking-widest uppercase`}
          style={{ fontSize: theme.nameSize }}
        >
          {contact.fullName || 'Your Name'}
        </h1>
        <hr className="my-1.5 border-t border-[#1e293b]" />
        <ContactRow contact={contact} />
      </div>

      {data.summary && (
        <div className="mb-3" data-resume-section="summary">
          <h2 data-resume-section-header={theme.summaryTitle} className={titleClass}>
            {theme.summaryTitle}
          </h2>
          <p className={`text-gray-700 leading-relaxed ${theme.summaryItalic ? 'italic' : ''}`}>
            {data.summary}
          </p>
        </div>
      )}

      {data.experience && data.experience.length > 0 && (
        <div className="mb-3" data-resume-section="experience">
          <h2 data-resume-section-header={theme.experienceTitle} className={titleClass}>
            {theme.experienceTitle}
          </h2>
          {data.experience.map(exp => (
            <div key={exp.id} className="mb-2" data-resume-section-unit>
              <div className="flex justify-between items-baseline">
                <div>
                  <span className={theme.experienceTitleUpper ? 'font-bold uppercase' : 'font-bold'}>
                    {exp.title}
                  </span>
                  {exp.company && <span> — {exp.company}</span>}
                </div>
                <span className="text-[8px] text-gray-500 shrink-0 ml-2">
                  {exp.startDate} - {exp.endDate || 'Present'}
                </span>
              </div>
              {exp.location && <div className="text-[8px] text-gray-500">{exp.location}</div>}
              {exp.bullets.filter(b => b.trim()).length > 0 && (
                <ul className="mt-0.5 space-y-0.5">
                  {exp.bullets.filter(b => b.trim()).map((bullet, i) => (
                    <li key={i} className="text-gray-700 flex items-start gap-1">
                      <span className="shrink-0 mt-[2px] text-[#1e293b] font-bold text-[7px]">
                        &#9654;
                      </span>
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {data.education && data.education.length > 0 && (
        <div className="mb-3" data-resume-section="education">
          <h2 data-resume-section-header="Education" className={titleClass}>
            Education
          </h2>
          {data.education.map(edu => (
            <div key={edu.id} className="mb-1.5" data-resume-section-unit>
              <div className="flex justify-between items-baseline">
                <div>
                  <span className="font-bold">{edu.degree}</span>
                  {edu.field && <span> in {edu.field}</span>}
                  {edu.institution && <span> — {edu.institution}</span>}
                </div>
                {edu.graduationDate && (
                  <span className="text-[8px] text-gray-500 shrink-0 ml-2">
                    {edu.graduationDate}
                  </span>
                )}
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

      {data.skills && data.skills.length > 0 && (
        <ResumeSkillsSection
          skills={data.skills}
          title={theme.skillsTitle}
          sectionClassName={
            theme.skillsGrid ? 'mb-3 grid grid-cols-3 gap-x-4 gap-y-0.5' : 'mb-3'
          }
          headerClassName={`${titleClass} ${theme.skillsGrid ? 'col-span-3' : ''}`}
          renderCategory={cat => (
            <div>
              <span className="font-semibold">{cat.category}:</span>{' '}
              <span className="text-gray-700">{cat.items.join(', ')}</span>
            </div>
          )}
        />
      )}

      {data.projects && data.projects.length > 0 && (
        <div className="mb-3" data-resume-section="projects">
          <h2 data-resume-section-header={theme.projectsTitle} className={titleClass}>
            {theme.projectsTitle}
          </h2>
          {data.projects.map(proj => (
            <div key={proj.id} className="mb-1.5" data-resume-section-unit>
              <span className="font-bold">{proj.name}</span>
              {proj.technologies?.length ? (
                <span className="text-[8px] text-gray-500">
                  {' '}
                  ({proj.technologies.join(', ')})
                </span>
              ) : null}
              <p className="text-gray-700">{proj.description}</p>
            </div>
          ))}
        </div>
      )}

      {data.certifications && data.certifications.length > 0 && (
        <div className="mb-3" data-resume-section="certifications">
          <h2 data-resume-section-header={theme.certificationsTitle} className={titleClass}>
            {theme.certificationsTitle}
          </h2>
          {data.certifications.map((cert, i) => (
            <div key={i} className="mb-0.5" data-resume-section-unit>
              <span className="font-semibold">{cert.name}</span> — {cert.issuer}
              {cert.date && <span className="text-gray-500"> ({cert.date})</span>}
            </div>
          ))}
        </div>
      )}

      {data.customSections?.map(section => (
        <div key={section.id} className="mb-3" data-resume-section={`custom-${section.id}`}>
          <h2 data-resume-section-header={section.title} className={titleClass}>
            {section.title}
          </h2>
          <p className="text-gray-700 whitespace-pre-wrap">{section.content}</p>
        </div>
      ))}
    </TemplateRoot>
  )
}
