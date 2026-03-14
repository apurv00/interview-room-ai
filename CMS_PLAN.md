# CMS Platform Plan — Interview Prep Guru

> Scalable, subdomain-based Content Management System for the Interview Prep Guru platform.
> Subdomain: `cms.interviewprep.guru` (admin) / `content.interviewprep.guru` (public content delivery)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Subdomain Strategy](#2-subdomain-strategy)
3. [Content Modeling](#3-content-modeling)
4. [Database Schema Design](#4-database-schema-design)
5. [API Design](#5-api-design)
6. [CMS Admin UI](#6-cms-admin-ui)
7. [Content Workflow & Publishing](#7-content-workflow--publishing)
8. [Media Management](#8-media-management)
9. [RBAC & Permissions](#9-rbac--permissions)
10. [SEO & Content Delivery](#10-seo--content-delivery)
11. [Caching Strategy](#11-caching-strategy)
12. [Search & Discovery](#12-search--discovery)
13. [AI-Powered Features](#13-ai-powered-features)
14. [Multi-Tenant Scalability](#14-multi-tenant-scalability)
15. [Implementation Phases](#15-implementation-phases)
16. [File Structure](#16-file-structure)
17. [Environment & Infrastructure](#17-environment--infrastructure)

---

## 1. Architecture Overview

### Design Principles

- **Single Next.js deployment** — CMS lives alongside the existing app using middleware-based subdomain routing. No separate deployments to manage.
- **Headless-first** — All content is served through APIs. The CMS admin is a dedicated UI, but content is consumed by any client (main app, blog, marketing site, mobile).
- **Schema-driven** — Content types are defined dynamically in the database, not hardcoded. New content types (blog posts, guides, FAQs, landing pages, case studies) can be added without code changes.
- **Tenant-aware from day one** — Every content document is scoped to a `siteId`. The main platform is the default site, but B2B organizations can eventually manage their own content.

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SINGLE NEXT.JS APP                          │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │  Main App        │  │  CMS Admin       │  │  Content Delivery│  │
│  │  app/(app)/      │  │  app/(cms)/      │  │  app/(content)/  │  │
│  │  interviewprep   │  │  cms.domain.com  │  │  content.domain  │  │
│  │  guru.com        │  │                  │  │  .com            │  │
│  └──────┬───────────┘  └──────┬───────────┘  └──────┬───────────┘  │
│         │                     │                     │               │
│  ┌──────┴─────────────────────┴─────────────────────┴───────────┐  │
│  │                     middleware.ts                              │  │
│  │    Subdomain detection → Route group rewriting                │  │
│  └──────┬────────────────────────────────────────────────────────┘  │
│         │                                                           │
│  ┌──────┴─────────────────────────────────────────────────────────┐│
│  │                        API Layer                                ││
│  │  app/api/cms/v1/admin/*   (CRUD, workflow, media, settings)    ││
│  │  app/api/cms/v1/public/*  (read-only, cached content delivery) ││
│  └──────┬────────────────────────────────────────────────────────┘│
│         │                                                          │
│  ┌──────┴─────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  MongoDB        │  │  Redis       │  │  R2/S3 Object Storage  │ │
│  │  (Mongoose)     │  │  (ioredis)   │  │  (media assets)        │ │
│  └─────────────────┘  └──────────────┘  └────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Subdomain Strategy

### Routing via Middleware

The existing `middleware.ts` (NextAuth-based) is extended to detect subdomains and rewrite to the appropriate route group.

```
Request: cms.interviewprep.guru/dashboard
  → middleware detects subdomain "cms"
  → rewrites to /cms/dashboard (route group: app/(cms)/cms/dashboard/page.tsx)

Request: content.interviewprep.guru/blog/ace-your-hr-interview
  → middleware detects subdomain "content"
  → rewrites to /content/blog/ace-your-hr-interview (route group: app/(content)/)
```

### Middleware Changes

```typescript
// In middleware.ts — added BEFORE existing withAuth logic

const hostname = req.headers.get('host') || ''
const currentHost = hostname.split(':')[0]  // strip port for local dev

// Extract subdomain
const baseDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'interviewprep.guru'
const subdomain = currentHost.endsWith(baseDomain)
  ? currentHost.replace(`.${baseDomain}`, '')
  : null

// CMS Admin subdomain
if (subdomain === 'cms') {
  const url = req.nextUrl.clone()
  url.pathname = `/cms${pathname}`
  return NextResponse.rewrite(url)
}

// Public Content subdomain
if (subdomain === 'content') {
  const url = req.nextUrl.clone()
  url.pathname = `/content${pathname}`
  return NextResponse.rewrite(url)
}

// Fall through to existing main app logic...
```

### DNS & Vercel Configuration

- Wildcard DNS: `*.interviewprep.guru → Vercel`
- Vercel domains: add `cms.interviewprep.guru` and `content.interviewprep.guru`
- Local dev: use `/etc/hosts` entries or `NEXT_PUBLIC_ROOT_DOMAIN=localhost:3000` with query-param-based subdomain simulation

### Local Development

For local development without real subdomains:

```bash
# /etc/hosts
127.0.0.1 cms.localhost
127.0.0.1 content.localhost
```

Or use a `.env.local` override:

```
NEXT_PUBLIC_ROOT_DOMAIN=localhost:3000
```

With middleware fallback to detect `?subdomain=cms` query param in development.

---

## 3. Content Modeling

### Content Type System (Schema-Driven)

Content types are **not hardcoded**. They are defined as documents in MongoDB, making the CMS infinitely extensible.

```
ContentType (defines the shape)
  ├── "Blog Post"    → fields: [title, body, excerpt, coverImage, author, tags]
  ├── "Interview Guide" → fields: [title, body, role, experience, difficulty, tips]
  ├── "FAQ"          → fields: [question, answer, category]
  ├── "Landing Page" → fields: [headline, hero, sections, cta]
  ├── "Case Study"   → fields: [company, role, challenge, outcome, testimonial]
  ├── "Video Lesson" → fields: [title, videoUrl, transcript, duration, tags]
  ├── "Changelog"    → fields: [version, date, changes, type]
  └── (any new type added via admin UI — no code changes)
```

### Field Types

| Field Type    | Storage        | UI Component          | Use Case                    |
|---------------|----------------|-----------------------|-----------------------------|
| `text`        | String         | Input                 | Titles, names               |
| `richtext`    | String (HTML)  | Rich text editor      | Blog bodies, descriptions   |
| `markdown`    | String         | Markdown editor       | Technical content            |
| `number`      | Number         | Number input          | Scores, durations           |
| `boolean`     | Boolean        | Toggle                | Feature flags, highlights   |
| `date`        | Date           | Date picker           | Publish dates, events       |
| `image`       | ObjectId (ref) | Media picker          | Cover images, avatars       |
| `file`        | ObjectId (ref) | File uploader         | PDFs, downloads             |
| `select`      | String         | Dropdown              | Categories, status          |
| `multiselect` | [String]       | Multi-select          | Tags, topics                |
| `reference`   | ObjectId       | Content picker        | Related posts, authors      |
| `json`        | Mixed          | JSON editor           | Structured data, configs    |
| `slug`        | String         | Auto-generated input  | URL slugs                   |
| `url`         | String         | URL input             | External links              |
| `color`       | String         | Color picker          | Theme colors                |
| `component`   | [Mixed]        | Block editor          | Page builder sections       |

### Content Relationships

```
Content ──references──→ Content     (related posts, series)
Content ──has many───→ Media        (images, files)
Content ──tagged by──→ Taxonomy     (categories, tags)
Content ──authored by→ CmsUser      (editor/author)
Content ──versioned──→ ContentVersion (full history)
```

### Taxonomy System

Hierarchical taxonomy supporting both flat tags and nested categories:

```
Taxonomy
  ├── Category (hierarchical)
  │   ├── Interview Tips
  │   │   ├── Behavioral Questions
  │   │   ├── Technical Questions
  │   │   └── Case Studies
  │   ├── Career Advice
  │   └── Product Updates
  └── Tag (flat)
      ├── STAR Method
      ├── PM Interview
      ├── FAANG
      └── Remote Work
```

---

## 4. Database Schema Design

### New Models (6 new collections)

#### 4.1 `CmsSite` — Multi-tenant site configuration

```typescript
// lib/db/models/cms/CmsSite.ts
interface ICmsSite {
  _id: ObjectId
  name: string                        // "Interview Prep Guru Blog"
  slug: string                        // "main" (unique)
  domain?: string                     // custom domain override
  organizationId?: ObjectId           // null = platform-level site
  settings: {
    defaultLocale: string             // "en"
    supportedLocales: string[]
    timezone: string
    postsPerPage: number
    allowComments: boolean
    analyticsId?: string
    customCss?: string
  }
  seo: {
    siteName: string
    siteDescription: string
    defaultOgImage?: string
    googleVerification?: string
  }
  status: 'active' | 'suspended'
  createdBy: ObjectId
  createdAt: Date
  updatedAt: Date
}

// Indexes: { slug: 1 } unique, { organizationId: 1 }, { domain: 1 } sparse unique
```

#### 4.2 `CmsContentType` — Dynamic content type definitions

```typescript
// lib/db/models/cms/CmsContentType.ts
interface ICmsContentType {
  _id: ObjectId
  siteId: ObjectId                    // ref CmsSite
  name: string                        // "Blog Post"
  slug: string                        // "blog-post"
  description?: string
  icon?: string                       // UI icon identifier
  fields: Array<{
    name: string                      // "title"
    label: string                     // "Title"
    type: FieldType                   // "text" | "richtext" | ...
    required: boolean
    unique: boolean
    localized: boolean                // per-locale value
    defaultValue?: unknown
    validation?: {                    // Zod-compatible rules
      min?: number
      max?: number
      pattern?: string
      options?: string[]              // for select/multiselect
    }
    helpText?: string                 // shown in admin UI
    group?: string                    // field grouping in editor
    sortOrder: number
  }>
  settings: {
    slugField: string                 // which field generates the URL slug
    titleField: string                // which field is the display title
    previewUrl?: string               // pattern for front-end preview
    enableVersioning: boolean
    enableComments: boolean
    defaultStatus: 'draft' | 'published'
  }
  createdAt: Date
  updatedAt: Date
}

// Indexes: { siteId: 1, slug: 1 } unique
```

#### 4.3 `CmsContent` — The main content documents

```typescript
// lib/db/models/cms/CmsContent.ts
interface ICmsContent {
  _id: ObjectId
  siteId: ObjectId
  contentTypeId: ObjectId             // ref CmsContentType
  contentType: string                 // denormalized slug for fast queries

  slug: string
  fields: Map<string, unknown>        // dynamic field values keyed by field name

  // Taxonomy
  tags: string[]
  categories: ObjectId[]              // ref CmsTaxonomy

  // Workflow
  status: 'draft' | 'in_review' | 'scheduled' | 'published' | 'archived'
  publishedAt?: Date
  scheduledPublishAt?: Date
  scheduledUnpublishAt?: Date

  // Versioning
  version: number
  publishedVersion?: number

  // SEO overrides (per-content)
  seo: {
    title?: string
    description?: string
    ogImage?: string
    canonical?: string
    noIndex?: boolean
  }

  // Localization
  locale: string                      // "en", "es", etc.
  localizations?: ObjectId[]          // refs to same content in other locales

  // Audit
  createdBy: ObjectId
  updatedBy: ObjectId
  lockedBy?: ObjectId                 // edit lock
  lockedAt?: Date

  createdAt: Date
  updatedAt: Date
}

// Indexes:
// { siteId: 1, slug: 1, locale: 1 } unique
// { siteId: 1, contentType: 1, status: 1, publishedAt: -1 }
// { siteId: 1, status: 1, scheduledPublishAt: 1 }
// { tags: 1 }
// { categories: 1 }
// { createdBy: 1 }
```

#### 4.4 `CmsContentVersion` — Version history

```typescript
// lib/db/models/cms/CmsContentVersion.ts
interface ICmsContentVersion {
  _id: ObjectId
  contentId: ObjectId                 // ref CmsContent
  siteId: ObjectId
  version: number
  fields: Map<string, unknown>        // snapshot of all field values
  seo: object                         // snapshot of SEO
  tags: string[]
  categories: ObjectId[]
  status: string                      // status at time of version creation
  changeNote?: string                 // "Updated introduction paragraph"
  createdBy: ObjectId
  createdAt: Date
}

// Indexes: { contentId: 1, version: -1 }, { siteId: 1, createdAt: -1 }
```

#### 4.5 `CmsMedia` — Media asset management

```typescript
// lib/db/models/cms/CmsMedia.ts
interface ICmsMedia {
  _id: ObjectId
  siteId: ObjectId
  filename: string                    // original filename
  mimeType: string
  size: number                        // bytes
  storageKey: string                  // R2/S3 object key
  cdnUrl: string                      // public URL via CDN

  // Image-specific
  dimensions?: { width: number; height: number }
  blurhash?: string                   // placeholder blur hash
  alt?: string
  caption?: string

  // Organization
  folder: string                      // virtual folder path: "blog/2024/march"
  tags: string[]

  // Usage tracking
  usedIn: Array<{
    contentId: ObjectId
    fieldName: string
  }>

  uploadedBy: ObjectId
  createdAt: Date
  updatedAt: Date
}

// Indexes: { siteId: 1, folder: 1 }, { siteId: 1, mimeType: 1 }, { storageKey: 1 } unique
```

#### 4.6 `CmsTaxonomy` — Categories and tags

```typescript
// lib/db/models/cms/CmsTaxonomy.ts
interface ICmsTaxonomy {
  _id: ObjectId
  siteId: ObjectId
  type: 'category' | 'tag' | 'series'  // extensible taxonomy types
  name: string
  slug: string
  description?: string
  parentId?: ObjectId                 // self-ref for hierarchy (categories)
  sortOrder: number
  seo?: {
    title?: string
    description?: string
    ogImage?: string
  }
  contentCount: number                // denormalized count for performance
  createdAt: Date
  updatedAt: Date
}

// Indexes: { siteId: 1, type: 1, slug: 1 } unique, { parentId: 1 }
```

#### 4.7 `CmsAuditLog` — Audit trail

```typescript
// lib/db/models/cms/CmsAuditLog.ts
interface ICmsAuditLog {
  _id: ObjectId
  siteId: ObjectId
  entityType: 'content' | 'media' | 'taxonomy' | 'contentType' | 'site' | 'user'
  entityId: ObjectId
  action: 'create' | 'update' | 'delete' | 'publish' | 'unpublish' | 'archive' |
          'submit_review' | 'approve' | 'reject' | 'schedule' | 'restore_version'
  changes?: {
    field: string
    from: unknown
    to: unknown
  }[]
  note?: string
  performedBy: ObjectId
  performedAt: Date
  ip?: string
}

// Indexes: { siteId: 1, entityType: 1, entityId: 1 }, { performedBy: 1 }, { performedAt: -1 }
// TTL index: { performedAt: 1 }, expireAfterSeconds: 365 * 24 * 60 * 60 (1 year retention)
```

#### 4.8 `CmsRole` — Per-site role assignments

```typescript
// lib/db/models/cms/CmsRole.ts
interface ICmsRole {
  _id: ObjectId
  userId: ObjectId                    // ref User (existing model)
  siteId: ObjectId                    // ref CmsSite
  role: 'viewer' | 'contributor' | 'editor' | 'reviewer' | 'admin'
  invitedBy: ObjectId
  createdAt: Date
  updatedAt: Date
}

// Indexes: { userId: 1, siteId: 1 } unique, { siteId: 1, role: 1 }
```

### Relationship to Existing Models

```
Existing User model ←──── CmsRole ────→ CmsSite
    │                                      │
    │ (platform_admin role gives            │
    │  super-admin CMS access)              │
    │                                       ├── CmsContentType
    └──────────────────────────────────────→├── CmsContent
                                            ├── CmsMedia
                                            ├── CmsTaxonomy
                                            └── CmsAuditLog
```

No changes to existing models. The CMS references the existing `User` model via `ObjectId`.

---

## 5. API Design

### API Structure

All CMS APIs live under `/api/cms/v1/` — versioned from day one.

```
/api/cms/v1/
  ├── admin/                          (authenticated, RBAC-protected)
  │   ├── sites/                      (CRUD for sites)
  │   ├── content-types/              (CRUD for content type definitions)
  │   ├── content/                    (CRUD, workflow, versioning)
  │   ├── media/                      (upload, browse, delete)
  │   ├── taxonomy/                   (CRUD for categories/tags)
  │   ├── users/                      (CMS role assignments)
  │   ├── audit/                      (audit log queries)
  │   └── settings/                   (site settings)
  │
  └── public/                         (read-only, cached, no auth required)
      ├── content/                    (published content queries)
      ├── taxonomy/                   (published taxonomy listings)
      └── search/                     (full-text search)
```

### Admin API Endpoints

#### Content CRUD

```
POST   /api/cms/v1/admin/content                    Create content
GET    /api/cms/v1/admin/content                    List content (filterable)
GET    /api/cms/v1/admin/content/:id                Get single content
PUT    /api/cms/v1/admin/content/:id                Update content
DELETE /api/cms/v1/admin/content/:id                Soft delete content

PATCH  /api/cms/v1/admin/content/:id/status         Workflow transition
POST   /api/cms/v1/admin/content/:id/duplicate      Duplicate content
GET    /api/cms/v1/admin/content/:id/versions        List versions
POST   /api/cms/v1/admin/content/:id/versions/:v/restore  Restore version
POST   /api/cms/v1/admin/content/:id/lock           Acquire edit lock
DELETE /api/cms/v1/admin/content/:id/lock           Release edit lock
```

#### Content Types

```
POST   /api/cms/v1/admin/content-types              Create content type
GET    /api/cms/v1/admin/content-types              List content types
GET    /api/cms/v1/admin/content-types/:id          Get content type
PUT    /api/cms/v1/admin/content-types/:id          Update content type
DELETE /api/cms/v1/admin/content-types/:id          Delete content type (only if no content exists)
```

#### Media

```
POST   /api/cms/v1/admin/media/presign              Get presigned upload URL
POST   /api/cms/v1/admin/media                      Register uploaded media
GET    /api/cms/v1/admin/media                      Browse media (paginated, filterable)
GET    /api/cms/v1/admin/media/:id                  Get media details
PUT    /api/cms/v1/admin/media/:id                  Update metadata (alt, caption, tags)
DELETE /api/cms/v1/admin/media/:id                  Delete media
```

#### Taxonomy

```
POST   /api/cms/v1/admin/taxonomy                   Create taxonomy item
GET    /api/cms/v1/admin/taxonomy                   List taxonomy (type filter)
GET    /api/cms/v1/admin/taxonomy/:id               Get taxonomy item
PUT    /api/cms/v1/admin/taxonomy/:id               Update taxonomy item
DELETE /api/cms/v1/admin/taxonomy/:id               Delete taxonomy item
POST   /api/cms/v1/admin/taxonomy/reorder           Bulk reorder
```

### Public Content Delivery API

```
GET /api/cms/v1/public/content?type=blog-post&limit=20&cursor=xxx
GET /api/cms/v1/public/content/:slug
GET /api/cms/v1/public/taxonomy?type=category
GET /api/cms/v1/public/search?q=star+method&type=blog-post
GET /api/cms/v1/public/sitemap                      Sitemap data for SSG
```

### Pagination (Cursor-Based)

```typescript
// Request
GET /api/cms/v1/public/content?type=blog-post&limit=20&cursor=eyJpZCI6IjY1YTFiMiJ9

// Response
{
  "data": [ ...content items... ],
  "pagination": {
    "nextCursor": "eyJpZCI6IjY1YTFjMyJ9",  // base64 encoded
    "hasMore": true
  }
}
```

### Zod Validation Schemas

Every endpoint gets a Zod schema, integrated with the existing `composeApiRoute` pattern:

```typescript
// lib/cms/schemas/content.ts
const CreateContentSchema = z.object({
  contentTypeId: z.string(),
  slug: z.string().regex(/^[a-z0-9-]+$/).max(200),
  fields: z.record(z.unknown()),
  tags: z.array(z.string()).optional(),
  categories: z.array(z.string()).optional(),
  seo: z.object({ ... }).optional(),
  status: z.enum(['draft', 'published']).default('draft'),
})
```

### Middleware Composition

CMS API routes use a CMS-specific variant of `composeApiRoute` that adds site resolution and permission checking:

```typescript
// lib/cms/middleware/composeCmsRoute.ts
export function composeCmsRoute<T>(options: {
  schema: ZodSchema<T>
  permission: CmsPermission
  rateLimit: RateLimitConfig
  handler: (req: NextRequest, ctx: CmsApiContext<T>) => Promise<NextResponse>
}) {
  // 1. Auth (reuse existing NextAuth)
  // 2. Resolve site from header/query
  // 3. Check CMS role + permission for this site
  // 4. Rate limit
  // 5. Validate body with schema
  // 6. Call handler with CmsApiContext { user, site, body, params }
}
```

---

## 6. CMS Admin UI

### Route Structure

```
app/(cms)/cms/
  ├── layout.tsx                      CMS shell (sidebar, header, breadcrumbs)
  ├── page.tsx                        Dashboard (content stats, recent activity)
  ├── content/
  │   ├── page.tsx                    Content list (filterable table)
  │   ├── new/page.tsx                Create content (dynamic form)
  │   └── [id]/
  │       ├── page.tsx                Edit content
  │       └── versions/page.tsx       Version history
  ├── media/
  │   └── page.tsx                    Media library (grid/list view)
  ├── taxonomy/
  │   └── page.tsx                    Category/tag management
  ├── content-types/
  │   ├── page.tsx                    Content type list
  │   ├── new/page.tsx                Content type builder
  │   └── [id]/page.tsx              Edit content type
  ├── users/
  │   └── page.tsx                    CMS user/role management
  ├── settings/
  │   └── page.tsx                    Site settings
  └── audit/
      └── page.tsx                    Audit log viewer
```

### Key UI Components

```
components/cms/
  ├── layout/
  │   ├── CmsSidebar.tsx              Navigation sidebar
  │   ├── CmsHeader.tsx               Top bar (site switcher, user menu)
  │   └── CmsBreadcrumbs.tsx          Contextual breadcrumbs
  ├── content/
  │   ├── ContentTable.tsx            Sortable, filterable content list
  │   ├── ContentEditor.tsx           Dynamic form renderer
  │   ├── ContentStatusBadge.tsx      Status indicator
  │   ├── ContentVersionDiff.tsx      Side-by-side version comparison
  │   └── ContentPreview.tsx          Live preview in iframe
  ├── fields/
  │   ├── TextField.tsx               Single-line text
  │   ├── RichTextField.tsx           Rich text editor (TipTap or Plate)
  │   ├── MarkdownField.tsx           Markdown with preview
  │   ├── ImageField.tsx              Image picker with media library
  │   ├── SelectField.tsx             Single/multi select
  │   ├── ReferenceField.tsx          Content reference picker
  │   ├── DateField.tsx               Date/datetime picker
  │   ├── BooleanField.tsx            Toggle switch
  │   ├── JsonField.tsx               JSON editor with validation
  │   ├── SlugField.tsx               Auto-slug from title
  │   ├── ComponentField.tsx          Block/section editor
  │   └── FieldRenderer.tsx           Dynamic field component resolver
  ├── media/
  │   ├── MediaLibrary.tsx            Grid view with filters
  │   ├── MediaUploader.tsx           Drag-and-drop upload
  │   └── MediaPicker.tsx             Modal picker for content fields
  ├── taxonomy/
  │   ├── TaxonomyTree.tsx            Hierarchical category tree
  │   └── TagInput.tsx                Autocomplete tag input
  └── shared/
      ├── DataTable.tsx               Reusable sortable/filterable table
      ├── Pagination.tsx              Cursor-based pagination controls
      ├── ConfirmDialog.tsx           Confirmation modals
      └── SearchBar.tsx               Debounced search input
```

### Editor Experience

The content editor dynamically renders form fields based on the `CmsContentType` definition:

```
┌─────────────────────────────────────────────────────────────────┐
│ CMS > Blog Posts > Edit: "Ace Your HR Interview"     [Preview] │
├───────────────────────────────────┬─────────────────────────────┤
│                                   │  Status: Draft              │
│  Title                            │  [Submit for Review]        │
│  ┌─────────────────────────────┐  │  [Save Draft]               │
│  │ Ace Your HR Interview       │  │  [Publish]                  │
│  └─────────────────────────────┘  │                             │
│                                   │  SEO                        │
│  Slug                             │  ┌───────────────────────┐  │
│  ┌─────────────────────────────┐  │  │ Meta title            │  │
│  │ ace-your-hr-interview       │  │  │ Meta description      │  │
│  └─────────────────────────────┘  │  │ OG image [pick]       │  │
│                                   │  └───────────────────────┘  │
│  Cover Image                      │                             │
│  ┌─────────────────────────────┐  │  Taxonomy                   │
│  │  [📷 Pick from library]     │  │  Category: [Interview Tips] │
│  └─────────────────────────────┘  │  Tags: [STAR] [HR] [+]     │
│                                   │                             │
│  Body (Rich Text)                 │  Publishing                 │
│  ┌─────────────────────────────┐  │  Schedule: [date picker]    │
│  │  Rich text editor with      │  │                             │
│  │  formatting toolbar         │  │  Version: 3                 │
│  │  ...                        │  │  Last saved: 2 min ago      │
│  │  ...                        │  │  [View History]             │
│  └─────────────────────────────┘  │                             │
├───────────────────────────────────┴─────────────────────────────┤
│ Autosave: Saved 2 seconds ago                                   │
└─────────────────────────────────────────────────────────────────┘
```

### Rich Text Editor

Use **TipTap** (ProseMirror-based) — it's the best fit for Next.js/React:
- Headless, fully customizable UI with Tailwind
- Extensions: tables, images, embeds, code blocks, mentions
- Collaborative editing support (future)
- Server-side HTML output for rendering

---

## 7. Content Workflow & Publishing

### State Machine

```
                    ┌────────────┐
                    │            │
              ┌─────│   DRAFT    │◄─────────────────────┐
              │     │            │                       │
              │     └─────┬──────┘                       │
              │           │                              │
              │     submit_review                   reject
              │           │                              │
              │     ┌─────▼──────┐                       │
              │     │            │                       │
              │     │ IN_REVIEW  │───────────────────────┘
              │     │            │
              │     └─────┬──────┘
              │           │
              │        approve
              │           │
     direct   │     ┌─────▼──────┐         schedule
     publish  │     │            │────────────────┐
              │     │  APPROVED  │                │
              │     │            │           ┌────▼─────┐
              └─────►─────┬──────┘           │SCHEDULED │
                          │                  └────┬─────┘
                       publish                    │ (cron triggers)
                          │                       │
                    ┌─────▼──────┐◄───────────────┘
                    │            │
                    │ PUBLISHED  │
                    │            │
                    └─────┬──────┘
                          │
                       archive
                          │
                    ┌─────▼──────┐
                    │            │
                    │  ARCHIVED  │
                    │            │
                    └────────────┘
```

### Workflow Transition Rules

```typescript
const WORKFLOW_TRANSITIONS = {
  draft: {
    submit_review: { to: 'in_review', permission: 'content:edit_own' },
    publish:       { to: 'published',  permission: 'content:publish' },
    schedule:      { to: 'scheduled',  permission: 'content:publish' },
  },
  in_review: {
    approve:  { to: 'published',  permission: 'content:review' },
    reject:   { to: 'draft',      permission: 'content:review' },
    schedule: { to: 'scheduled',  permission: 'content:review' },
  },
  scheduled: {
    unschedule: { to: 'draft',     permission: 'content:publish' },
    publish:    { to: 'published', permission: 'content:publish' },  // immediate
  },
  published: {
    unpublish: { to: 'draft',    permission: 'content:publish' },
    archive:   { to: 'archived', permission: 'content:publish' },
  },
  archived: {
    restore: { to: 'draft', permission: 'content:publish' },
  },
}
```

### Scheduled Publishing

A cron job (Vercel Cron or external) runs every minute:

```typescript
// app/api/cms/v1/cron/publish/route.ts
// Vercel Cron: every 1 minute
// Finds content with status=scheduled and scheduledPublishAt <= now
// Transitions to published, fires cache invalidation
```

### Autosave

Content is autosaved to a `draft` field in Redis (not MongoDB) every 30 seconds while editing. On explicit save, the draft is promoted to a new version in MongoDB.

```
Redis key: cms:draft:{contentId}:{userId}
TTL: 24 hours
```

---

## 8. Media Management

### Upload Flow

```
1. Client requests presigned URL:
   POST /api/cms/v1/admin/media/presign
   → { uploadUrl, storageKey, publicUrl }

2. Client uploads directly to R2/S3:
   PUT {uploadUrl} (binary, no server proxy)

3. Client registers media metadata:
   POST /api/cms/v1/admin/media
   → { filename, storageKey, mimeType, size, dimensions }

4. Server creates CmsMedia document
   → Returns media object with CDN URL
```

### Storage Architecture

```
R2/S3 Bucket: interview-prep-guru-cms
  ├── sites/{siteId}/media/{year}/{month}/{uuid}-{filename}
  ├── sites/{siteId}/media/{year}/{month}/{uuid}-{filename}.webp   (optimized)
  └── sites/{siteId}/media/{year}/{month}/{uuid}-{filename}.thumb  (thumbnail)
```

### Image Optimization Pipeline

On upload, trigger server-side processing (can be async via queue):
1. Generate WebP variant
2. Generate thumbnail (300x300)
3. Calculate blurhash for placeholder
4. Extract dimensions
5. Store all variants in R2

Use the existing `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` already in `package.json`.

### Media Library UI

- Grid view with thumbnails (default) and list view
- Filter by: type (image/video/document), folder, tags, date range
- Drag-and-drop upload with progress
- Inline editing of alt text, captions, tags
- Usage tracking: shows which content uses each media asset

---

## 9. RBAC & Permissions

### CMS Permission Model

```typescript
// lib/cms/permissions.ts
const CMS_PERMISSIONS = {
  // Content
  'content:create':     ['contributor', 'editor', 'reviewer', 'admin'],
  'content:edit_own':   ['contributor', 'editor', 'reviewer', 'admin'],
  'content:edit_any':   ['editor', 'admin'],
  'content:delete':     ['admin'],
  'content:publish':    ['editor', 'admin'],
  'content:review':     ['reviewer', 'editor', 'admin'],
  'content:view_drafts':['contributor', 'editor', 'reviewer', 'admin'],

  // Media
  'media:upload':       ['contributor', 'editor', 'admin'],
  'media:delete':       ['editor', 'admin'],
  'media:edit':         ['contributor', 'editor', 'admin'],

  // Taxonomy
  'taxonomy:manage':    ['editor', 'admin'],

  // Content Types
  'content_type:manage':['admin'],

  // Site Settings
  'site:settings':      ['admin'],

  // Users
  'users:manage':       ['admin'],

  // Audit
  'audit:view':         ['reviewer', 'editor', 'admin'],
} as const

type CmsPermission = keyof typeof CMS_PERMISSIONS
type CmsRole = 'viewer' | 'contributor' | 'editor' | 'reviewer' | 'admin'
```

### Platform Admin Override

Users with the existing `platform_admin` role in the `User` model automatically get `admin` CMS access to all sites — no `CmsRole` document needed.

### Permission Check in API

```typescript
// In composeCmsRoute middleware:
async function checkCmsPermission(userId: string, siteId: string, permission: CmsPermission) {
  // 1. Check if user is platform_admin → allow all
  // 2. Look up CmsRole for (userId, siteId)
  // 3. Check if role has the required permission
  // 4. Cache role lookup in Redis (TTL 5 min)
}
```

---

## 10. SEO & Content Delivery

### Public Content Rendering

The `app/(content)/` route group renders published CMS content as full pages:

```
app/(content)/content/
  ├── layout.tsx                      Public content layout (header, footer, nav)
  ├── page.tsx                        Content homepage / listing
  ├── [type]/                         Content type listing
  │   ├── page.tsx                    e.g., /blog, /guides, /faqs
  │   └── [slug]/page.tsx            Individual content page
  ├── category/[slug]/page.tsx       Category listing
  ├── tag/[slug]/page.tsx            Tag listing
  ├── search/page.tsx                Search results
  ├── sitemap.ts                     Dynamic sitemap for subdomain
  └── robots.ts                      Robots.txt for subdomain
```

### Dynamic Metadata

```typescript
// app/(content)/content/[type]/[slug]/page.tsx
export async function generateMetadata({ params }): Promise<Metadata> {
  const content = await getPublishedContent(params.type, params.slug)
  return {
    title: content.seo?.title || content.fields.get('title'),
    description: content.seo?.description || content.fields.get('excerpt'),
    openGraph: {
      title: content.seo?.title || content.fields.get('title'),
      description: content.seo?.description,
      images: content.seo?.ogImage ? [content.seo.ogImage] : [],
      type: 'article',
      publishedTime: content.publishedAt?.toISOString(),
    },
    alternates: {
      canonical: content.seo?.canonical ||
        `https://content.interviewprep.guru/${params.type}/${params.slug}`,
    },
  }
}
```

### JSON-LD Structured Data

Each content type generates appropriate JSON-LD:
- Blog posts → `Article` schema
- FAQs → `FAQPage` schema
- Guides → `HowTo` schema
- Landing pages → `WebPage` schema

### Dynamic Sitemap

```typescript
// app/(content)/content/sitemap.ts
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const content = await getAllPublishedContentSlugs()
  return content.map(item => ({
    url: `https://content.interviewprep.guru/${item.contentType}/${item.slug}`,
    lastModified: item.updatedAt,
    changeFrequency: item.contentType === 'blog-post' ? 'weekly' : 'monthly',
    priority: item.contentType === 'landing-page' ? 1.0 : 0.7,
  }))
}
```

### Cross-Linking with Main App

Content pages include CTAs that link back to the main app:
- "Try a practice interview" buttons → `interviewprep.guru/lobby`
- Related content suggestions in sidebar
- Internal linking between content pieces

---

## 11. Caching Strategy

### Three-Layer Cache

```
Layer 1: CDN / Edge (Vercel Edge Network)
  ├── Public content pages: Cache-Control: s-maxage=3600, stale-while-revalidate=86400
  ├── Media assets: Cache-Control: public, max-age=31536000, immutable
  └── API responses: Cache-Control: s-maxage=300

Layer 2: Redis Application Cache (ioredis)
  ├── cms:content:{siteId}:{slug}      → 5 min TTL (published content)
  ├── cms:list:{siteId}:{type}:{page}  → 2 min TTL (content listings)
  ├── cms:taxonomy:{siteId}:{type}     → 10 min TTL (taxonomy trees)
  ├── cms:site:{slug}                  → 10 min TTL (site config)
  ├── cms:role:{userId}:{siteId}       → 5 min TTL (permission lookups)
  └── cms:draft:{contentId}:{userId}   → 24 hr TTL (autosave drafts)

Layer 3: ISR (Next.js Incremental Static Regeneration)
  ├── Content pages: revalidate = 60 seconds
  └── On-demand revalidation via webhook on publish/unpublish
```

### Cache Invalidation

When content is published/updated/unpublished:

```typescript
async function invalidateCaches(siteId: string, content: ICmsContent) {
  // 1. Redis: delete specific content cache
  await redis.del(`cms:content:${siteId}:${content.slug}`)

  // 2. Redis: delete listing caches (pattern)
  const keys = await redis.keys(`cms:list:${siteId}:${content.contentType}:*`)
  if (keys.length) await redis.del(...keys)

  // 3. ISR: on-demand revalidation
  await revalidatePath(`/content/${content.contentType}/${content.slug}`)
  await revalidatePath(`/content/${content.contentType}`)  // listing page
}
```

---

## 12. Search & Discovery

### Phase 1: MongoDB Text Search

Use MongoDB's built-in text search as the initial implementation:

```typescript
// Create text index on CmsContent
CmsContentSchema.index(
  { 'fields.title': 'text', 'fields.body': 'text', tags: 'text' },
  { weights: { 'fields.title': 10, tags: 5, 'fields.body': 1 } }
)

// Search query
const results = await CmsContent.find({
  siteId,
  status: 'published',
  $text: { $search: query }
}, {
  score: { $meta: 'textScore' }
}).sort({ score: { $meta: 'textScore' } }).limit(20)
```

### Phase 2: MongoDB Atlas Search (When Needed)

Upgrade to Atlas Search for:
- Fuzzy matching / typo tolerance
- Faceted search (filter by category, date range, content type)
- Search suggestions / autocomplete
- Highlighting

### Phase 3: Dedicated Search Engine (Future)

If search volume demands it, add Meilisearch or Typesense:
- Sync published content via change streams or webhooks
- Sub-50ms search responses
- Instant search UI with React InstantSearch

---

## 13. AI-Powered Features

Leverage the existing Anthropic Claude integration for CMS superpowers:

### 13.1 AI Writing Assistant

```typescript
// POST /api/cms/v1/admin/ai/assist
// Uses Claude to help editors write and improve content

Features:
- Generate blog post outlines from a topic
- Expand bullet points into paragraphs
- Rewrite for clarity/tone
- Generate SEO meta descriptions
- Suggest related topics / internal links
```

### 13.2 AI Content Summarization

- Auto-generate excerpts from long-form content
- Generate social media snippets (Twitter, LinkedIn)
- Create TL;DR summaries for guides

### 13.3 AI SEO Optimization

- Analyze content for keyword coverage
- Suggest title/heading improvements
- Score content readability
- Recommend internal linking opportunities

### 13.4 AI Image Alt Text

- Auto-generate alt text for uploaded images using Claude's vision
- Suggest caption text

### 13.5 AI Content Translation (Future)

- Translate content to supported locales using Claude
- Human-in-the-loop review before publishing

---

## 14. Multi-Tenant Scalability

### Tenant Isolation

```
Platform Site (siteId: "main")
  └── All platform-level content (blog, guides, FAQs, changelog)

Organization Sites (siteId: org.slug)
  └── B2B customers can manage their own content
      (interview templates, branded landing pages, internal guides)
```

### Scaling Dimensions

| Dimension        | Strategy                                                    |
|------------------|-------------------------------------------------------------|
| Content depth    | Schema-driven fields — unlimited field types per content type |
| Content width    | Unlimited content types per site — no code changes needed    |
| Sites/tenants    | Shared DB with siteId scoping + compound indexes            |
| Media volume     | R2 (unlimited storage) + CDN + lazy-loaded thumbnails       |
| API throughput   | Redis caching + CDN + ISR + cursor pagination               |
| Editor count     | Per-site RBAC + edit locking prevents conflicts              |
| Search scale     | MongoDB text → Atlas Search → Meilisearch (progressive)     |
| Localization     | Per-locale content documents linked by `localizations[]`    |

### Resource Limits per Site

```typescript
const SITE_LIMITS = {
  free:       { maxContent: 50,    maxMedia: 500,     maxContentTypes: 3,  maxEditors: 1  },
  pro:        { maxContent: 5000,  maxMedia: 10000,   maxContentTypes: 20, maxEditors: 10 },
  enterprise: { maxContent: -1,    maxMedia: -1,      maxContentTypes: -1, maxEditors: -1 },
}
```

---

## 15. Implementation Phases

### Phase 1: Foundation (Weeks 1-3)

**Goal:** Core CMS infrastructure — create, store, and retrieve content.

- [ ] Database models: `CmsSite`, `CmsContentType`, `CmsContent`, `CmsMedia`, `CmsTaxonomy`, `CmsRole`, `CmsAuditLog`, `CmsContentVersion`
- [ ] `composeCmsRoute` middleware (auth + site resolution + RBAC + validation)
- [ ] CMS permission system
- [ ] Middleware subdomain routing (`cms.*` and `content.*`)
- [ ] Admin API: Content CRUD, Content Type CRUD, Taxonomy CRUD
- [ ] Seed default site + initial content types (Blog Post, FAQ, Guide)
- [ ] Basic admin layout shell (sidebar, header, breadcrumbs)
- [ ] Content list page with table, filters, pagination
- [ ] Content editor with dynamic field rendering (text, richtext, slug, select, boolean, date)

### Phase 2: Media & Rich Editing (Weeks 4-5)

**Goal:** Full media management and polished editor experience.

- [ ] Media upload flow (presigned URL → R2 → register)
- [ ] Media library UI (grid view, folders, filters)
- [ ] Media picker component for content fields
- [ ] Image optimization pipeline (WebP, thumbnails, blurhash)
- [ ] TipTap rich text editor integration with image embedding
- [ ] Markdown editor with live preview
- [ ] Component/block field for page builder sections
- [ ] Content autosave (Redis-backed)
- [ ] Edit locking (prevent concurrent edits)

### Phase 3: Workflow & Versioning (Weeks 6-7)

**Goal:** Production-ready content workflow.

- [ ] Content workflow state machine (draft → review → publish → archive)
- [ ] Scheduled publishing (cron job)
- [ ] Content versioning (create version on save, restore, diff view)
- [ ] Audit log (all actions tracked)
- [ ] Review system (submit, approve, reject with comments)
- [ ] Bulk actions (publish, archive, delete multiple)
- [ ] Content duplication

### Phase 4: Public Content & SEO (Weeks 8-9)

**Goal:** Beautiful public-facing content pages.

- [ ] Public content delivery API (cached, paginated)
- [ ] `app/(content)/` route group with content rendering
- [ ] Content page templates (blog, guide, FAQ, landing page)
- [ ] Dynamic metadata + JSON-LD per content type
- [ ] Dynamic sitemap for content subdomain
- [ ] RSS feed generation
- [ ] Category/tag listing pages
- [ ] Search page with MongoDB text search
- [ ] Cross-linking with main app (CTAs, navigation)
- [ ] Three-layer caching (CDN + Redis + ISR) with invalidation

### Phase 5: AI & Advanced Features (Weeks 10-12)

**Goal:** AI-powered editing and advanced CMS capabilities.

- [ ] AI writing assistant (outline generation, rewriting, expansion)
- [ ] AI SEO analysis (keyword suggestions, readability scoring)
- [ ] AI image alt text generation
- [ ] Content type builder UI (visual field editor for admins)
- [ ] User/role management UI
- [ ] Site settings UI
- [ ] Analytics dashboard (content views, popular articles)
- [ ] Webhook system for external integrations
- [ ] Localization support (multi-locale content)

### Phase 6: Polish & Scale (Weeks 13-14)

**Goal:** Production hardening and performance.

- [ ] Load testing and query optimization
- [ ] Upgrade to Atlas Search (if needed)
- [ ] Custom domain support for B2B sites
- [ ] Content import/export (JSON, CSV)
- [ ] Email notifications (review requests, publish events)
- [ ] Keyboard shortcuts in editor
- [ ] Mobile-responsive admin UI
- [ ] Comprehensive test suite (unit + integration)
- [ ] Documentation for content editors

---

## 16. File Structure

### New Files Added to Project

```
app/
  (cms)/cms/                          # CMS Admin (subdomain: cms.*)
    layout.tsx
    page.tsx                          # Dashboard
    content/
      page.tsx                        # Content list
      new/page.tsx                    # Create content
      [id]/
        page.tsx                      # Edit content
        versions/page.tsx             # Version history
    media/page.tsx                    # Media library
    taxonomy/page.tsx                 # Taxonomy management
    content-types/
      page.tsx                        # Content type list
      new/page.tsx                    # Content type builder
      [id]/page.tsx                   # Edit content type
    users/page.tsx                    # CMS user management
    settings/page.tsx                 # Site settings
    audit/page.tsx                    # Audit log
  (content)/content/                  # Public Content (subdomain: content.*)
    layout.tsx
    page.tsx                          # Content homepage
    [type]/
      page.tsx                        # Type listing (e.g., /blog)
      [slug]/page.tsx                # Individual content
    category/[slug]/page.tsx
    tag/[slug]/page.tsx
    search/page.tsx
    sitemap.ts
    robots.ts
    feed.xml/route.ts                 # RSS feed
  api/cms/v1/
    admin/
      content/route.ts                # Content CRUD
      content/[id]/route.ts
      content/[id]/status/route.ts    # Workflow
      content/[id]/versions/route.ts
      content/[id]/lock/route.ts
      content-types/route.ts
      content-types/[id]/route.ts
      media/route.ts
      media/presign/route.ts
      media/[id]/route.ts
      taxonomy/route.ts
      taxonomy/[id]/route.ts
      taxonomy/reorder/route.ts
      users/route.ts
      audit/route.ts
      settings/route.ts
      ai/assist/route.ts
    public/
      content/route.ts
      content/[slug]/route.ts
      taxonomy/route.ts
      search/route.ts
      sitemap/route.ts
    cron/
      publish/route.ts                # Scheduled publishing cron

components/cms/                       # CMS UI components (see Section 6)
  layout/
  content/
  fields/
  media/
  taxonomy/
  shared/

lib/cms/                              # CMS business logic
  middleware/
    composeCmsRoute.ts                # CMS API middleware
  permissions.ts                      # RBAC definitions
  schemas/                            # Zod validation schemas
    content.ts
    contentType.ts
    media.ts
    taxonomy.ts
  services/
    contentService.ts                 # Content CRUD + workflow
    mediaService.ts                   # Media management
    taxonomyService.ts                # Taxonomy operations
    searchService.ts                  # Search queries
    cacheService.ts                   # Redis cache helpers
    auditService.ts                   # Audit logging
    aiService.ts                      # AI writing assistant
  utils/
    slugify.ts                        # URL slug generation
    sanitize.ts                       # HTML sanitization
    diff.ts                           # Version diff utility

lib/db/models/cms/                    # Mongoose models
  CmsSite.ts
  CmsContentType.ts
  CmsContent.ts
  CmsContentVersion.ts
  CmsMedia.ts
  CmsTaxonomy.ts
  CmsRole.ts
  CmsAuditLog.ts
  index.ts

hooks/cms/                            # CMS React hooks
  useCmsContent.ts                    # Content list/CRUD operations
  useCmsMedia.ts                      # Media library operations
  useAutosave.ts                      # Redis-backed autosave
  useCmsSearch.ts                     # Search with debounce
```

---

## 17. Environment & Infrastructure

### New Environment Variables

```bash
# CMS Configuration
NEXT_PUBLIC_ROOT_DOMAIN=interviewprep.guru     # Base domain for subdomain routing
CMS_REVALIDATION_SECRET=xxx                        # Secret for ISR revalidation webhook
CMS_DEFAULT_SITE_ID=xxx                            # Default platform site ObjectId

# Media Storage (already have @aws-sdk in package.json)
CMS_R2_BUCKET=interview-prep-guru-cms
CMS_R2_ACCOUNT_ID=xxx
CMS_R2_ACCESS_KEY=xxx
CMS_R2_SECRET_KEY=xxx
CMS_CDN_URL=https://cdn.interviewprep.guru

# AI Features (reuse existing ANTHROPIC_API_KEY)
# No new keys needed

# Search (Phase 2+)
# MEILISEARCH_URL=xxx                              # Only if upgrading from MongoDB search
# MEILISEARCH_KEY=xxx
```

### New Dependencies

```json
{
  "@tiptap/react": "^2.x",           // Rich text editor
  "@tiptap/starter-kit": "^2.x",     // TipTap essentials
  "@tiptap/extension-image": "^2.x", // Image support
  "@tiptap/extension-table": "^2.x", // Table support
  "@tiptap/extension-link": "^2.x",  // Link support
  "sanitize-html": "^2.x",           // HTML sanitization
  "blurhash": "^2.x",                // Image placeholder hashes
  "sharp": "^0.33.x",                // Server-side image processing
  "date-fns": "^3.x"                 // Date formatting (lightweight)
}
```

### Vercel Configuration

```json
// vercel.json additions (if needed beyond middleware)
{
  "crons": [{
    "path": "/api/cms/v1/cron/publish",
    "schedule": "* * * * *"
  }]
}
```

### Docker Compose Addition

```yaml
# Add to existing docker-compose.yml
services:
  # ... existing app, mongo, redis ...
  meilisearch:                         # Phase 2+ (optional)
    image: getmeili/meilisearch:v1.x
    ports:
      - "7700:7700"
    volumes:
      - meili_data:/meili_data
```

---

## Summary

This CMS is designed to scale across every axis:

| Scale Axis           | How It Scales                                               |
|----------------------|-------------------------------------------------------------|
| **Content width**    | Dynamic content types — add blog, guide, FAQ, changelog, case study without code |
| **Content depth**    | 15+ field types, nested components, references between content |
| **Media**            | R2 unlimited storage + CDN + image optimization pipeline    |
| **Traffic**          | 3-layer cache (CDN + Redis + ISR), cursor pagination        |
| **Editors/Authors**  | Per-site RBAC, edit locking, review workflow                 |
| **Multi-tenant**     | siteId scoping, shared DB, per-org sites for B2B            |
| **Search**           | MongoDB text → Atlas Search → Meilisearch (progressive)     |
| **SEO**              | Dynamic metadata, JSON-LD, sitemaps, RSS per subdomain      |
| **AI**               | Writing assistant, SEO analysis, alt text — powered by Claude|
| **Localization**     | Locale-linked content documents, per-field localization flag |
