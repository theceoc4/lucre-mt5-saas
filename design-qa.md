# Design QA — Uniform Pair Cards

## Evidence

- Source visual truth: `/var/folders/s1/w5hdt7dn595dy2x09p26qf5r0000gn/T/TemporaryItems/NSIRD_screencaptureui_u051w2/Screenshot 2026-09-05 at 12.09.40 AM.png`
- Source dimensions: 1888 × 806 px.
- Browser-rendered desktop implementation: `/private/tmp/pair-card-fixed-height-desktop.png`
- Browser-rendered flipped-card implementation: `/private/tmp/pair-card-fixed-height-flipped.png`
- Desktop viewport and capture: 1000 × 600 CSS px, device pixel ratio 1.
- Browser-rendered mobile implementation: `/private/tmp/pair-card-fixed-height-mobile.png`
- Mobile viewport and capture: 390 × 844 CSS px, device pixel ratio 1.
- Combined comparison: `/private/tmp/pair-card-height-comparison.png`
- State: Pairs grid, Seaside dark palette, two cards whose hidden back faces contain different amounts of content.

## Full-view comparison

The source screenshot documents the defect: AUDCAD uses the desired compact height while BTCUSD stretches its row. The corrected desktop and mobile renders keep both shells at exactly 358px, matching the compact target. The card fronts retain the established spacing, controls, metric strip, and bottom-aligned Sell/Buy actions.

## Focused region comparison

The two-card region was compared directly. Both front faces and both back faces measure 358px. Pair names now render at 20px and weight 800 on desktop, while the existing responsive type scale produces approximately 17px on the tested mobile viewport. Flipping BTCUSD does not alter either card's shell or row height.

## Required fidelity surfaces

- Typography: Existing display and body fonts remain unchanged. Pair names use the next existing display size and a heavier bold weight.
- Layout rhythm: Every card shell is 358px tall; metric rows and trading actions remain aligned between cards.
- Colors and tokens: The current theme tokens are preserved with no palette-specific hard-coded colors.
- Dense states: Expanded Auto SL/TP controls and longer price-history details scroll inside the fixed face instead of stretching the grid.
- Responsiveness: The 358px shell is retained on mobile, with the existing responsive padding and type scale intact.

## Findings

- No actionable P0, P1, or P2 visual mismatches remain.
- P3: A dense back face may require a short contained scroll, which is intentional so rare additional detail cannot resize the surrounding grid.

## Interaction and runtime checks

- Confirmed AUDCAD and BTCUSD shell, front-face, and back-face heights are all 358px.
- Confirmed BTCUSD can flip to its longer back face without resizing the row.
- Confirmed desktop and mobile renders have equal card heights.
- Checked the browser console after render and flip interaction; no errors were reported.

## Comparison history

- Pass 1: Equal-height desktop front faces passed.
- Pass 2: Flipped state and mobile stack passed with no P0/P1/P2 findings.

## Implementation checklist

- [x] Match every pair card to the smaller card height shown in the source.
- [x] Prevent hidden back-face content from changing grid-row height.
- [x] Increase pair-name size and weight.
- [x] Preserve access to dense content through contained scrolling.
- [x] Verify desktop, mobile, and flipped states.

final result: passed
