import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import JobWorkspaceHeader from '../JobWorkspaceHeader'

describe('JobWorkspaceHeader', () => {
  it('wraps valid long title and department metadata instead of truncating them', () => {
    const longTitle = 'T'.repeat(200)
    const longDepartment = 'D'.repeat(120)

    render(
      <JobWorkspaceHeader
        title={longTitle}
        status="open"
        departmentName={longDepartment}
        candidateCount={1_024}
      />,
    )

    const heading = screen.getByRole('heading', { name: longTitle })
    expect(heading).toHaveClass('min-w-0', 'max-w-full', 'break-words')
    expect(heading).not.toHaveClass('truncate')

    const metadata = screen.getByText(longDepartment).closest('p')
    expect(metadata).toHaveClass('min-w-0', 'max-w-full', 'break-words')
    expect(metadata).not.toHaveClass('truncate')
    expect(metadata).toHaveTextContent('1,024 candidates')
  })
})
