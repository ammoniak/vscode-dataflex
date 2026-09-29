import { Location, Position, DocumentHighlight, DocumentHighlightKind } from 'vscode-languageserver';
import { pathToFileURL } from 'node:url';
import { SourceUnit, TokenKind, parseSource } from '@vscode-dataflex/parser';
import type { SymbolIndex } from '@vscode-dataflex/workspace';
import { readSourceFile } from '@vscode-dataflex/workspace';
import type { Range as DfRange } from '@vscode-dataflex/parser';

/**
 * Find All References, and its single-file sibling, Document Highlight.
 *
 * The index deliberately stores reference *counts* rather than positions -- it exists to answer
 * "is this name used anywhere", which the dead-code rule asks 18,000 times and which would cost a
 * great deal of memory to answer with positions. So the positions are found on demand.
 *
 * What makes that affordable is the same per-file tally: it names the handful of files containing
 * the word, and only those are re-read. On a real workspace a name lives in a few dozen of a
 * thousand files, so the search skips 97% of them without opening anything.
 *
 * Matching is by token, never by text search. `Move sName to sNameAdditional` contains the string
 * `sName` twice but references it once, and a comment mentioning it references it not at all.
 */

/**
 * Occurrences of `name` in one already-parsed unit.
 *
 * A dotted token counts if any of its segments matches: `Customer.Name` is a reference to the
 * table `Customer` and to the field `Name`, and the index counts it as both, so the search has to
 * agree or the count and the list would contradict each other.
 */
export function occurrencesIn(unit: SourceUnit, name: string): DfRange[] {
  const key = name.toLowerCase();
  const found: DfRange[] = [];

  for (const token of unit.tokens) {
    if (token.kind !== TokenKind.Identifier) {
      continue;
    }
    const text = token.text.toLowerCase();
    if (text === key) {
      found.push(token.range);
      continue;
    }
    if (!text.includes('.')) {
      continue;
    }
    // A dotted name: report the segment, not the whole token, so the highlight covers the word
    // the cursor is on rather than `Customer.Name` entire.
    let offset = 0;
    for (const part of token.text.split('.')) {
      if (part.toLowerCase() === key) {
        found.push({
          start: {
            line: token.range.start.line,
            character: token.range.start.character + offset
          },
          end: {
            line: token.range.start.line,
            character: token.range.start.character + offset + part.length
          }
        });
      }
      offset += part.length + 1;
    }
  }

  return found;
}

/**
 * Every occurrence of the name across the workspace.
 *
 * `declarations` are folded in from the index rather than found by scanning, because a declaration
 * is an occurrence the token scan would find anyway -- deduplicating is cheaper than special-casing
 * it, and `includeDeclaration: false` then simply filters them back out.
 */
export interface ReferenceOptions {
  includeDeclaration: boolean;
  /**
   * Source for a file's current text.
   *
   * Defaults to reading from disk. The server overrides it so that files open with unsaved
   * changes are searched as they appear on screen -- otherwise a reference the user just typed in
   * another tab is missing from the list, which is worse than slow.
   */
  readFile?: (file: string) => string | undefined;
}

export function references(
  index: SymbolIndex | undefined,
  name: string,
  options: ReferenceOptions
): Location[] {
  if (index === undefined || name.length === 0) {
    return [];
  }

  const declarationKeys = new Set(
    index
      .lookup(name)
      .map((entry) => `${entry.file.toLowerCase()}:${entry.nameRange.start.line}:${entry.nameRange.start.character}`)
  );

  // Every candidate file, with no cap. A cap here truncated silently: `psCaption` lives in 499
  // files on a real workspace and a 400-file limit reported 4,731 of its 5,208 uses while looking
  // exactly like a complete answer. The per-file tally is already the bound that matters -- it
  // skips ~70% of the workspace -- and this is an explicit user action, not a keystroke.
  const files = index.filesReferencing(name);
  const locations: Location[] = [];

  const read = options.readFile ?? readSourceFile;

  for (const file of files) {
    const text = read(file);
    if (text === undefined) {
      continue;
    }
    let unit: SourceUnit;
    try {
      unit = parseSource(text, { uri: file });
    } catch {
      // One unparseable file must not lose the references in all the others.
      continue;
    }

    for (const range of occurrencesIn(unit, name)) {
      const key = `${file.toLowerCase()}:${range.start.line}:${range.start.character}`;
      if (!options.includeDeclaration && declarationKeys.has(key)) {
        continue;
      }
      locations.push({ uri: pathToFileURL(file).toString(), range });
    }
  }

  return locations;
}

/**
 * Occurrences within the current document, for the editor's word highlight.
 *
 * Separate from `references` because it must not touch the disk: this fires on every cursor move.
 */
export function documentHighlights(
  unit: SourceUnit,
  name: string,
  declarationRanges: readonly DfRange[] = []
): DocumentHighlight[] {
  const declared = new Set(
    declarationRanges.map((range) => `${range.start.line}:${range.start.character}`)
  );
  return occurrencesIn(unit, name).map((range) => ({
    range,
    kind: declared.has(`${range.start.line}:${range.start.character}`)
      ? DocumentHighlightKind.Write
      : DocumentHighlightKind.Read
  }));
}

/** Where the cursor is, as the providers above want it: the plain word, undotted. */
export type { Position };
