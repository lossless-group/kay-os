/**
 * Markdown bodies for changelog and context-v pages, through LFM.
 *
 * The local loader stores each file's raw body (no pre-rendered HTML), so
 * pages parse it here with @lossless-group/lfm and render the MDAST tree via
 * components/markdown/AstroMarkdown.astro.
 *
 * Wikilinks (`[[Name]]`, `[[path/Name.md]]`, `[[Name|label]]`) are resolved
 * before parsing: a context-v doc on this site links to its page; any other
 * path links to the file on GitHub; a bare name with no match stays as text.
 */
import { getCollection } from 'astro:content';
import { parseMarkdown } from '@lossless-group/lfm';
import { REPO_URL } from './seo';

let contextIndex: Map<string, string> | null = null;

async function contextV(): Promise<Map<string, string>> {
  if (contextIndex) return contextIndex;
  const entries = await getCollection('context-v').catch(() => []);
  contextIndex = new Map();
  for (const e of entries) {
    if (e.data.publish === false) continue;
    const base = e.id.split('/').pop()!.toLowerCase();
    contextIndex.set(base, e.id);
    contextIndex.set(e.id.toLowerCase(), e.id);
  }
  return contextIndex;
}

export async function resolveWikilinks(body: string): Promise<string> {
  const idx = await contextV();
  const site = import.meta.env.BASE_URL;
  return body.replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_m, rawTarget: string, alias?: string) => {
    const target = rawTarget.trim().replace(/^\.\.\//, '').replace(/^\.\//, '');
    const noExt = target.replace(/\.md$/i, '');
    const name = noExt.split('/').pop()!;
    const label = (alias ?? name).trim();
    const id = idx.get(noExt.replace(/^context-v\//, '').toLowerCase()) ?? idx.get(name.toLowerCase());
    if (id) return `[${label}](${site}context-v/${id}/)`;
    if (target.includes('/')) return `[${label}](${REPO_URL}/blob/main/${target})`;
    return label;
  });
}

export async function renderable(body: string | undefined) {
  // The page header already shows the title, so drop a leading `# Title`.
  const text = (body ?? '').replace(/^\s*#\s+[^\n]*\n/, '');
  const tree = await parseMarkdown(await resolveWikilinks(text));
  const citations = ((tree as any)?.data?.citations?.ordered ?? []) as any[];
  return { tree, citations };
}
