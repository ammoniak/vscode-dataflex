/**
 * Regenerates the documentation index from docs.dataflex.dev.
 *
 * Run by hand with `npm run docs-index`; the result is committed. No network call is ever made at
 * hover time.
 *
 * Two sources, with very different standing:
 *
 * 1. `sitemap.xml` on the production host is **authoritative** for which pages exist. Nothing is
 *    ever linked unless it appears here. This matters more than it sounds: the URLs cannot be
 *    constructed by rule -- the command page for `SaveRecord` is `Saverecord_Command` with a
 *    lower-case `r`, both `_Command` and `_command` suffixes occur, and
 *    `DataDictionary-Procedure-Save` is a 404 even though `DataDictionary` is a documented class
 *    and `Save` is one of its methods. An earlier version derived URLs from the declaring path and
 *    was dead 57% of the time.
 *
 * 2. `search/search_index.json` on the **test** host supplies the one-line descriptions. The
 *    production host serves that file with an empty `docs` array, so there is no choice about
 *    which host to ask. It is treated as optional for exactly that reason: if it disappears or
 *    empties, this still writes a valid index and the hovers fall back to a bare link.
 *
 * The previous implementation scraped two seed pages and walked the MkDocs nav, because the
 * sitemap was believed to cover only the guides. That is no longer true -- it carries all 16k
 * class-reference pages -- and scraping missed the whole `WebAndWindows` section, 65 classes
 * including `DataDictionary`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SITEMAP = 'https://docs.dataflex.dev/sitemap.xml';
const SEARCH_INDEX = 'https://test.docs.dataflex.dev/search/search_index.json';
const OUT = join(__dirname, '..', 'packages', 'df-langserver', 'src', 'providers', 'docsIndex.ts');

/** Refuse to overwrite the committed index with a smaller one; the site markup may have moved. */
const MIN_CLASSES = 600;

type Platform = 'Web' | 'Windows' | 'WebAndWindows';
type MemberKind = 'Procedure' | 'Function' | 'Property' | 'Event';

const CLASS_PAGE = /^https:\/\/docs\.dataflex\.dev\/VdfClassRef\/(Web|Windows|WebAndWindows)\/([^/-]+)\/$/;
const MEMBER_PAGE =
  /^https:\/\/docs\.dataflex\.dev\/VdfClassRef\/(Web|Windows|WebAndWindows)\/(.+?)-(Procedure|Function|Property|Event)-(.+?)\/$/;
const LANGUAGE_PAGE = /^https:\/\/docs\.dataflex\.dev\/LanguageReference\/([^/]+)\/$/;

/**
 * `The <Word> Keyword` pages in the guides.
 *
 * A few keywords are documented only here and never in the language reference: `File_Field` and
 * `Self` are both real, hoverable words with no `LanguageReference` page at all. There are exactly
 * three such pages site-wide, so this is a narrow, exact rule rather than an attempt to mine the
 * guides -- guide prose is not a keyword reference, and treating it as one would invent entries.
 */
const KEYWORD_GUIDE_PAGE =
  /^https:\/\/docs\.dataflex\.dev\/(DevelopmentGuide|LanguageGuide)\/The_(.+)_Keyword\/$/;

/**
 * The word a `LanguageReference` page documents.
 *
 * `Save_Command` documents `Save`; `Abs_Function` documents `Abs`. The suffix also disambiguates:
 * `If_Command`, `If_Function` and `IF_Compiler_Directive` are three different pages, and a
 * statement verb wants the command one.
 */
const LANGUAGE_SUFFIX = /_(command|function|compiler_directive|operator|predefined_variable|attributes?|field_property|comparison_mode|predefined_indicator)$/i;

/** Suffix ranking, so `Save` prefers `Save_Command` over any other page spelling the same word. */
const SUFFIX_RANK = ['command', 'function'];

function rank(stem: string): number {
  const match = LANGUAGE_SUFFIX.exec(stem);
  const suffix = match?.[1]?.toLowerCase() ?? '';
  const at = SUFFIX_RANK.indexOf(suffix);
  return at < 0 ? SUFFIX_RANK.length : at;
}

async function text(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return response.text();
}

interface Index {
  classes: Record<string, Platform>;
  names: Record<string, string>;
  members: Record<string, Record<string, MemberKind>>;
  language: Record<string, string>;
  describe: Record<string, string>;
}

async function readSitemap(): Promise<Index> {
  const xml = await text(SITEMAP);
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
  console.log(`sitemap       : ${urls.length} urls`);

  const index: Index = { classes: {}, names: {}, members: {}, language: {}, describe: {} };
  const guideKeywords = new Map<string, string>();

  for (const url of urls) {
    const asClass = CLASS_PAGE.exec(url);
    if (asClass !== null) {
      index.classes[asClass[2]!.toLowerCase()] = asClass[1]! as Platform;
      index.names[asClass[2]!.toLowerCase()] = asClass[2]!;
      continue;
    }
    const asMember = MEMBER_PAGE.exec(url);
    if (asMember !== null) {
      const owner = asMember[2]!.toLowerCase();
      (index.members[owner] ??= {})[asMember[4]!] = asMember[3]! as MemberKind;
      continue;
    }
    const asKeywordGuide = KEYWORD_GUIDE_PAGE.exec(url);
    if (asKeywordGuide !== null) {
      // The reference wins where both exist: `Field` is documented in both, and the reference page
      // is the one that states the syntax.
      const word = asKeywordGuide[2]!.toLowerCase();
      guideKeywords.set(word, `${asKeywordGuide[1]}/The_${asKeywordGuide[2]}_Keyword`);
      continue;
    }

    const asLanguage = LANGUAGE_PAGE.exec(url);
    if (asLanguage !== null) {
      const stem = asLanguage[1]!;
      const word = stem.replace(LANGUAGE_SUFFIX, '').toLowerCase();
      const existing = index.language[word];
      if (existing === undefined || rank(stem) < rank(existing.replace('LanguageReference/', ''))) {
        index.language[word] = `LanguageReference/${stem}`;
      }
    }
  }

  for (const [word, page] of guideKeywords) {
    index.language[word] ??= page;
  }
  return index;
}

/** Strips HTML and collapses whitespace; the search index stores rendered markup. */
function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First sentence, capped. Long enough to be an answer, short enough not to own the hover. */
function summarise(body: string): string {
  const first = body.split(/(?<=[.!?])\s/)[0] ?? '';
  return first.length > 200 ? `${first.slice(0, 197).trimEnd()}...` : first;
}

/**
 * Class pages open with the page's own navigation crumb rendered as text.
 *
 * `DataDictionary` reads "Properties | Events | Methods | Index of Classes This class provides..."
 * -- the sentence starts after the crumb, so it has to come off before the first sentence is taken.
 */
const CRUMB = /^(Properties|Events|Methods|Index of Classes|Overview|\|)[\s|]*/i;

function stripCrumbs(body: string): string {
  let out = body;
  for (let guard = 0; guard < 8; guard++) {
    const next = out.replace(CRUMB, '');
    if (next === out) {
      break;
    }
    out = next;
  }
  return out;
}

async function addDescriptions(index: Index): Promise<void> {
  let raw: string;
  try {
    raw = await text(SEARCH_INDEX);
  } catch (error) {
    console.warn(`descriptions  : SKIPPED (${String(error)})`);
    return;
  }

  const docs = (JSON.parse(raw) as { docs?: { location: string; text?: string }[] }).docs ?? [];
  if (docs.length === 0) {
    console.warn('descriptions  : SKIPPED (search index served no documents)');
    return;
  }

  // location is `<page>/#<anchor>`; group the anchors back under their page.
  const pages = new Map<string, Map<string, string>>();
  for (const entry of docs) {
    const [base, anchor = ''] = entry.location.split('#');
    const key = (base ?? '').replace(/\/$/, '');
    const anchors = pages.get(key) ?? new Map<string, string>();
    anchors.set(anchor, plain(entry.text ?? ''));
    pages.set(key, anchors);
  }

  const want = new Set<string>();
  for (const [name, platform] of Object.entries(index.classes)) {
    want.add(`VdfClassRef/${platform}/${name}`);
  }
  for (const [owner, members] of Object.entries(index.members)) {
    const platform = index.classes[owner];
    for (const [member, kind] of Object.entries(members)) {
      if (platform !== undefined) {
        want.add(`VdfClassRef/${platform}/${owner}-${kind}-${member}`);
      }
    }
  }
  for (const page of Object.values(index.language)) {
    want.add(page);
  }

  // The sitemap preserves class casing; the search index keys are the same strings, so match
  // case-insensitively rather than trying to reproduce the casing on both sides.
  const byLower = new Map<string, Map<string, string>>();
  for (const [key, anchors] of pages) {
    byLower.set(key.toLowerCase(), anchors);
  }

  let found = 0;
  for (const page of want) {
    const anchors = byLower.get(page.toLowerCase());
    if (anchors === undefined) {
      continue;
    }
    let body: string;
    if (page.startsWith('LanguageReference/')) {
      body = anchors.get('purpose') ?? '';
    } else if (page.startsWith('DevelopmentGuide/') || page.startsWith('LanguageGuide/')) {
      // A guide page has no `Purpose` section; its opening prose is the summary.
      body = [...anchors].map(([, value]) => value).find((value) => value.length > 0) ?? '';
    } else {
      // A member page's description lives under its own slug anchor; the class page under any
      // section that carries prose. `syntax` and `call-example` are code, not description.
      body =
        [...anchors]
          .filter(([anchor]) => anchor !== 'syntax' && anchor !== 'call-example')
          .map(([, value]) => value)
          .find((value) => value.length > 0) ?? '';
      body = body.split(/\s*Type:\s*(?:Procedure|Function|Property|Event)/)[0] ?? body;
    }
    const summary = summarise(stripCrumbs(body));
    if (summary.length > 0) {
      // Keyed lower-case: the caller builds this path from source text, whose casing is the
      // author's, while the site has its own. DataFlex is case-insensitive, so neither is "right".
      index.describe[page.toLowerCase()] = summary;
      found++;
    }
  }
  console.log(`descriptions  : ${found} of ${want.size} pages (${Math.round((found / want.size) * 100)}%)`);
}

async function main(): Promise<void> {
  const index = await readSitemap();

  const classCount = Object.keys(index.classes).length;
  if (classCount < MIN_CLASSES) {
    console.error(`only ${classCount} classes found (expected >= ${MIN_CLASSES}); refusing to write.`);
    process.exit(1);
  }

  await addDescriptions(index);

  const memberCount = Object.values(index.members).reduce((sum, m) => sum + Object.keys(m).length, 0);
  const byPlatform = new Map<string, number>();
  for (const platform of Object.values(index.classes)) {
    byPlatform.set(platform, (byPlatform.get(platform) ?? 0) + 1);
  }

  const banner = `/**
 * GENERATED by \`npm run docs-index\` (scripts/fetch-docs-index.ts) -- do not edit by hand.
 *
 * Built from the production sitemap, which decides which pages exist, plus the test host's search
 * index, which supplies the descriptions. See the script for why each source is used.
 *
 * Stored as a JSON string rather than an object literal: it parses several times faster, and it
 * keeps this file's diff to one line per regeneration instead of tens of thousands.
 */
`;

  const payload = JSON.stringify(index);
  writeFileSync(
    OUT,
    `${banner}
export interface DocsIndex {
  /** Lower-cased class name to the section documenting it. */
  classes: Record<string, 'Web' | 'Windows' | 'WebAndWindows'>;
  /**
   * Lower-cased class name to the casing the site uses in its URL.
   *
   * DataFlex source is case-insensitive, so \`is a datadictionary\` is legal and means the same
   * class as \`DataDictionary\`. MkDocs URLs are not, so the site's spelling has to go into the link.
   */
  names: Record<string, string>;
  /** Lower-cased class name to its documented members, and what kind each one is. */
  members: Record<string, Record<string, 'Procedure' | 'Function' | 'Property' | 'Event'>>;
  /**
   * Lower-cased keyword to the page path documenting it.
   *
   * A whole path rather than a \`LanguageReference\` stem: a couple of keywords are documented in
   * the guides instead -- \`File_Field\` and \`Self\` have no reference page at all.
   */
  language: Record<string, string>;
  /** Lower-cased page path to a one-line summary. Best-effort; many pages have none. */
  describe: Record<string, string>;
}

const RAW = ${JSON.stringify(payload)};

let parsed: DocsIndex | undefined;

/** The index, parsed on first use. */
export function docsIndex(): DocsIndex {
  parsed ??= JSON.parse(RAW) as DocsIndex;
  return parsed;
}
`,
    'utf8'
  );

  console.log(`classes       : ${classCount} (${[...byPlatform].map(([p, n]) => `${p} ${n}`).join(', ')})`);
  console.log(`members       : ${memberCount} across ${Object.keys(index.members).length} classes`);
  console.log(`language      : ${Object.keys(index.language).length} words`);
  console.log(`wrote ${OUT} (${Math.round(payload.length / 1024)} KB of data)`);
}

void main();
