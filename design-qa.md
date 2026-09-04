# Soleau Gold semantic-color design QA

- Source visual truth: `/Users/rayevelyn/.codex/generated_images/01a02ffc-090a-7373-8d71-3aeedabdfb9b/exec-66dfd66f-8b89-47ad-a072-7fa28b8541b0.png`
- Rendered implementation: `/private/tmp/soleau-theme-implementation.png`
- Combined comparison: `/private/tmp/soleau-theme-comparison.png`
- Source dimensions: 1411 x 1115 px.
- Implementation capture: 1280 x 774 px from a 1280 x 720 CSS viewport; browser-reported device pixel ratio 2 and normalized screenshot density 1.
- State: Soleau Gold, dark mode, representative Pair card, positive Lock In state, P/L heatmap, notifications, status badges, and destructive action.

## Full-view comparison evidence

The approved mockup and browser-rendered implementation were opened together in
`/private/tmp/soleau-theme-comparison.png`. Both use near-black warm surfaces,
dark-brown bearish controls, vibrant-gold bullish controls, warm ivory text, and
restrained bronze borders. The implementation intentionally adds the requested
Daily P/L, heatmap, Lock In, notification, and status states around the selected
Pair-card direction.

## Focused-region evidence

The Pair card was inspected separately in the browser capture. Its meter runs
from `#423416` through the neutral sunken surface to `#DD9900`; Sell renders as
`#423416` with warm ivory text; Buy renders as `#DD9900` with `#1B1B1B` text.
The positive Lock In button uses the same gold/ink pair. Heatmap loss cells use
dark-brown opacity and profit cells use gold opacity, with transparent zero cells.

## Interaction and responsive checks

- Theme-change handling still redraws the volume, P/L, strategy, and heatmap charts.
- Semantic state tokens were verified from computed browser styles.
- Buy and positive Lock In computed to `rgb(221, 153, 0)` with `rgb(27, 27, 27)` text.
- Sell computed to `rgb(66, 52, 22)` with `rgb(255, 248, 232)` text.
- Heatmap legend language changes from red/green to dark brown/gold under Soleau Gold.
- No browser console warnings or errors were present in the QA fixture.

## Required fidelity surfaces

- Fonts and typography: the existing Cabinet Grotesk and General Sans hierarchy is unchanged.
- Spacing and layout rhythm: existing production component spacing, grids, radii, and sizing are unchanged.
- Colors and visual tokens: positive, negative, danger, warning, soft-state, surface, and foreground tokens now inherit the Soleau Gold scale consistently.
- Image quality and asset fidelity: no raster assets were introduced; the implementation is code-native UI using the approved palette.
- Copy and content: Pair health and heatmap guidance no longer assumes that semantic states are always red or green.

## Comparison history

The first semantic pass exposed insufficient contrast for small bearish text on
the dark-brown surface. Bearish surfaces remained `#423416`, while dark-theme
text and outlines moved to the palette's restrained bronze `#B99345`. The final
browser capture confirms the distinction without reintroducing red or green.

## Findings

No actionable P0, P1, or P2 visual differences remain for this theme update.

## Follow-up polish

P3: real production data may reveal unusually dense chart/notification states;
the underlying semantic tokens will still apply without component-specific fixes.

final result: passed
