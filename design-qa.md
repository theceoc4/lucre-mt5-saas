# Design QA — Position ledger alignment v1.0.78

## Evidence

- Source visual truth: `/var/folders/s1/w5hdt7dn595dy2x09p26qf5r0000gn/T/TemporaryItems/NSIRD_screencaptureui_SkGtZB/Screenshot 2026-09-06 at 2.54.59 PM.png` (2086 × 776).
- Browser-rendered implementation: `/private/tmp/lucre-position-ledger-v1.0.78.png` (2086 × 776).
- Combined comparison: `/private/tmp/lucre-position-ledger-comparison-v1.0.78.png` (2086 × 1632).
- Desktop viewport: 2086 × 776 CSS px. Mobile viewport: 390 × 844 CSS px.
- Density normalization: both desktop captures use the same 2086 × 776 pixel canvas at device scale 1. The mobile check used its native CSS viewport.
- State: dark Seaside palette; open-position ledger with two representative rows, including short and long strategy names.

## Full-view comparison

The reported screen showed the strategy value drifting far to the right of its header because the generic mini-table flex rule overrode the position row's grid. The revised implementation gives the header and every position row one shared four-track grid. Desktop measurements confirm identical x coordinates and widths for Symbol, Strategy, Live P/L, and Actions across the header and both rows, with zero horizontal overflow.

## Focused-region comparison

- Fonts and typography: existing Lucre type families, sizes, weights, truncation, and tabular P/L figures are preserved.
- Spacing and layout rhythm: header and rows share tracks at x=118, 854.17, 1446.31, and 1808, with widths 720.17, 576.14, 345.69, and 160 pixels respectively. Divider lines and action spacing remain consistent.
- Colors and visual tokens: all values and controls continue to use the active palette's semantic positive, negative, border, and text tokens.
- Image quality and asset fidelity: this component contains no raster imagery or new icon assets.
- Copy and content: Symbol, Strategy, Live P/L, and Actions remain unchanged; the sample live value is explicitly net of costs.

## Responsive and interaction verification

- Desktop: both sample rows align exactly to the four header tracks.
- Mobile: rows retain the established stacked layout at 390 × 844 with zero document overflow.
- Modify and Close remain normal interactive buttons; no control layer or pointer behavior changed.

## Comparison history

- Earlier P1: Strategy, Live P/L, and Actions were rendered by a flex row while the header used a grid, so columns could not align. Fixed by increasing selector specificity and binding both header and row to `--position-ledger-columns`.
- Post-fix evidence: every measured row child has the same x coordinate and width as its corresponding header cell at the reference desktop viewport.

## Findings

No remaining actionable P0, P1, or P2 issues were found in the requested position-ledger alignment or responsive behavior.

## Follow-up polish

No P3 follow-up is required for this scoped correction.

final result: passed
