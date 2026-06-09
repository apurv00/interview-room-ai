import { describe, it, expect } from 'vitest'
import { CreateCategorySchema, UpdateCategorySchema } from '@cms/validators/cms'

describe('Category validators', () => {
  it('accepts a valid category', () => {
    const r = CreateCategorySchema.safeParse({
      slug: 'core-engineering', label: 'Core Engineering', icon: '⚙️',
      description: 'Mechanical, civil, electrical & more', sortOrder: 3,
    })
    expect(r.success).toBe(true)
  })

  it('requires a slug-shaped slug and a label', () => {
    expect(CreateCategorySchema.safeParse({ slug: 'Core Engineering', label: 'X' }).success).toBe(false) // space/caps
    expect(CreateCategorySchema.safeParse({ icon: '⚙️' }).success).toBe(false) // missing slug + label
  })

  it('UpdateCategorySchema accepts partial updates incl. isActive', () => {
    expect(UpdateCategorySchema.safeParse({ isActive: false }).success).toBe(true)
    expect(UpdateCategorySchema.safeParse({ sortOrder: 5 }).success).toBe(true)
    expect(UpdateCategorySchema.safeParse({}).success).toBe(true)
  })
})
