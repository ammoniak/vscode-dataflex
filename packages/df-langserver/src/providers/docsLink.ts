/**
 * Builds documentation links for docs.dataflex.dev.
 *
 * A wrong URL here is a hard 404, not a redirect or a search page, so this refuses rather than
 * guesses: nothing is linked unless the generated index says the page exists. The first attempt
 * derived the section from the declaring path instead, and auditing it against the live site found
 * it dead 57% of the time -- `Pkg` ships far more classes than the class reference documents.
 *
 * The same discipline is why members are looked up rather than constructed. `DataDictionary` is a
 * documented class and `Save` is one of its methods, but
 * `/VdfClassRef/WebAndWindows/DataDictionary-Procedure-Save/` is a 404 -- the site documents a
 * subset. Only the index knows which.
 *
 * No network call is ever made at hover time; the index is committed and this is string work.
 * Regenerate with `npm run docs-index`, then audit with `npm run docs-link-check`.
 *
 * Page shapes:
 *   https://docs.dataflex.dev/VdfClassRef/{Web|Windows|WebAndWindows}/{Class}/
 *   https://docs.dataflex.dev/VdfClassRef/{Platform}/{Class}-{Procedure|Function|Property|Event}-{Member}/
 *   https://docs.dataflex.dev/LanguageReference/{Stem}/
 */

import { docsIndex } from './docsIndex';

export const DEFAULT_DOCS_BASE_URL = 'https://docs.dataflex.dev';

export type DocsPlatform = 'Web' | 'Windows' | 'WebAndWindows';

/** A documentation page: where it is, and what it says, when the site told us. */
export interface DocsEntry {
  url: string;
  /** One-line summary from the documentation, when that page has one. */
  description?: string;
}

export interface DocsLinkInput {
  kind: string;
  name: string;
  /** Absolute path of the declaring file. */
  file: string;
  /** True when the file belongs to the user's workspace rather than the library. */
  workspaceOwned: boolean;
  /**
   * For a method or property, the class that declares it.
   *
   * Without this a member cannot be linked at all: the URL is keyed by class, and DataFlex's flat
   * namespace means a bare member name belongs to dozens of them.
   */
  ownerClass?: string;
  /** Empty or undefined disables linking entirely. */
  baseUrl?: string;
}

/**
 * Which section documents a class, or `undefined` when the documentation does not cover it.
 *
 * Answered from the generated index rather than from the class name or the declaring path. Both
 * of those were tried and both are wrong: `cDbTagsForm` and `Form` are Windows classes, so no
 * `cWeb*` rule works, and "declared in the installation" is far too generous -- `Pkg` also ships
 * COM wrappers, mixins and internal helpers that have no documentation page at all.
 */
export function docsPlatform(className: string): DocsPlatform | undefined {
  return docsIndex().classes[className.toLowerCase()];
}

/**
 * The casing the documentation site uses for a class.
 *
 * DataFlex source is case-insensitive, so `is a datadictionary` is legal and means the same class
 * as `DataDictionary`. MkDocs URLs are not, so the site's own spelling has to go into the link.
 */
function canonical(className: string): string | undefined {
  return docsIndex().names[className.toLowerCase()];
}

function base(baseUrl: string | undefined): string | undefined {
  const trimmed = (baseUrl ?? DEFAULT_DOCS_BASE_URL).replace(/\/+$/, '');
  return trimmed.length === 0 ? undefined : trimmed;
}

function entry(root: string, page: string): DocsEntry {
  const description = docsIndex().describe[page.toLowerCase()];
  return description === undefined ? { url: `${root}/${page}/` } : { url: `${root}/${page}/`, description };
}

/**
 * The documentation page for a declaration, or `undefined` when there is not one.
 *
 * The workspace-owned check applies to every kind: a user class or procedure that happens to
 * share a name with a framework one would otherwise link to somebody else's documentation.
 */
export function docsEntryFor(input: DocsLinkInput): DocsEntry | undefined {
  const root = base(input.baseUrl);
  if (root === undefined || input.workspaceOwned) {
    return undefined;
  }

  if (input.kind === 'class') {
    const platform = docsPlatform(input.name);
    const site = canonical(input.name);
    return platform === undefined || site === undefined
      ? undefined
      : entry(root, `VdfClassRef/${platform}/${site}`);
  }

  if (input.kind === 'procedure' || input.kind === 'function' || input.kind === 'property') {
    const owner = input.ownerClass;
    if (owner === undefined) {
      return undefined;
    }
    const platform = docsPlatform(owner);
    const site = canonical(owner);
    if (platform === undefined || site === undefined) {
      return undefined;
    }
    const members = docsIndex().members[owner.toLowerCase()];
    // The index preserves the site's casing for the member; ours comes from the source, which may
    // differ. Match case-insensitively, then use the site's spelling in the URL.
    const match = members === undefined ? undefined : findMember(members, input.name);
    if (match === undefined) {
      // The class is documented but this member is not. Falling back to the class page is better
      // than nothing: it is the page a reader would navigate to anyway.
      return entry(root, `VdfClassRef/${platform}/${site}`);
    }
    return entry(root, `VdfClassRef/${platform}/${site}-${match.kind}-${match.name}`);
  }

  return undefined;
}

function findMember(
  members: Record<string, string>,
  name: string
): { name: string; kind: string } | undefined {
  const direct = members[name];
  if (direct !== undefined) {
    return { name, kind: direct };
  }
  const key = name.toLowerCase();
  for (const [member, kind] of Object.entries(members)) {
    if (member.toLowerCase() === key) {
      return { name: member, kind };
    }
  }
  return undefined;
}

/**
 * The LanguageReference page for a command or built-in function.
 *
 * Looked up rather than derived: the stem is irregular (`Saverecord_Command` has a lower-case
 * `r`), the suffix varies in case, and one word can have several pages -- `If` is a command, a
 * function and a compiler directive. The generator picks the command page when there is one.
 *
 * The stored value is a whole page path, not a `LanguageReference` stem: `File_Field` and `Self`
 * are documented in the guides and have no reference page at all.
 */
export function docsEntryForCommand(word: string, baseUrl?: string): DocsEntry | undefined {
  const root = base(baseUrl);
  if (root === undefined) {
    return undefined;
  }
  const page = docsIndex().language[word.toLowerCase()];
  return page === undefined ? undefined : entry(root, page);
}

/**
 * Whether the documentation has a page for this exact member of this exact class.
 *
 * Distinct from `docsEntryFor` finding something: that falls back to the class page when the
 * member has none, which is the right answer for library code and the wrong one for the user's
 * own, where a class-level link would be about somebody else's class.
 */
export function documentsMember(ownerClass: string, name: string): boolean {
  const members = docsIndex().members[ownerClass.toLowerCase()];
  return members === undefined ? false : findMember(members, name) !== undefined;
}

/** The URL alone, for callers that only link. */
export function docsUrlFor(input: DocsLinkInput): string | undefined {
  return docsEntryFor(input)?.url;
}
