# Design QA — Social Floating P/L Cleanup

## Evidence

- Source visual truth: `/var/folders/s1/w5hdt7dn595dy2x09p26qf5r0000gn/T/TemporaryItems/NSIRD_screencaptureui_0EUHhk/Screenshot 2026-09-04 at 10.22.04 PM.png`
- Source dimensions: 2846 × 484 px.
- Browser-rendered desktop implementation: `/private/tmp/social-page-cleanup-desktop.png`
- Desktop viewport and capture: 1440 × 900 CSS px, device pixel ratio 1, 1440 × 900 px image.
- Browser-rendered mobile implementation: `/private/tmp/social-page-cleanup-mobile.png`
- Mobile viewport and capture: 390 × 844 CSS px, device pixel ratio 1, 390 × 844 px image.
- Combined comparison image: `/private/tmp/social-page-cleanup-comparison.png`
- State: Social page, Seaside dark palette, negative floating P/L.

## Full-view comparison

The combined comparison confirms the reported duplicate account strip is absent from the corrected Social page. The Floating P/L control is centered at exactly 30% of its desktop dock width (386.88 px of 1289.61 px), and the dock no longer paints a translucent rectangular backplate or exterior drop shadow. The composer and timeline begin directly beneath the focused action.

## Focused region comparison

The Social page top region was compared directly because all requested changes live there. The button now contains the `Floating P/L` label above the dollar value, retains the existing Seaside negative-state token, and preserves the established pill radius and typography hierarchy. No additional focused crop was needed because the relevant controls and text are fully readable in the combined image.

## Required fidelity surfaces

- Fonts and typography: Existing General Sans/Cabinet Grotesk tokens remain intact. The restored label uses the dashboard's compact uppercase label treatment; the amount retains display weight and tabular readability.
- Spacing and layout rhythm: Desktop action width is 30%, center delta is 0 px, and the 76 px button height leaves clear space before the composer. Mobile width expands to 326 px within its 326 px content area to remain tappable.
- Colors and visual tokens: The control continues using Seaside semantic negative colors; no hard-coded palette values were introduced.
- Image quality and asset fidelity: No image assets are part of this focused UI change, and no placeholder or substitute artwork was added.
- Copy and content: `Floating P/L` appears above the live dollar amount exactly as requested. The shared Balance, Equity, Margin Level, and Floating P/L strip is not visible in Social.

## Findings

- No actionable P0, P1, or P2 visual mismatches remain.
- P3: The source screenshot does not show the surrounding Social timeline, so fidelity judgment outside the corrected top region is intentionally limited to regression checking.

## Interaction and runtime checks

- Confirmed the hidden shared account strip remains in the DOM for other pages but computes to `display: none` while hidden.
- Confirmed the Social action retains the existing close-all hook and accessible label; no live trading command was sent during QA.
- Confirmed desktop centering and the mobile responsive width.
- Checked browser console output; no errors were reported by the QA fixture.

## Comparison history

- Pass 1: No P0/P1/P2 findings. The requested duplicate strip removal, transparent dock, centered 30% control, and restored label were all visible in the first corrected comparison. No design-QA repair iteration was required.

## Implementation checklist

- [x] Hide the shared account strip only when Social is active.
- [x] Remove the Social dock backplate and excess shadow.
- [x] Center the Floating P/L button at approximately 30% desktop width.
- [x] Restore the Floating P/L label above the amount.
- [x] Preserve a practical mobile tap target.

final result: passed
