# Design QA — Social input and hashtag update v1.0.80

## Source and evidence

- Source visual truth: `/Users/rayevelyn/Desktop/Screenshot 2026-09-06 at 7.38.13 PM.png` (802 × 304 px).
- Corrected focused-field capture: `/private/tmp/lucre-v1.0.80-focus-fixed.png` (700 × 220 px).
- Side-by-side comparison: `/private/tmp/lucre-v1.0.80-focus-comparison.png` (802 × 568 px).
- Inbox interaction capture: `/private/tmp/lucre-v1.0.80-inbox-focus.png` (1280 × 720 px).
- Hashtag/Trending capture: `/private/tmp/lucre-v1.0.80-hashtag-ui.png` (1280 × 720 px).
- Mobile focused-field capture: `/private/tmp/lucre-v1.0.80-mobile-focus.png` (390 × 844 px).
- State: dark Seaside palette; username field focused; inbox open and composing; Social composer with optional hashtags.

## Full-view comparison

The source shows the browser focus ring painted around the nested text input,
which clips into a bright blue vertical slice over the `$` prefix. The revised
control paints one continuous focus ring around the shared prefix/input shell.
The final comparison shows the prefix, username, border, and focus treatment as
one uninterrupted field with no interior highlight artifact.

## Focused-region comparison

- Fonts and typography: the existing Lucre families, weights, sizes, and field
  hierarchy remain unchanged.
- Spacing and layout rhythm: prefix and text padding remain aligned; no width or
  modal-layout changes were introduced. The 390px mobile capture has zero
  horizontal overflow.
- Colors and visual tokens: focus uses the active palette's accent and retains
  the Seaside surface/border colors shown in the source.
- Image quality and assets: no image or icon assets are involved in this fix.
- Copy and content: the required-tag control is removed. Composer guidance now
  explains optional `#hashtags`; the discovery card is titled `Trending` with a
  visible rolling 30-day period.

## Interaction verification

- The account modal opens with focus on the handle field and the page behind it
  marked inert.
- The inbox accepts typed content and retains the full message value.
- Tab navigation remains inside the inbox; the underlying comment input never
  receives focus.
- Closing the modal removes page isolation and restores normal page focusability.
- No required tag control exists in the rendered composer.
- Desktop and mobile document widths match their viewport widths.
- Browser console errors/warnings during the focused, inbox, and hashtag states: none.

## Comparison history

- Pass 1 P2: nested input focus outline visibly crossed the `$` prefix. Fixed by
  suppressing the inner outline and applying `:focus-within` to the shared shell.
- Pass 1 P1: the background timeline remained keyboard-focusable while a modal
  was open. Fixed with modal-layer isolation, focus containment, and cursor
  restoration during realtime inbox rendering.
- Pass 2: corrected focus, inbox, mobile, and hashtag states show no remaining
  actionable P0, P1, or P2 issue.

## Follow-up polish

No P3 follow-up is required for this scoped correction.

final result: passed
