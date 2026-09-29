import {
  CodeAction,
  CodeActionKind,
  Diagnostic,
  Range,
  TextEdit,
  WorkspaceEdit
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DIAGNOSTIC_SOURCE } from '../analysis/analyze';

/**
 * Quick fixes for the analysis rules.
 *
 * Every rule gets a suppression, because every rule is sometimes wrong about intent and the
 * alternative is turning the rule off workspace-wide. Only two rules get a real fix, and the
 * restraint is the point: an automated edit that changes behaviour is worse than no fix at all.
 *
 *  - `unused-parameter` cannot drop the parameter -- an event override must keep the signature the
 *    framework calls it with.
 *  - `unreachable-code` cannot delete the statements: they are usually a clue to a bug, not litter.
 *  - `dead-procedure` cannot delete the method, since the rule's own premise is that DataFlex
 *    dispatches dynamically and the call may be a string.
 *  - `argument-count` cannot invent an argument.
 */

/** The comment the analyser looks for, on the finding's line or the one above it. */
export function suppressionComment(rule: string): string {
  return `// df-ignore:${rule}`;
}

/** The whitespace a line starts with, so an inserted line lines up with the code it guards. */
function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

function lineAt(document: TextDocument, line: number): string {
  return document.getText({
    start: { line, character: 0 },
    end: { line, character: Number.MAX_SAFE_INTEGER }
  });
}

function edit(document: TextDocument, edits: TextEdit[]): WorkspaceEdit {
  return { changes: { [document.uri]: edits } };
}

/**
 * Inserts `// df-ignore:<rule>` on its own line above the finding.
 *
 * Above rather than appended, because appending has to reason about what is already at the end of
 * the line -- a trailing comment, a line continuation -- and getting that wrong changes the code.
 * A new line is always valid.
 */
function suppress(document: TextDocument, diagnostic: Diagnostic, rule: string): CodeAction {
  const line = diagnostic.range.start.line;
  const indent = indentOf(lineAt(document, line));
  return {
    title: `Suppress ${rule} on this line`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    edit: edit(document, [
      {
        range: { start: { line, character: 0 }, end: { line, character: 0 } },
        newText: `${indent}${suppressionComment(rule)}\n`
      }
    ])
  };
}

/**
 * Deletes the whole line a declaration sits on.
 *
 * Offered only when the line declares exactly that one name. `String sA sB` declares two, and
 * removing the line would delete a variable the rule never complained about.
 */
function removeDeclarationLine(
  document: TextDocument,
  diagnostic: Diagnostic,
  name: string
): CodeAction | undefined {
  const line = diagnostic.range.start.line;
  const text = lineAt(document, line);

  // Everything before a trailing comment, which is what actually declares.
  const code = text.split('//')[0] ?? '';
  const words = code.trim().split(/\s+/).filter((word) => word.length > 0);
  // `<Type> <Name>`, or `Global_Variable <Type> <Name>`: a type and exactly one name.
  const declaresOnlyThis =
    words.length >= 2 &&
    words[words.length - 1]?.toLowerCase() === name.toLowerCase() &&
    words.filter((word) => word.toLowerCase() === name.toLowerCase()).length === 1;
  if (!declaresOnlyThis) {
    return undefined;
  }

  const range: Range = {
    start: { line, character: 0 },
    end: { line: line + 1, character: 0 }
  };
  return {
    title: `Remove unused '${name}'`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    edit: edit(document, [{ range, newText: '' }])
  };
}

/**
 * Rewrites a declaration outside any method as `Global_Variable`.
 *
 * This is the rule's own recommendation: the variable is already global, and saying so makes the
 * intent explicit rather than changing what the code does.
 */
function makeGlobal(document: TextDocument, diagnostic: Diagnostic): CodeAction | undefined {
  const line = diagnostic.range.start.line;
  const text = lineAt(document, line);
  const indent = indentOf(text);
  const body = text.slice(indent.length);
  if (/^global_variable\b/i.test(body)) {
    return undefined;
  }
  return {
    title: 'Declare as Global_Variable',
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    edit: edit(document, [
      {
        range: {
          start: { line, character: indent.length },
          end: { line, character: indent.length }
        },
        newText: 'Global_Variable '
      }
    ])
  };
}

/** The name a finding is about, taken from the range the diagnostic points at. */
function nameOf(document: TextDocument, diagnostic: Diagnostic): string {
  return document.getText(diagnostic.range);
}

/**
 * Quick fixes for the diagnostics the editor passes in.
 *
 * Only this server's own diagnostics are considered: the request carries whatever else is on the
 * line, including another extension's.
 */
export function codeActions(document: TextDocument, diagnostics: readonly Diagnostic[]): CodeAction[] {
  const actions: CodeAction[] = [];

  for (const diagnostic of diagnostics) {
    if (diagnostic.source !== DIAGNOSTIC_SOURCE || typeof diagnostic.code !== 'string') {
      continue;
    }
    const rule = diagnostic.code;

    if (rule === 'unused-local') {
      const remove = removeDeclarationLine(document, diagnostic, nameOf(document, diagnostic));
      if (remove !== undefined) {
        actions.push(remove);
      }
    }
    if (rule === 'implicit-global') {
      const global = makeGlobal(document, diagnostic);
      if (global !== undefined) {
        actions.push(global);
      }
    }

    actions.push(suppress(document, diagnostic, rule));
  }

  return actions;
}
