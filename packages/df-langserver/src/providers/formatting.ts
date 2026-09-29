import { Range, TextEdit } from 'vscode-languageserver';
import { DfNode, SourceUnit, walk } from '@vscode-dataflex/parser';

/**
 * Re-indents DataFlex source from the parse tree.
 *
 * Indentation only. Nothing is reflowed, no line is joined or split, no keyword is recased and no
 * blank line is added or removed -- a formatter that rewrites code is a formatter people turn off,
 * and this one has to survive a language whose block structure the parser models tolerantly rather
 * than perfectly.
 *
 * The tree decides the depth, not a regular expression. `language-configuration.json` already
 * carries indent rules for the editor's own auto-indent, and they are necessarily line-local: they
 * cannot tell that a `Procedure` inside an `Object` inside a `Composite` is three levels deep.
 *
 * **Nothing is emitted for a file the parser did not fully understand.** A file with `unknown`
 * nodes is one whose structure is partly guessed, and re-indenting from a guess moves working code
 * to the wrong depth. Formatting is the one feature where being silent is clearly better than
 * being approximately right.
 */

/** Kinds that indent what they contain. A `statement` never does; it has no body. */
const CONTAINERS: ReadonlySet<DfNode['kind']> = new Set([
  'object',
  'class',
  'procedure',
  'function',
  'struct',
  'enumList',
  'block',
  'caseArm',
  'command'
]);

export interface FormattingOptions {
  /** Spaces per level. DataFlex convention, and the repository's own sources, use four. */
  tabSize?: number;
  /** False writes a tab per level instead. */
  insertSpaces?: boolean;
}

/**
 * The indent depth every line of the document should have.
 *
 * A container's header sits at its own depth and its body one deeper; the closing line returns to
 * the header's depth. Lines the tree says nothing about -- blank lines, comments between
 * statements, macro bodies -- keep whatever depth the enclosing container gives them.
 */
export function indentDepths(unit: SourceUnit, lineCount: number): number[] {
  const depths = new Array<number>(lineCount).fill(0);

  const apply = (node: DfNode, depth: number): void => {
    if (!CONTAINERS.has(node.kind)) {
      return;
    }
    const first = node.range.start.line;
    const last = node.range.end.line;
    // Everything strictly inside the container is one deeper. The header and the closing line
    // stay at the container's own depth.
    for (let line = first + 1; line < last; line++) {
      if (line >= 0 && line < depths.length) {
        depths[line] = depth + 1;
      }
    }
  };

  walk(unit.root, (node, parents) => {
    const depth = parents.filter((parent) => CONTAINERS.has(parent.kind)).length;
    apply(node, depth);
    return undefined;
  });

  return depths;
}

/** True when the parser left something it could not classify. */
export function hasUnknown(unit: SourceUnit): boolean {
  let found = false;
  walk(unit.root, (node) => {
    if (node.kind === 'unknown') {
      found = true;
      return false;
    }
    return undefined;
  });
  return found;
}

/**
 * Edits that re-indent the document, or nothing.
 *
 * One edit per line that is actually wrong, rather than a single whole-document replacement: a
 * narrow edit keeps the cursor, the selection and the undo history where the user left them, and
 * it makes the diff readable when they review it.
 */
export function formatting(
  unit: SourceUnit,
  text: string,
  options: FormattingOptions = {}
): TextEdit[] {
  if (hasUnknown(unit)) {
    return [];
  }

  const size = options.tabSize ?? 4;
  const useSpaces = options.insertSpaces !== false;
  const unit_ = useSpaces ? ' '.repeat(size) : '\t';

  const lines = text.split('\n');
  const depths = indentDepths(unit, lines.length);
  const edits: TextEdit[] = [];

  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line]!;
    // Trailing `\r` belongs to the line ending, not the content.
    const content = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    // A blank line has no indentation to correct, and adding some would leave trailing whitespace.
    if (content.trim().length === 0) {
      continue;
    }

    const existing = /^[ \t]*/.exec(content)?.[0] ?? '';
    const wanted = unit_.repeat(depths[line] ?? 0);
    if (existing === wanted) {
      continue;
    }

    const range: Range = {
      start: { line, character: 0 },
      end: { line, character: existing.length }
    };
    edits.push({ range, newText: wanted });
  }

  return edits;
}
