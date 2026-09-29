import { Position, Range, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import { pathToFileURL } from 'node:url';
import { DfNode, SourceUnit, nodeChainAt } from '@vscode-dataflex/parser';
import type { Range as DfRange } from '@vscode-dataflex/parser';
import type { SymbolIndex } from '@vscode-dataflex/workspace';
import { findLocal } from './navigation';
import { isWorkspaceOwnedFile } from '../analysis/workspaceFiles';
import { occurrencesIn, references } from './references';
import type { ReferenceOptions } from './references';

/**
 * Rename.
 *
 * DataFlex makes this more dangerous than in most languages: one flat namespace, no imports, and
 * names that repeat heavily -- `Refresh` is declared 23 times on a real search path and `psCaption`
 * eighteen. A rename that edits every occurrence of a common name would silently corrupt unrelated
 * code across a thousand files, and the edit is applied before anyone can read it.
 *
 * So the answer depends on what the name is:
 *
 *  - **A local, parameter or struct member** is renamed inside the method or struct that declares
 *    it, and nowhere else. This is the safe, common case: the scope is closed and knowable.
 *  - **A symbol the workspace declares** is renamed across the workspace, because the user owns
 *    every definition of it.
 *  - **Anything the library declares** is refused. Renaming `cWebForm` would edit thousands of call
 *    sites and none of the declarations, which are read-only.
 *  - **A name that is not declared at all** is refused, because there is nothing to be sure about.
 */

/** Why a rename cannot proceed, phrased for the user rather than the log. */
export interface RenameRefusal {
  reason: string;
}

export type RenameTarget =
  | { scope: 'local'; name: string; range: DfRange; within: DfRange }
  | { scope: 'workspace'; name: string; range: DfRange }
  | RenameRefusal;

/** A name DataFlex will accept: letters, digits, `_`, `$`, and an optional trailing `#`. */
const VALID_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*#?$/;

function isRefusal(target: RenameTarget): target is RenameRefusal {
  return 'reason' in target;
}

/**
 * Decides what a rename at this position would mean.
 *
 * Separated from performing it so the editor can refuse early -- `prepareRename` runs when the user
 * presses F2, before they have typed anything.
 */
export function renameTarget(
  unit: SourceUnit,
  word: { text: string; range: DfRange },
  index: SymbolIndex | undefined,
  options: { root?: string } = {}
): RenameTarget {
  const position = word.range.start;
  const chain = nodeChainAt(unit.root, position.line, position.character);

  // A local or parameter first: it shadows anything in the index, and its scope is closed.
  if (findLocal(chain, word.text) !== undefined) {
    const scope = enclosingScope(chain);
    if (scope === undefined) {
      return { reason: `'${word.text}' has no enclosing method to rename it within.` };
    }
    return { scope: 'local', name: word.text, range: word.range, within: scope };
  }

  if (index === undefined) {
    return { reason: 'The workspace is still being indexed.' };
  }

  const declarations = index.lookup(word.text);
  if (declarations.length === 0) {
    return { reason: `'${word.text}' is not declared anywhere in the workspace.` };
  }

  const root = options.root;
  if (root === undefined) {
    return { reason: 'No workspace is open.' };
  }

  // `isWorkspaceOwnedFile`, not a path prefix: a workspace materialises its dependencies into
  // `DfPkg/` beneath its own root, so a prefix test calls the whole Web UI library the user's own
  // code. It said `cWebForm` was renameable, which would have rewritten 2,277 call sites and left
  // the declaration -- inside a package -- untouched.
  const foreign = declarations.filter((entry) => !isWorkspaceOwnedFile(entry.file, root));
  if (foreign.length > 0) {
    const where = describeForeign(foreign[0]!.file);
    return {
      reason:
        `'${word.text}' is declared in ${where}, which this workspace does not own, so renaming ` +
        'it here would change the calls without changing the declaration.'
    };
  }

  return { scope: 'workspace', name: word.text, range: word.range };
}

/**
 * Where a declaration lives, said in a way that explains the refusal.
 *
 * The last two path segments are misleading here: the Web UI library's `cWebForm` sits in
 * `DfPkg/DataFlex_dev_Web_UI-1.0.52/AppSrc/cWebForm.pkg`, and showing `AppSrc/cWebForm.pkg` makes
 * it look like the user's own file. Naming the package is what tells them why it is off limits.
 */
function describeForeign(file: string): string {
  const parts = file.split(/[\\/]/);
  const at = parts.findIndex((part) => part.toLowerCase() === 'dfpkg');
  const packageName = parts[at + 1];
  if (at >= 0 && packageName !== undefined) {
    return `the package ${packageName}`;
  }
  return parts.slice(-2).join('/');
}

/** The method or struct a local belongs to, whose body bounds the rename. */
function enclosingScope(chain: readonly DfNode[]): DfRange | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i]!;
    if (node.kind === 'procedure' || node.kind === 'function' || node.kind === 'struct') {
      return node.range;
    }
  }
  return undefined;
}

function within(range: DfRange, outer: DfRange): boolean {
  const afterStart =
    range.start.line > outer.start.line ||
    (range.start.line === outer.start.line && range.start.character >= outer.start.character);
  const beforeEnd =
    range.end.line < outer.end.line ||
    (range.end.line === outer.end.line && range.end.character <= outer.end.character);
  return afterStart && beforeEnd;
}

/**
 * The edits a rename would make, or a refusal.
 *
 * `newName` is validated here rather than trusted: the editor accepts any string, and a name with
 * a space or a quote in it would produce source that does not compile.
 */
export function rename(
  unit: SourceUnit,
  word: { text: string; range: DfRange },
  newName: string,
  index: SymbolIndex | undefined,
  options: { root?: string; currentFile?: string; readFile?: ReferenceOptions['readFile'] } = {}
): WorkspaceEdit | RenameRefusal {
  if (!VALID_NAME.test(newName)) {
    return { reason: `'${newName}' is not a valid DataFlex name.` };
  }

  const target = renameTarget(unit, word, index, options);
  if (isRefusal(target)) {
    return target;
  }

  if (target.scope === 'local') {
    const edits: TextEdit[] = occurrencesIn(unit, target.name)
      .filter((range) => within(range, target.within))
      .map((range) => ({ range: range as Range, newText: newName }));
    const uri = options.currentFile === undefined ? undefined : pathToFileURL(options.currentFile).toString();
    return uri === undefined ? { reason: 'This document has no file on disk.' } : { changes: { [uri]: edits } };
  }

  const changes: Record<string, TextEdit[]> = {};
  for (const location of references(index, target.name, {
    includeDeclaration: true,
    readFile: options.readFile
  })) {
    (changes[location.uri] ??= []).push({ range: location.range, newText: newName });
  }
  return { changes };
}

/** The range the editor should offer for editing, or a refusal message. */
export function prepareRename(
  unit: SourceUnit,
  word: { text: string; range: DfRange },
  index: SymbolIndex | undefined,
  options: { root?: string } = {}
): { range: Range; placeholder: string } | RenameRefusal {
  const target = renameTarget(unit, word, index, options);
  if (isRefusal(target)) {
    return target;
  }
  return { range: target.range as Range, placeholder: target.name };
}

export type { Position };
