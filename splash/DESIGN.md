---
version: alpha
name: kay-os splash
description: The arrivals board. A colony of agents for people with too many lives, dressed like the board at a busy terminal.
colors:
  signal: "#ffb000"
  phosphor: "#6fe3b4"
  alarm: "#ff4f3a"
  carbon: "#1f3a8a"
  terminal-deep: "#070a09"
  buff: "#f3eddf"
  ink: "#17202a"
typography:
  display:
    fontFamily: Big Shoulders Display
    fontWeight: 800
    textTransform: uppercase
  body:
    fontFamily: Atkinson Hyperlegible Next
    fontWeight: 400
  mono:
    fontFamily: Atkinson Hyperlegible Mono
    fontWeight: 400
rounded:
  sm: 2px
  md: 3px
  lg: 4px
  lamp: 50%
spacing:
  unit: 4px
components:
  board:
    background: "{colors.terminal-deep}"
    textColor: "{colors.signal}"
  flap:
    description: One split-flap tile, a seam across its middle
  lamp:
    description: Status light. phosphor = handled, signal = in hand, alarm = needs you
  ledger-row:
    description: Dense hairline row, 2px rule above the first
imagery:
  technique: rasterize-hero        # Technique B in generate-consistent-og-images
  template: scripts/og-template.html
  renderer: scripts/render-og.sh   # headless Firefox + ImageMagick
  naming: ogimage__Kay-Os--{Format}.jpg
  default: Banner
  formats:
    Banner: 1200x630
    BannerTall: 1200x1600
    BannerTallMax: 1200x1800
    Portrait: 1080x1350
    PortraitTall: 1080x1920
    Square: 1200x1200
---

## Overview

kay-os is for the self-important and the overwhelmed: people with seven
inboxes, four calendars, and a dozen involvements, often with ADHD or a 2e
mind. The page dresses like an arrivals board because that's what their day
feels like: too many things landing at once, each with a status. The
colony's job is to turn the red lamps green.

## Colors

The brand spine is a departures board: **signal amber** for the tiles and
the accent, **phosphor mint** for "handled", **alarm red** for "needs you".
Dark mode (the default, "night desk") puts them on green-black. Light mode
("carbon copy") is buff paper with carbon-blue ink, and the board stays a
black slab printed on it. Vibrant ("all hands") is ultraviolet with hot pink
and chartreuse.

## Typography

- **Big Shoulders Display**, uppercase, 800–900: headlines, numbers, agent
  names. Condensed like a board's lettering.
- **Atkinson Hyperlegible Next**: body. Drawn by the Braille Institute for
  legibility, which suits a page written for people who struggle to keep
  reading.
- **Atkinson Hyperlegible Mono**: the board's tiles, eyebrows, sources.

## Layout

Left-aligned and full-width. The hero headline runs across the top, and the
board spans the container under it. Below it, every section is a ledger:
dense rows with hairline separators and a 2px rule on top. There are no
cards.

## Elevation & Depth

Flat. The only depth is the board's shadow and the glow on its lamps.

## Shapes

Square hardware: 2–4px radii. Only the status lamps are round.

## Components

- **Board**: a split-flap status column per row, with a lamp. The tiles flip
  in on load, starting from a readable frame so screenshots never show an
  empty board.
- **Folio**: a gate number (`G1`…`G6`) on each section.
- **Stamp**: a double-ruled status (LIVE / NEXT / PLANNED) in the colony roster.

## Imagery

Share images rasterize the hero instead of illustrating it: the headline
and a five-row arrivals board, rendered from `scripts/og-template.html`
at each format's size. Landscape puts the board beside the headline. Tall
formats stack them, so a chat preview cropped to the top still carries the
headline. Square drops the subhead to keep the board whole. Everything is
drawn in the dark "night desk" tokens. Regenerate with
`scripts/render-og.sh`; it archives any image it replaces to
`.ogimage-archive/` (gitignored).

## Do's and Don'ts

- Do keep the board illustrative. It never shows real mail, names, or addresses.
- Do keep claims about agents honest: only what works today is LIVE.
- Don't add rounded cards, gradients behind sections, or a centered hero.
  Those belong to sibling splashes.
- Don't use shame words (lazy, failed, behind). The house rules apply to the
  page too.
