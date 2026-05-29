import type { ResumeData } from '../../validators/resume'
import type { CareerChangeVariantId } from '../../config/careerChangeThemes'
import { getCareerChangeTheme } from '../../config/careerChangeThemes'
import TemplateRoot from '../template-primitives/TemplateRoot'
import ResumeSkillsSection from '../ResumeSkillsSection'

interface Props {
  data: ResumeData
  variantId: CareerChangeVariantId
}

export default function CareerChangeLayout({ data, variantId }: Props) {
  const theme = getCareerChangeTheme(variantId)
  const contact = data.contactInfo || { fullName: '', email: '' }
  const titleClass = theme.sectionTitleClass
  const sep = <span>|</span>

  return (
    <TemplateRoot className="text-gray-900 leading-snug">
      <div className={theme.headerBorderClass}>
        <h1 className={theme.nameClass} style={{ fontSize: theme.nameSize }}>
          {contact.fullName || 'Your Name'}
        </h1>
        <div className={theme.contactRowClass}>
          {contact.email && <span>{contact.email}</span>}
          {contact.phone && (
            <>
              {sep}
              <span>{contact.phone}</span>
            </>
          )}
          {contact.location && (
            <>
              {sep}
              <span>{contact.location}</span>
            </>
          )}
          {contact.linkedin && (
            <>
              {sep}
              <span>{contact.linkedin}</span>
            </>
          )}
          {contact.website && (
            <>
              {sep}
              <span>{contact.website}</span>
            </>
          )}
          {contact.github && (
            <>
              {sep}
              <span>{contact.github}</span>
            </>
          )}
        </div>
      </div>

      {data.summary && (
        <div className="mb-3" data-resume-section="summary">
          <h2 data-resume-section-header={theme.summaryTitle} className={titleClass}>
            {theme.summaryTitle}
          </h2>
          <p className="text-gray-700 leading-relaxed">{data.summary}</p>
        </div>
      )}

      {data.skills && data.skills.length > 0 && (
        <ResumeSkillsSection
          skills={data.skills}
          title={theme.skillsTitle}
          sectionClassName="mb-3"
          headerClassName={titleClass}
          renderCategory={cat => (
            <div className="mb-1.5">
              <div className={theme.skillCategoryClass}>{cat.category}</div>
              <div className="grid grid-cols-3 gap-x-3 gap-y-1 mt-1">
                {cat.items.map((skill, i) => (
                  <div key={i} className="text-gray-700 flex items-center gap-1">
                    <span className={`w-1 h-1 rounded-full shrink-0 ${theme.bulletDotClass}`} />
                    <span>{skill}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        />
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
                  <span className="font-bold">{exp.title}</span>
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
                      <span
                        className={`shrink-0 mt-[3px] w-1 h-1 rounded-full ${theme.bulletDotClass}`}
                      />
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
          <h2 data-resume-section-header={theme.educationTitle} className={titleClass}>
            {theme.educationTitle}
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

      {data.projects && data.projects.length > 0 && (
        <div className="mb-3" data-resume-section="projects">
          <h2 data-resume-section-header="Projects" className={titleClass}>
            Projects
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
              {proj.url && <span className={theme.projectUrlClass}>{proj.url}</span>}
              <p className="text-gray-700">{proj.description}</p>
            </div>
          ))}
        </div>
      )}

      {data.certifications && data.certifications.length > 0 && (
        <div className="mb-3" data-resume-section="certifications">
          <h2 data-resume-section-header="Certifications" className={titleClass}>
            Certifications
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
