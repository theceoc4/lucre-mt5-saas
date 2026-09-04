# Soleau Gold design QA

- Source visual truth: `/Users/rayevelyn/Downloads/black-to-gold.png`
- Rendered implementation: `/private/tmp/soleau-gold-desktop-v2.png`
- Mobile implementation: `/private/tmp/soleau-gold-mobile-viewport.png`
- Combined comparison: `/private/tmp/soleau-gold-comparison.png`
- Desktop viewport: 1440 x 1000 CSS px; screenshot 1440 x 1013 px; device pixel ratio 1.
- Mobile viewport: 390 x 844 CSS px; screenshot 390 x 844 px; device pixel ratio 1.
- State: Soleau Gold selected, dark mode; light-mode token state also exercised.

## Full-view comparison evidence

The supplied six-step scale is reproduced exactly in the Appearance picker and
mapped in order through the dashboard shell: `#1B1B1B`, `#423416`, `#694D10`,
`#8F670B`, `#B68005`, and `#DD9900`. The implementation preserves the existing
Lucre layout, type hierarchy, glass surfaces, radii, and trading-semantic green
and red while replacing the general brand accent and ambient shell color.

## Focused-region evidence

A separate crop was not needed because the full desktop comparison keeps the
source swatches and the complete Appearance picker legible in the same image.
The palette preview shows all six source colors directly. Desktop and mobile
captures confirm card borders, selected state, text hierarchy, and accent use.

## Interaction and responsive checks

- Switching Lucre Sage to Soleau Gold changed `data-palette` from `lucre` to
  `soleau-gold` and the computed accent from `#d7e64e` to `#dd9900`.
- The light/dark control remained independent; Soleau Gold light mode computed
  the expected warm page background `#e9dcc0`.
- The 390px mobile state reported equal document and viewport widths with no
  horizontal overflow; palette options collapsed into the intended stacked layout.
- No application-origin console errors were observed in the rendered QA page.
- Contrast checks: light primary 15.83:1, light muted 7.23:1, dark primary
  15.70:1, dark muted 9.79:1, and dark text on the gold accent 7.08:1.

## Required fidelity surfaces

- Fonts and typography: existing Cabinet Grotesk and General Sans hierarchy is unchanged and legible.
- Spacing and layout rhythm: existing component grid, padding, radii, and responsive stacking are unchanged.
- Colors and visual tokens: source swatches are exact; derived warm neutrals maintain accessible text contrast.
- Image quality and asset fidelity: the reference contains only flat color swatches; no missing raster assets exist.
- Copy and content: `Soleau Gold` naming and the Appearance descriptions are consistent across desktop and mobile.

## Comparison history

The first fixture capture inherited the production authenticated-root hidden
state and therefore displayed no dashboard content. The fixture-only root was
made visible; the next desktop and mobile captures rendered the complete palette
state. This did not require a production component change.

## Findings

No actionable P0, P1, or P2 visual differences remain for the palette target.

## Follow-up polish

The source does not prescribe semantic profit/loss colors. They intentionally
remain green/red so trading meaning is never replaced by decorative gold.

final result: passed
