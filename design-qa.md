# Pair Card Performance Strip — Design QA

- Source visual truth: `/var/folders/s1/w5hdt7dn595dy2x09p26qf5r0000gn/T/TemporaryItems/NSIRD_screencaptureui_trOaAi/Screenshot 2026-09-02 at 3.32.43 PM.png`
- Browser-rendered implementation: `/private/tmp/lucre-pair-card-implementation.png`
- Mobile implementation: `/private/tmp/lucre-pair-card-mobile.png`
- Normalized comparison: `/private/tmp/lucre-pair-card-comparison.png`
- Desktop viewport: 956 x 756 CSS pixels, device pixel ratio 1
- Source pixels: 956 x 756
- Implementation pixels: 956 x 756
- Component comparison: source and implementation card crops normalized to 930 x 745 pixels to account for the Retina source capture and the in-app browser's capture scaling
- Mobile viewport: 390 x 844 CSS pixels
- State: dark theme, AUDCAD trading/front face, enabled, Auto SL/TP off, representative populated performance values

## Full-view comparison evidence

The new three-column performance strip sits between Auto SL/TP and the bottom
one-click buttons, using the card's existing sunken surface, border, type,
positive color, and spacing tokens. The header, trend meter, Auto SL/TP row,
card radius, glass treatment, and bottom-aligned Sell/Buy controls retain the
source hierarchy and proportions. The inserted content uses previously empty
vertical space instead of increasing the card footprint.

## Focused region comparison evidence

The normalized side-by-side card comparison makes the new labels and values
readable at equivalent component size. Column dividers are subtle, values have
more weight than labels, and the green Daily P/L remains the only new semantic
color. No separate crop was needed beyond the normalized full-card comparison
because the affected region occupies the middle of this single component and
is legible there.

## Required fidelity surfaces

- Fonts and typography: existing Cabinet Grotesk and General Sans tokens are
  preserved. Labels use compact uppercase tracking; values use the display
  family and remain single-line.
- Spacing and layout rhythm: the row uses three equal minmax columns, centered
  alignment, existing radius and border tokens, and does not move the bottom
  action buttons out of their anchored position.
- Colors and visual tokens: all colors come from existing surface, border,
  text, positive, and negative theme tokens in both light and dark modes.
- Image quality and asset fidelity: no imagery or new icons were required; the
  source card's existing visual assets and glass treatment are unchanged.
- Copy and content: labels are exactly `Win %`, `Best Session`, and `Daily P/L`.
  Empty historical values render as an em dash; Daily P/L remains a meaningful
  $0.00 when there are no verified closes today.

## Interaction and responsive checks

- Desktop card rendered with all three values visible and no console warnings
  or errors.
- Mobile card rendered at 390 px with a 358 px card and 308 px performance
  strip; document horizontal overflow was false.
- The new row is informational and adds no interactive surface. Existing card
  flip, enable, Auto SL/TP, Sell, and Buy event handlers were not changed.
- The authenticated production data state was not reproduced locally; visual
  QA used representative values while data correctness was checked directly
  against the existing verified trade-history model.

## Findings

No actionable P0, P1, or P2 differences remain. The new row is intentionally
absent from the source because it is the requested addition.

## Comparison history

The initial fixture used a wider-than-production card, so it was corrected to
the source card's normalized 462 x 370 CSS proportions before the passing
comparison. Post-fix evidence is recorded in the normalized comparison and the
390 px mobile capture above.

## Follow-up polish

No blocking polish remains. Longer localized session labels would use the
existing single-line ellipsis behavior.

final result: passed
