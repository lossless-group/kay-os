/**
 * Static SEO copy for the kay-os splash. Centralized so MetaTags + index
 * hero read from one source of truth.
 */

export const REPO_URL = 'https://github.com/lossless-group/kay-os';
export const STUDY_URL = 'https://github.com/lossless-group/study-adhd-and-executive-function-skills';

export const STATIC_SEO = {
  brand: 'kay-os',
  titleSuffix: ' — kay-os',
  siteName: 'kay-os',

  root: {
    title: 'kay-os — an agent colony for people with too many lives',
    description:
      'A colony of personal agents for the self-important and the overwhelmed: seven inboxes, four calendars, a dozen involvements, one of you. Built on what ADHD and executive-function agent skills actually do.',
  },

  changelog: {
    title: 'Changelog',
    description: 'What changed in kay-os, and when.',
  },

  contextV: {
    title: 'Behind the Colony',
    description:
      'Explorations and blueprints behind kay-os, written in the open.',
  },
} as const;

/**
 * Default OG image lives in /public/.
 */
export const DEFAULT_OG = {
  url: 'ogimage__Kay-Os--Banner.jpg?v=1',  // bump v when the bytes change, to force a re-unfurl
  width: 1200,
  height: 630,
  type: 'image/jpeg',
  alt: 'kay-os — an agent colony for people with too many lives',
} as const;
