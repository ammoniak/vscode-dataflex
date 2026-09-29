import { describe, expect, it } from 'vitest';
import { CodeActionKind, Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { codeActions } from '../src/providers/codeActions';
import { DIAGNOSTIC_SOURCE, analyze } from '../src/analysis/analyze';
import { parseSource } from '@vscode-dataflex/parser';

/**
 * Quick fixes for the analysis rules.
 *
 * Every rule gets a suppression; only two get a real edit. The restraint is deliberate -- an
 * automated fix that changes behaviour is worse than no fix, and most of these rules report a
 * judgement the author may have made on purpose.
 */

const URI = 'file:///c%3A/ws/x.pkg';

function doc(lines: string[]): TextDocument {
  return TextDocument.create(URI, 'dataflex', 1, lines.join('\n'));
}

/** A diagnostic of `rule` covering `name` on `line`. */
function finding(document: TextDocument, line: number, name: string, rule: string): Diagnostic {
  const text = document.getText({
    start: { line, character: 0 },
    end: { line, character: Number.MAX_SAFE_INTEGER }
  });
  const character = text.indexOf(name);
  return {
    range: {
      start: { line, character },
      end: { line, character: character + name.length }
    },
    message: `'${name}' is never used`,
    severity: DiagnosticSeverity.Hint,
    source: DIAGNOSTIC_SOURCE,
    code: rule
  };
}

/** Applies a single-file edit, so the assertions are about resulting text, not edit structs. */
function apply(document: TextDocument, action: { edit?: { changes?: Record<string, unknown> } }): string {
  const edits = (action.edit?.changes?.[URI] ?? []) as {
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    newText: string;
  }[];
  return TextDocument.applyEdits(document, edits);
}

describe('suppression', () => {
  const LINES = ['Procedure DoIt', '    String sUnused', 'End_Procedure', ''];

  it('is offered for every rule', () => {
    const document = doc(LINES);
    for (const rule of [
      'unused-local',
      'unreachable-code',
      'duplicate-declaration',
      'unused-parameter',
      'dead-procedure',
      'argument-count',
      'implicit-global'
    ]) {
      const actions = codeActions(document, [finding(document, 1, 'sUnused', rule)]);
      expect(actions.some((a) => a.title === `Suppress ${rule} on this line`)).toBe(true);
    }
  });

  it('inserts the comment the analyser actually looks for', () => {
    const document = doc(LINES);
    const [action] = codeActions(document, [finding(document, 1, 'sUnused', 'unused-local')]).filter(
      (a) => a.title.startsWith('Suppress')
    );
    expect(apply(document, action!)).toContain('// df-ignore:unused-local');
  });

  /** A line that does not line up with the code it guards reads as stray. */
  it('indents the comment to match the line it guards', () => {
    const document = doc(LINES);
    const [action] = codeActions(document, [finding(document, 1, 'sUnused', 'unused-local')]).filter(
      (a) => a.title.startsWith('Suppress')
    );
    expect(apply(document, action!)).toContain('    // df-ignore:unused-local\n    String sUnused');
  });

  it('is a quick fix, attached to the diagnostic it answers', () => {
    const document = doc(LINES);
    const diagnostic = finding(document, 1, 'sUnused', 'unused-local');
    const [action] = codeActions(document, [diagnostic]).filter((a) => a.title.startsWith('Suppress'));
    expect(action!.kind).toBe(CodeActionKind.QuickFix);
    expect(action!.diagnostics).toEqual([diagnostic]);
  });
});

describe('removing an unused local', () => {
  it('deletes the whole declaration line', () => {
    const document = doc(['Procedure DoIt', '    String sUnused', '    Showln "x"', 'End_Procedure', '']);
    const [action] = codeActions(document, [finding(document, 1, 'sUnused', 'unused-local')]).filter(
      (a) => a.title.startsWith('Remove')
    );
    expect(action!.title).toBe("Remove unused 'sUnused'");
    expect(apply(document, action!)).toBe(
      ['Procedure DoIt', '    Showln "x"', 'End_Procedure', ''].join('\n')
    );
  });

  /**
   * `String sA sB` declares two names on one line. Deleting the line would remove `sB`, which the
   * rule never complained about.
   */
  it('is not offered when the line declares more than one name', () => {
    const document = doc(['Procedure DoIt', '    String sUnused sOther', 'End_Procedure', '']);
    const actions = codeActions(document, [finding(document, 1, 'sUnused', 'unused-local')]);
    expect(actions.some((a) => a.title.startsWith('Remove'))).toBe(false);
    // The suppression is still there, so the finding is not left without any answer.
    expect(actions.some((a) => a.title.startsWith('Suppress'))).toBe(true);
  });

  it('is offered for a declaration carrying a trailing comment', () => {
    const document = doc(['Procedure DoIt', '    String sUnused // why', 'End_Procedure', '']);
    expect(
      codeActions(document, [finding(document, 1, 'sUnused', 'unused-local')]).some((a) =>
        a.title.startsWith('Remove')
      )
    ).toBe(true);
  });

  it('is not offered for other rules', () => {
    const document = doc(['Procedure DoIt', '    String sUnused', 'End_Procedure', '']);
    expect(
      codeActions(document, [finding(document, 1, 'sUnused', 'unused-parameter')]).some((a) =>
        a.title.startsWith('Remove')
      )
    ).toBe(false);
  });
});

describe('implicit-global', () => {
  /** The rule's own recommendation: say what the code already does, do not change it. */
  it('adds the Global_Variable keyword', () => {
    const document = doc(['String sStartView', '']);
    const [action] = codeActions(document, [finding(document, 0, 'sStartView', 'implicit-global')]).filter(
      (a) => a.title === 'Declare as Global_Variable'
    );
    expect(apply(document, action!)).toBe(['Global_Variable String sStartView', ''].join('\n'));
  });

  it('keeps the indentation', () => {
    const document = doc(['    String sStartView', '']);
    const [action] = codeActions(document, [finding(document, 0, 'sStartView', 'implicit-global')]).filter(
      (a) => a.title === 'Declare as Global_Variable'
    );
    expect(apply(document, action!)).toBe(['    Global_Variable String sStartView', ''].join('\n'));
  });

  it('is not offered when the declaration already says Global_Variable', () => {
    const document = doc(['Global_Variable String sStartView', '']);
    expect(
      codeActions(document, [finding(document, 0, 'sStartView', 'implicit-global')]).some(
        (a) => a.title === 'Declare as Global_Variable'
      )
    ).toBe(false);
  });
});

describe('what is deliberately not fixed', () => {
  const document = doc(['Procedure OnClick String sRowId', 'End_Procedure', '']);

  /**
   * An event override must keep the signature the framework calls it with, so the parameter
   * cannot be removed; unreachable code is usually a clue to a bug rather than litter; a dead
   * procedure may be reached by a name built at runtime; and no fix can invent an argument.
   */
  it('offers only a suppression for the rules with no safe edit', () => {
    for (const rule of ['unused-parameter', 'unreachable-code', 'dead-procedure', 'argument-count']) {
      const actions = codeActions(document, [finding(document, 0, 'sRowId', rule)]);
      expect(actions).toHaveLength(1);
      expect(actions[0]!.title).toBe(`Suppress ${rule} on this line`);
    }
  });
});

describe('diagnostics from elsewhere', () => {
  const document = doc(['Procedure DoIt', '    String sUnused', 'End_Procedure', '']);

  it('ignores another extension s diagnostics', () => {
    const foreign = { ...finding(document, 1, 'sUnused', 'unused-local'), source: 'eslint' };
    expect(codeActions(document, [foreign])).toEqual([]);
  });

  it('ignores a diagnostic with no rule code', () => {
    const { code, ...rest } = finding(document, 1, 'sUnused', 'unused-local');
    expect(codeActions(document, [rest])).toEqual([]);
  });

  it('answers nothing when there are no diagnostics', () => {
    expect(codeActions(document, [])).toEqual([]);
  });
});

/**
 * The round trip: apply the fix, re-analyse, and the finding is gone.
 *
 * This is the assertion that matters. The suppression comment and the analyser's pattern for it
 * are written in two different files, and a test that only checks the inserted text would pass
 * happily while the analyser ignored it.
 */
describe('applying a suppression silences the finding', () => {
  const LINES = ['Procedure DoIt', '    String sUnused', '    Showln "x"', 'End_Procedure', ''];

  function findingsFor(text: string): string[] {
    const unit = parseSource(text, { uri: 'C:\\ws\\x.pkg' });
    return analyze(unit).map((d) => String(d.code));
  }

  it('reports unused-local before the fix and nothing after it', () => {
    const before = doc(LINES);
    expect(findingsFor(before.getText())).toContain('unused-local');

    const diagnostic = finding(before, 1, 'sUnused', 'unused-local');
    const [suppression] = codeActions(before, [diagnostic]).filter((a) =>
      a.title.startsWith('Suppress')
    );
    const after = apply(before, suppression!);

    expect(findingsFor(after)).not.toContain('unused-local');
  });

  it('removing the declaration also clears it', () => {
    const before = doc(LINES);
    const [removal] = codeActions(before, [finding(before, 1, 'sUnused', 'unused-local')]).filter(
      (a) => a.title.startsWith('Remove')
    );
    expect(findingsFor(apply(before, removal!))).not.toContain('unused-local');
  });

  it('declaring the global explicitly clears implicit-global', () => {
    const before = doc(['String sStartView', '']);
    expect(findingsFor(before.getText())).toContain('implicit-global');

    const [fix] = codeActions(before, [finding(before, 0, 'sStartView', 'implicit-global')]).filter(
      (a) => a.title === 'Declare as Global_Variable'
    );
    expect(findingsFor(apply(before, fix!))).not.toContain('implicit-global');
  });
});
