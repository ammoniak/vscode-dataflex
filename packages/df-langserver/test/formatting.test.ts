import { describe, expect, it } from 'vitest';
import { parseSource } from '@vscode-dataflex/parser';
import { formatting, hasUnknown, indentDepths } from '../src/providers/formatting';

/**
 * Re-indentation.
 *
 * Indentation only: nothing is reflowed, joined, split, recased, or blank-line-adjusted. A
 * formatter that rewrites code is one people turn off, and this one runs over a language whose
 * structure the parser models tolerantly rather than perfectly.
 */

const FILE = 'C:\\ws\\x.pkg';

/** Applies the edits, so assertions are about resulting text rather than edit structs. */
function format(source: string, options = { tabSize: 4, insertSpaces: true }): string {
  const unit = parseSource(source, { uri: FILE });
  const lines = source.split('\n');
  for (const edit of formatting(unit, source, options)) {
    const line = edit.range.start.line;
    lines[line] = edit.newText + lines[line]!.slice(edit.range.end.character);
  }
  return lines.join('\n');
}

describe('indenting', () => {
  it('indents a class body one level', () => {
    expect(format('Class cThing is a cObject\nProcedure P\nEnd_Procedure\nEnd_Class\n')).toBe(
      ['Class cThing is a cObject', '    Procedure P', '    End_Procedure', 'End_Class', ''].join('\n')
    );
  });

  /** A line-local rule cannot see that a procedure inside a class is two levels deep. */
  it('indents by real nesting depth, not by the previous line', () => {
    const source = [
      'Class cThing is a cObject',
      'Procedure DoIt',
      'String sName',
      'If (sName = "") Begin',
      'Showln "empty"',
      'End',
      'End_Procedure',
      'End_Class',
      ''
    ].join('\n');
    expect(format(source)).toBe(
      [
        'Class cThing is a cObject',
        '    Procedure DoIt',
        '        String sName',
        '        If (sName = "") Begin',
        '            Showln "empty"',
        '        End',
        '    End_Procedure',
        'End_Class',
        ''
      ].join('\n')
    );
  });

  it('puts a closing keyword back at its opener s depth', () => {
    const formatted = format('Class cThing is a cObject\n        End_Class\n');
    expect(formatted.split('\n')[1]).toBe('End_Class');
  });

  it('indents objects nested in objects', () => {
    const source = ['Object oOuter is a cWebView', 'Object oInner is a cWebForm', 'End_Object', 'End_Object', ''].join('\n');
    expect(format(source)).toBe(
      ['Object oOuter is a cWebView', '    Object oInner is a cWebForm', '    End_Object', 'End_Object', ''].join('\n')
    );
  });

  it('honours the editor s tab size', () => {
    const formatted = format('Class cThing is a cObject\nProcedure P\nEnd_Procedure\nEnd_Class\n', {
      tabSize: 2,
      insertSpaces: true
    });
    expect(formatted.split('\n')[1]).toBe('  Procedure P');
  });

  it('writes tabs when the editor asks for them', () => {
    const formatted = format('Class cThing is a cObject\nProcedure P\nEnd_Procedure\nEnd_Class\n', {
      tabSize: 4,
      insertSpaces: false
    });
    expect(formatted.split('\n')[1]).toBe('\tProcedure P');
  });
});

describe('what it leaves alone', () => {
  it('makes no edit to already-correct source', () => {
    const source = ['Class cThing is a cObject', '    Procedure P', '    End_Procedure', 'End_Class', ''].join('\n');
    expect(formatting(parseSource(source, { uri: FILE }), source)).toEqual([]);
  });

  /** Indenting a blank line would only leave trailing whitespace behind. */
  it('leaves blank lines blank', () => {
    const source = ['Class cThing is a cObject', '', 'Procedure P', 'End_Procedure', 'End_Class', ''].join('\n');
    expect(format(source).split('\n')[1]).toBe('');
  });

  it('does not touch anything but the leading whitespace', () => {
    const source = 'Class cThing is a cObject\nProcedure P   // trailing comment\nEnd_Procedure\nEnd_Class\n';
    expect(format(source)).toContain('    Procedure P   // trailing comment');
  });

  it('edits only the lines that are wrong', () => {
    const source = ['Class cThing is a cObject', 'Procedure P', '    End_Procedure', 'End_Class', ''].join('\n');
    const edits = formatting(parseSource(source, { uri: FILE }), source);
    // Only `Procedure P` is misindented; `End_Procedure` is already right.
    expect(edits).toHaveLength(1);
    expect(edits[0]!.range.start.line).toBe(1);
  });
});

describe('when the parser is unsure', () => {
  /**
   * A file with `unknown` nodes has partly-guessed structure. Re-indenting from a guess moves
   * working code to the wrong depth, and formatting is the one feature where silence beats being
   * approximately right.
   */
  it('formats nothing when the file contains anything unparsed', () => {
    const source = 'Class cThing is a cObject\nSomeUnknownConstruct foo bar\nEnd_Class\n';
    const unit = parseSource(source, { uri: FILE });
    expect(hasUnknown(unit)).toBe(true);
    expect(formatting(unit, source)).toEqual([]);
  });

  it('formats normally when everything parsed', () => {
    const source = 'Class cThing is a cObject\nProcedure P\nEnd_Procedure\nEnd_Class\n';
    expect(hasUnknown(parseSource(source, { uri: FILE }))).toBe(false);
    expect(formatting(parseSource(source, { uri: FILE }), source).length).toBeGreaterThan(0);
  });
});

describe('indentDepths', () => {
  it('gives every line a depth', () => {
    const source = 'Class cThing is a cObject\nProcedure P\nEnd_Procedure\nEnd_Class\n';
    const depths = indentDepths(parseSource(source, { uri: FILE }), source.split('\n').length);
    expect(depths.slice(0, 4)).toEqual([0, 1, 1, 0]);
  });

  it('never returns a negative depth', () => {
    const source = 'End_Class\nEnd_Procedure\n';
    for (const depth of indentDepths(parseSource(source, { uri: FILE }), 2)) {
      expect(depth).toBeGreaterThanOrEqual(0);
    }
  });
});
