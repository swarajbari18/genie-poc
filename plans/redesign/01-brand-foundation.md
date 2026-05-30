# Plan 01 — Brand Foundation

## Purpose

Replace all off-brand blue (`#2563eb`) with Genie AI's actual design tokens across every page. Establish a single CSS custom properties block that all pages share. Define typography, spacing, and the primitive component classes (button, card, status badge) that Plans 02–05 will use without re-defining.

---

## Why This Is the First UI Plan

Every page currently has its own inline `<style>` block with `:root { --primary: #2563eb; }`. If we patch pages one by one without a shared foundation, the next engineer will re-introduce the same drift. A single shared CSS file or Astro layout component means one change propagates everywhere.

---

## Design Tokens (Source of Truth)

These were extracted directly from `genieai.co` SVG assets and HTML. Use them verbatim — do not interpret or adjust.

```
Brand / Identity
  --color-brand-deep:       #3D1152   (logo background, footer, deep hero elements)
  --color-brand-mid:        #5C0F8B   (logo inner accent)
  --color-accent:           #673AB7   (ALL interactive elements — buttons, checkmarks, active borders, icons)

Gradient (icons and illustrations only — never use as a page background)
  --color-gradient-blue:    #6C81FA
  --color-gradient-indigo:  #5D58FF
  --color-gradient-purple:  #673AB7
  gradient declaration: linear-gradient(180deg, #6C81FA 35%, #5D58FF 53%, #673AB7 90%)

Text
  --color-text-primary:     #212121
  --color-text-muted:       #828282
  --color-text-on-dark:     #FFFFFF

Backgrounds
  --color-bg-white:         #FFFFFF
  --color-bg-subtle:        #F9F9F9   (section separators, input backgrounds)
  --color-bg-footer:        #3D1152

Borders
  --color-border-light:     #F2E7FE   (free tier cards, dashed separators)
  --color-border-mid:       #D3B4F7   (pro tier, highlighted sections)
  --color-border-default:   #E5E7EB   (general card borders)

Typography
  --font-family-base:       'Inter', 'DM Sans', system-ui, sans-serif
  --font-weight-regular:    400
  --font-weight-semibold:   600
  --font-weight-bold:       700

Radii
  --radius-card:            12px
  --radius-button:          8px
  --radius-pill:            999px
  --radius-input:           6px

Shadows (use sparingly — brand is flat/minimal)
  --shadow-card:            0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)
```

---

## Visual Style Rules

These rules come from analysis of the genieai.co site and define the aesthetic contract that all new UI must satisfy.

- **Flat and minimal**: no glassmorphism, no heavy drop shadows, no frosted backgrounds. The site uses `box-shadow: 0 1px 3px rgba(0,0,0,0.06)` at most.
- **White/light mode dominant**: main background is `#FFFFFF` or `#F9F9F9`. Dark purple is used only in the footer and logo area.
- **Gradients are for icons only**: the brand gradient (`#6C81FA → #5D58FF → #673AB7`) appears on illustration icons and feature graphics, never as a full-section or button background.
- **Buttons**: solid `#673AB7` fill, white text, `8px` radius. Flat — no gradient, no glow, no heavy shadow.
- **Interactive states**: hover = `#5C0F8B` (mid brand). Focus = `2px solid #673AB7` outline with `2px` offset. Disabled = `#D3B4F7` fill.
- **Typography**: Inter or DM Sans. Headings: 700. Labels and CTAs: 600. Body: 400. No custom font needs to be loaded if Inter is already available via system fonts or a Google Fonts import.
- **Icons**: thin line style, stroke-width 1.25–1.5, stroke-linecap round. Use Heroicons (outline variant) or Lucide — both match the stroke aesthetic.
- **Status badges**: small, pill-shaped, muted background. Use `#F9F9F9` background with `#828282` text for neutral states. Use `#F2E7FE` background with `#673AB7` text for active/highlight states.

---

## Implementation Strategy

### Step 1: Create a shared CSS file

Create `frontend/src/styles/global.css`. This file will contain the complete `:root {}` token block (all CSS custom properties listed above) plus the primitive utility classes below. Every Astro page will import this file via a `<link>` tag or via `import '../styles/global.css'` in the frontmatter (Astro supports this).

The file structure:
- `:root {}` block with all tokens
- `body {}` baseline: font-family, color, background, margin 0
- `.btn-primary {}`: solid accent button
- `.btn-ghost {}`: transparent, accent border and text
- `.card {}`: white background, `--color-border-default` border, `--radius-card`, `--shadow-card`
- `.badge {}`: status badge primitive
- `.badge-active {}`: `#F2E7FE` background, `#673AB7` text
- `.badge-muted {}`: `#F9F9F9` background, `#828282` text

Do not create a `.btn-secondary`, `.btn-danger` etc. unless a specific plan explicitly requires them. Only create what is used.

### Step 2: Create a shared Astro layout component

Create `frontend/src/layouts/AppLayout.astro`. This layout wraps all authenticated pages (dashboard, upload, contract detail). It provides:
- The HTML shell (`<!DOCTYPE html>`, `<html>`, `<head>`, `<body>`)
- The `<link>` to `global.css`
- The Inter font import (Google Fonts or system fallback)
- The `<header>` with Genie AI logo/wordmark, user name, sign-out button — because every authenticated page currently duplicates this manually
- A `<slot />` where page content goes

The header in the layout will use `#FFFFFF` background, bottom border `1px solid var(--color-border-default)`. The Genie AI wordmark uses the text `Genie AI` styled in `#3D1152` (brand deep), weight 700. Do not attempt to reproduce the SVG logo — text wordmark is correct for a POC.

### Step 3: Update every page to use the layout and new tokens

In each page (`index.astro`, `dashboard.astro`, `upload.astro`, `contracts/[id].astro`, `sign/[token].astro`):
- Remove the page-level `<style>` block's `:root {}` section
- Remove the duplicate `<header>` markup (replaced by layout)
- Wrap content in `<AppLayout>` component
- Replace all hardcoded `#2563eb` color references with `var(--color-accent)`
- Replace all `border-radius: 0.375rem` on buttons with `var(--radius-button)`
- Replace all `border-radius: 0.75rem` on cards with `var(--radius-card)`
- Replace `font-family: sans-serif` with `var(--font-family-base)`

### Step 4: Update inline styles in dashboard.astro

The dashboard has inline styles scattered throughout JSX-style Astro template expressions (e.g. `style="border-left: 4px solid #2563eb; background: #eff6ff;"`). These are the "awaiting signature" card, the group header labels, etc. Each of these needs the color replaced. Use `var(--color-accent)` for the border, `var(--color-border-light)` (`#F2E7FE`) for the card background.

---

## Primitive Components Reference

These are the CSS class definitions to put in `global.css`. They define what future plans refer to when they say "use `.btn-primary`" or "use `.card`".

**`.btn-primary`**: background `var(--color-accent)`, color white, padding `0.625rem 1.25rem`, border none, border-radius `var(--radius-button)`, font-weight `var(--font-weight-semibold)`, cursor pointer, transition `background 0.15s ease`. Hover: `var(--color-brand-mid)`. Disabled: background `#D3B4F7`, cursor not-allowed.

**`.btn-ghost`**: background transparent, color `var(--color-accent)`, border `1.5px solid var(--color-accent)`, padding `0.5rem 1rem`, border-radius `var(--radius-button)`, font-weight `var(--font-weight-semibold)`. Hover: background `#F2E7FE`.

**`.card`**: background white, border `1px solid var(--color-border-default)`, border-radius `var(--radius-card)`, box-shadow `var(--shadow-card)`.

**`.badge`**: display inline-flex, align-items center, padding `0.2rem 0.6rem`, border-radius `var(--radius-pill)`, font-size `0.72rem`, font-weight `var(--font-weight-semibold)`, text-transform uppercase, letter-spacing `0.04em`.

**`.badge-active`**: background `var(--color-border-light)` (`#F2E7FE`), color `var(--color-accent)`.

**`.badge-muted`**: background `#F5F5F5`, color `var(--color-text-muted)`.

**`.badge-warning`**: background `#FEF9C3`, color `#854d0e` — used for "RECEIVED" label on inbound contracts.

---

## What Not To Do

- Do not install Tailwind CSS for this redesign. The codebase uses hand-written CSS. Adding Tailwind mid-project creates two parallel styling systems.
- Do not add `!important` anywhere. If specificity is a problem, restructure the selectors.
- Do not create a design system or component library. We need a shared CSS file and one layout component — not a Storybook.
- Do not use CSS-in-JS or runtime styling. All styles go in `.css` files or `<style>` blocks within Astro components.
- Do not use the gradient as a button background, even though it looks similar to the accent. The gradient is strictly for illustration use.

---

## Files to Create

| File | Action |
|---|---|
| `frontend/src/styles/global.css` | Create — all tokens and primitive classes |
| `frontend/src/layouts/AppLayout.astro` | Create — shared HTML shell, header, font import |

## Files to Modify

| File | Change |
|---|---|
| `frontend/src/pages/index.astro` | Remove `:root {}` block, use token variables, apply `AppLayout` (landing — may use a simpler layout without nav) |
| `frontend/src/pages/dashboard.astro` | Remove `:root {}` block, use `AppLayout`, replace all inline blue with token vars |
| `frontend/src/pages/upload.astro` | Remove `:root {}` block, use `AppLayout`, add missing `<meta name="viewport">` |
| `frontend/src/pages/contracts/[id].astro` | Remove `:root {}` block, use `AppLayout` |
| `frontend/src/pages/sign/[token].astro` | Remove `:root {}` block, use `AppLayout` if applicable |
