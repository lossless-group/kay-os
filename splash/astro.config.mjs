// @ts-check
import { defineConfig } from 'astro/config';
import pagefind from 'astro-pagefind';
import sitemap from '@astrojs/sitemap';

// Splash for kay-os. Two hosts, one build:
//
//   GitHub Pages: https://lossless-group.github.io/kay-os/  (project page, base '/kay-os/')
//   Vercel:       served from the domain root                (base '/')
//
// Vercel sets VERCEL=1 during builds, and VERCEL_PROJECT_PRODUCTION_URL to the
// project's production domain. SITE_URL overrides both, e.g. once a custom
// domain is attached.
const onVercel = process.env.VERCEL === '1';
const site =
  process.env.SITE_URL ??
  (onVercel && process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : 'https://lossless-group.github.io');

export default defineConfig({
  site,
  base: onVercel || process.env.SITE_URL ? '/' : '/kay-os/',
  trailingSlash: 'ignore',

  integrations: [
    pagefind(),
    sitemap({
      filter: (page) =>
        !page.includes('/llms.txt') &&
        !page.includes('/llms-full.txt') &&
        !page.endsWith('/404/') &&
        !page.endsWith('/404'),
    }),
  ],

  build: {
    format: 'directory',
  },
});
