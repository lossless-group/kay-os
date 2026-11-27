# kay-os icon options

The mark was redrawn on 2026-11-27. The old one, a 3×3 panel of lamps, read as
a down arrow (top corners, centre, and two bottom lamps lit). Five options
were drawn in the same palette and compared at 128, 48, 32 and 16 px on dark
and light, and Michael chose **B**.

| File | Option | Notes |
|---|---|---|
| `B-split-flap-k.svg` | **B · Split-flap K (in use)** | An arrivals-board flap with a K in `#ece7d8`, its hinge line, and one mint status lamp. Matches the splash's "Arrivals" board. Now the app icon, favicon, both trademark lockups, and the share-image mark. |
| `A-k-in-lamps.svg` | A · K in lamps | The old 3×3 board lit as a K: mint spine, amber joint, red leg. Smallest change from the old mark. |
| `C-status-lamps.svg` | C · Status lamps | Three bars, mint, amber, red, shortening: the page's LIVE / NEXT / PLANNED lamps. |
| `D-colony.svg` | D · Colony | Seven lamps in a hive: the colony around you, one amber (working), one red (needs you). |
| `E-lamp-clock.svg` | E · Lamp clock | Twelve lamps as a clock face, the next hour amber, a hand pointing at it. Archivist plus Timekeeper. |
| `0-lamp-panel-retired.svg` | The old mark | Kept for reference. |

Palette (from `../../DESIGN.md`): tile `#030504` with a `#1c2321` edge, mint
`#6fe3b4`, amber `#ffb000`, red `#ff4f3a`, unlit `#2a302e`, cream `#ece7d8`.

These files are not served by the site; the ones in use live in
`../../public/brand/` and `../../public/favicon.svg`.

## Comparing options

`compare.html` is the page the choice was made on: every option at 128, 48,
32 and 16 px, on dark and on light, so the favicon sizes get judged too. Open
it straight in a browser (it needs no server). For a new round, add an `<svg>`
to its `<template>` with a `data-name` and a `data-note`, and it lays itself
out as another card.
