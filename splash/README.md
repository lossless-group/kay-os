# kay-os splash

The GitHub Pages face of `kay-os`: https://lossless-group.github.io/kay-os/

It's built for someone deciding whether kay-os is for them: a person with
too many involvements, inboxes and calendars, often with ADHD or a 2e mind. The page
says what the colony is, what the ADHD and executive-function study found,
the house rules that came out of it, and which agents work today.

## Local dev

```bash
pnpm install    # splash/ is its own pnpm workspace (pnpm-workspace.yaml)
pnpm dev        # http://localhost:4321/kay-os/
pnpm build      # static site + Pagefind index in dist/
pnpm preview    # exercise search locally
```

pnpm refuses to run dependency build scripts until they're approved.
Approvals live in `pnpm-workspace.yaml` (`allowBuilds:`). Don't install with
`--ignore-workspace`: it skips those approvals and the install fails.

## Deploy

`.github/workflows/pages.yml` at the repo root builds `splash/` and deploys
to GitHub Pages on every push to `main`. In the repo's settings, Pages →
Source must be **GitHub Actions**.

## Where content lives

| What | Where |
|---|---|
| Home page copy: the board, premise, study table, house rules, colony roster | `src/pages/index.astro`, as arrays at the top |
| SEO title, description, repo and study links | `src/lib/seo.ts` |
| Changelog | `../changelog/`, rendered as-is |
| Explorations and blueprints | `../context-v/`. Files marked `publish: false` or `private: true` are skipped |
| Look and feel | `DESIGN.md` (the contract) and `src/styles/theme.css` (the values) |
| Share images | `scripts/og-template.html`, rendered by `scripts/render-og.sh` into `public/` |

When an agent's status changes (planned → next → live), update the `colony`
array in `index.astro`. The board in the hero is illustrative and must never
show real mail.

## Share images

```bash
scripts/render-og.sh            # all six formats → public/ogimage__Kay-Os--*.jpg
scripts/render-og.sh Portrait   # just one
```

Needs Firefox and ImageMagick (run through `nix run` on NixOS). After
changing the bytes, bump `?v=` on `DEFAULT_OG.url` in `src/lib/seo.ts` so
chat apps fetch the image again.

## Analytics

OpenPanel, through `src/components/Analytics.astro` (the exact component
from the `openpanel-analytics` skill). It only renders in a production build
with `OPENPANEL_CLIENT_ID` set, so local dev never sends events.

- The client ID comes from the OpenPanel client `splash_kay-os`, and is
  set as a repo **Variable** (not a Secret) named `OPENPANEL_CLIENT_ID`. The
  Pages workflow passes it to the build.
- That client's **supported domains** must include
  `https://lossless-group.github.io/`, or every event gets a 401.
- If your shell exports `NODE_ENV=development`, a local `pnpm build` is not
  a production build and leaves the script out. Use
  `NODE_ENV=production pnpm build` to check it.
