---
name: BroccoliQueue
description: A compact operations dashboard for inspecting and managing process-local background jobs.
colors:
  bg: "var(--bg)"
  surface: "var(--surface)"
  surface-2: "var(--surface-2)"
  sidebar: "var(--sidebar)"
  line: "var(--line)"
  line-strong: "var(--line-strong)"
  text: "var(--text)"
  muted: "var(--muted)"
  faint: "var(--faint)"
  accent: "var(--accent)"
  accent-hover: "var(--accent-hover)"
  accent-soft: "var(--accent-soft)"
  focus: "var(--focus)"
  live: "#3ca86b"
  red: "var(--red)"
  red-soft: "var(--red-soft)"
  amber: "var(--amber)"
  amber-soft: "var(--amber-soft)"
  blue: "var(--blue)"
  blue-soft: "var(--blue-soft)"
  on-accent: "#ffffff"
typography:
  display:
    fontFamily: 'Georgia, "Times New Roman", serif'
    fontSize: "23px"
    fontWeight: 700
    lineHeight: 1.22
    letterSpacing: "-.035em"
  headline:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
    fontWeight: 650
    letterSpacing: "-.005em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "10px"
    fontWeight: 650
    letterSpacing: ".055em"
  action:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "12px"
    fontWeight: 600
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 400
rounded:
  chip: "5px"
  input: "6px"
  button: "7px"
  nav: "8px"
  panel: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "30px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.button}"
    padding: "0 11px"
    height: "34px"
    typography: "{typography.action}"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.button}"
    height: "34px"
  button-quiet:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.button}"
    padding: "0 11px"
    height: "34px"
    typography: "{typography.action}"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.red}"
    rounded: "{rounded.button}"
    padding: "0 11px"
    height: "34px"
    typography: "{typography.action}"
  input-search:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.input}"
    padding: "0 10px 0 32px"
    height: "34px"
    typography: "{typography.action}"
  chip-completed:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    rounded: "{rounded.chip}"
    padding: "3px 7px"
    typography: "{typography.label}"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.nav}"
    padding: "0 10px"
    height: "38px"
    typography: "{typography.body}"
  card-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "0"
  metric-strip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "0"
  job-detail-dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "0"
    width: "min(630px, calc(100vw - 24px))"
---

# Design System: BroccoliQueue

## Overview

**Creative North Star: "The Queue Operator’s Workbench"**

This operations interface puts queue state and the next useful action in the same working surface. Cool, restrained surfaces make dense operational data easy to scan; the green accent draws attention to primary actions and successful work, while state-specific colors keep delayed, active, and failed jobs distinct.

The interface uses the operating system’s sans-serif stack for controls and data, Georgia for the page title, and monospace for job identifiers and payloads. Panels rely on borders and subtle surface changes for separation, with stronger elevation reserved for dialogs and transient feedback. Light and dark themes share the same semantic color names.

**Key Characteristics:**
- Compact tables, state totals, and operator controls.
- Cool neutral surfaces with a restrained broccoli green accent.
- System sans-serif interface type, a serif page title, and monospace job data.
- State labels pair text with a colored dot and tinted surface.

## Colors

The palette is built from semantic theme variables, so light and dark modes keep the same roles while changing their values.

### Primary
- **Broccoli Green** (accent): Primary actions, completed work, and selected job filters use the theme accent. Hover uses its deeper light-theme or brighter dark-theme value.
- **Runtime Green** (live): A compact green dot and ring mark a connected runtime; this is separate from the general accent.

### Secondary
- **Active Blue** (blue): Active work and its status badge.
- **Queue Amber** (amber): Delayed work and paused queues.
- **Alert Red** (red): Failed work, inline errors, and destructive actions.
- Their corresponding soft theme colors provide the status badge and alert backgrounds.

### Neutral
- **Cool Canvas** (bg): The page background around working surfaces.
- **Work Surface** (surface): Panels, dialogs, and controls.
- **Inset Surface** (surface-2): Table headings, code blocks, and quiet inset areas.
- **Sidebar Surface** (sidebar): The desktop navigation rail.
- **Soft Divider** (line) and **Strong Divider** (line-strong): Separate panels and define control boundaries.
- **Primary Ink** (text), **Muted Ink** (muted), and **Faint Ink** (faint): Establish reading hierarchy for content, helper text, and metadata.
- **Focus Green** (focus): Defines the visible keyboard focus outline.
- **On-Accent White** (on-accent): Keeps primary button labels legible.

**The State-Color Rule.** Use the broccoli accent for primary actions and completed work; use the separate live green for runtime health, and amber, blue, and red for delayed, active, and failed states.

## Typography

**Display Font:** Georgia (with Times New Roman, serif fallback)  
**Body Font:** The system sans-serif stack (with Segoe UI, sans-serif fallback)  
**Label Font:** The system sans-serif stack.  
**Mono Font:** ui-monospace, SFMono-Regular, Menlo, monospace

**Character:** The title serif gives the page a restrained editorial accent, while system sans keeps tables and controls compact and familiar. Monospace is reserved for identifiers and structured job content.

### Hierarchy
- **Display** (700, 23px desktop / 20px mobile, 1.22 line-height): Page title only.
- **Headline** (650, 13px): Panel headings.
- **Body** (400, 14px, 1.45 line-height): Interface copy and navigation.
- **Label** (650, 10px, .055em letter spacing): Compact table headings and status labels.
- **Mono** (400, 11px): Job identifiers and structured values; larger payload text uses 12px.

**The One-Serif Role Rule.** Keep Georgia on the page title; use system sans for interface copy and system monospace for identifiers and payloads.

## Layout

The desktop frame pairs a fixed left navigation rail with a centered work area capped at 1510px. The main content uses 30px horizontal padding at wide widths, reducing to 22px below 980px and 14px below 700px. The rail narrows from 224px to 198px below 980px, then becomes a sticky horizontal brand and navigation bar below 700px.

Use a four-column state summary on wide screens and two columns on phones. The main overview places the queue table beside a narrower worker and runtime column; these sections stack below 980px. Tables keep compact rows, uppercase column labels, thin dividers, and horizontal scrolling when needed. Use 4–20px gaps for repeated component spacing, with 30px page gutters at wide desktop sizes.

## Elevation & Depth

The default is surface-first: panels and controls stay flat with one-pixel dividers and small tonal differences. The theme shadow is reserved for dialogs and toasts; the current navigation item has a very light shadow to separate it from the rail.

**The Surface-First Rule.** Let borders and tonal surface changes define data panels; reserve the theme shadow for dialogs and toasts, with only a very light shadow on current navigation.

## Shapes

The form language uses compact, gently rounded rectangles rather than pill-shaped controls. Status chips have a 5px radius; inputs use 6px, buttons 7px, navigation items 8px, and panels and dialogs 12px. Thin borders define panels and controls. Keyboard focus uses a visible green-tinted outline with a 2px offset.

## Components

### Buttons
- **Character:** Compact and direct, with a clear primary action and restrained secondary actions.
- **Shape:** Gently rounded (7px), 34px high with 11px horizontal padding.
- **Primary:** Broccoli green fill with white text; hover shifts to the theme’s hover green.
- **Quiet:** Surface fill, strong divider, and standard text; hover uses the inset surface.
- **Danger:** Surface fill with red text and a blended red divider; hover uses the soft red surface.
- **Focus:** A 3px green-tinted outline sits 2px outside the control.

### Chips
- **Style:** Compact state badges (5px radius) with a 6px leading dot and 3px by 7px padding.
- **State:** Waiting and cancelled use neutral tones; delayed and paused use amber; active uses blue; completed uses green; failed uses red. Each state retains its text label.

### Cards / Containers
- **Corner Style:** Softly rounded (12px).
- **Background:** Work surface, with inset surfaces for table headings and code blocks.
- **Shadow Strategy:** Flat at rest; see Elevation & Depth.
- **Border:** One-pixel soft divider.
- **Internal Padding:** Panel headings use 12px vertical and 16px horizontal padding; table cells use 10–14px horizontal padding.

### Inputs / Fields
- **Style:** Surface fill, strong divider, 6px radius, and 34px control height. Search inputs reserve space for a leading search icon.
- **Focus:** A 3px focus outline with 2px offset.
- **Error / Disabled:** Errors use red text on a soft red surface; disabled buttons reduce opacity and use a not-allowed cursor.

### Navigation
- **Style:** A compact left rail with icon and text labels. Current items use a surface background and subtle shadow; hover uses a translucent surface.
- **Mobile:** At 700px and below, the rail becomes a sticky horizontal brand row and scrollable navigation strip.

### Metric Strip
The state summary groups four counts inside a bordered surface. Use equal-width columns on desktop and a two-column arrangement on phones; figures use tabular numerals and failed counts use the error color.

### Job Detail Dialog
The native dialog uses a 12px corner, a theme shadow, a sticky header, a three-column metadata grid that becomes two columns on phones, and inset monospace blocks for payloads, results, and errors. Keep retry or cancellation controls adjacent to the inspected job details.

## Do's and Don'ts

### Do:
- **Do** pair every job-state color with its text label and leading dot so status remains legible without color alone.
- **Do** use cool theme surfaces and one-pixel dividers to separate adjacent data.
- **Do** use tabular figures for counts and times, and monospace for job identifiers and payloads.

### Don't:
- **Don't** use Georgia for navigation, forms, or table copy.
- **Don't** collapse waiting, active, delayed, completed, failed, and cancelled jobs into a single accent treatment; preserve their distinct status colors and labels.
- **Don't** make repeated data panels depend on heavy shadows; the implementation separates them with surface contrast and borders.

