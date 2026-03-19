# Mission: Discover and test all flows

You are given a URL. Your job has two phases.

## Phase 1: Discovery

Map every user-reachable flow on the site.

1. **Navigate to the target URL.** Screenshot the landing page.
2. **Crawl the navigation.** Click every link in the header, footer, sidebar, and any menus. Record every unique page you find.
3. **Identify interactive elements.** On each page, use `browser_snapshot` to get the accessibility tree. Note every form, button, dropdown, modal trigger, and link.
4. **Map the flows.** From what you found, build a mental map of the user journeys:
   - Public flows (homepage, about, pricing, login, signup)
   - Authenticated flows (dashboard, core features, settings, profile)
   - Transactional flows (any multi-step process like starting a session, submitting data, completing a task)

Before moving to Phase 2, write down the list of discovered flows so you have a plan.

## Phase 2: Test every flow

Go through each discovered flow systematically.

For each flow:

### Happy path
- Walk through the flow as a normal user would
- Verify each step works and leads to the expected next step
- Screenshot key states (form loaded, form submitted, success/error message). Screenshots are automatically saved to `/tmp/screenshots/` by the Playwright MCP server.

### Edge cases
- Submit forms with empty fields
- Enter extremely long text (paste 500+ characters)
- Use special characters: emoji, unicode, HTML tags, SQL injection strings
- Click submit buttons multiple times rapidly
- Hit the browser back button mid-flow
- Refresh the page mid-flow

### Error handling
- Trigger validation errors and verify the messages are clear
- Navigate to URLs that shouldn't exist (append `/asdfgh` to paths)
- Check what happens when required fields are skipped

### Mobile (if enabled)
- Resize viewport to 375x667
- Verify the navigation is usable (hamburger menu, etc.)
- Walk through the most critical flow on mobile
- Check for horizontal overflow, text truncation, touch target sizes

## Phase 3: Report

Use the Write tool to save your report to `/tmp/qa-report.md` in this format:

```markdown
# QA Report

**Date**: [today's date]
**URL**: [tested URL]

## Discovered flows

1. [Flow name] — [brief description]
2. ...

## Results summary

| # | Flow | Status | Bugs |
|---|------|--------|------|
| 1 | ... | PASS/FAIL | 0 |

## Bugs

### BUG-1: [short title]
- **Severity**: Critical / High / Medium / Low
- **Flow**: [which flow]
- **Steps to reproduce**:
  1. Go to ...
  2. Click ...
- **Expected**: [what should happen]
- **Actual**: [what actually happened]
- **Viewport**: Desktop / Mobile
- **Screenshot**: [filename]

## Visual issues

[Layout problems, overflow, alignment, responsive issues]

## Observations

[Slow pages, confusing UX, accessibility gaps, missing error messages]

## Verdict

[Overall site health: how many flows passed vs failed, critical blockers if any]
```

Take as many turns as you need. Be thorough.
