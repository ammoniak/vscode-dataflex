import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { clearScopeCache, frameContext } from '../src';

/**
 * What the parser contributes to a debug session.
 *
 * The engine reports a frame as a file and a line and nothing more: it has no API for a frame's
 * name and none for its variables. Both come from here, so this is what decides whether the call
 * stack reads like a call stack and whether the Variables pane has anything in it at all.
 */

const directory = mkdtempSync(join(tmpdir(), 'df-debug-scope-'));

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function sourceFile(name: string, lines: string[]): string {
  const path = join(directory, name);
  writeFileSync(path, lines.join('\n'), 'utf8');
  clearScopeCache();
  return path;
}

const ORDER = [
  'Use DfAllEnt.pkg', //                                     1
  '', //                                                     2
  'Object oMain is a Panel', //                              3
  '', //                                                     4
  '    Object oBar is a cCJCommandBarSystem', //             5
  '        Set pbAutoResizeIcons to True', //                6
  '        Procedure OnCreateCommandBars', //                7
  '            Handle hoOptions', //                         8
  '            Integer iCount', //                           9
  '            Get OptionsObject to hoOptions', //          10
  '        End_Procedure', //                               11
  '', //                                                    12
  '    End_Object', //                                      13
  '', //                                                    14
  'End_Object', //                                          15
  '', //                                                    16
  'Start_UI' //                                             17
];

describe('frameContext', () => {
  it('names a frame after the procedure that contains it', () => {
    const file = sourceFile('Order.src', ORDER);
    expect(frameContext(file, 10).name).toBe('OnCreateCommandBars');
  });

  it('lists the locals of that procedure', () => {
    const file = sourceFile('Order.src', ORDER);
    const names = frameContext(file, 10).locals.map((local) => local.name);
    expect(names).toEqual(['hoOptions', 'iCount']);
  });

  it('keeps the declared type, which is all the pane can show about a value', () => {
    const file = sourceFile('Order.src', ORDER);
    const local = frameContext(file, 10).locals.find((entry) => entry.name === 'hoOptions');
    expect(local?.type).toBe('Handle');
  });

  it('falls back to the object when the line is not inside a procedure', () => {
    const file = sourceFile('Order.src', ORDER);
    // Most of a DataFlex startup stack is object construction, so this is the common case, not the
    // fallback it looks like.
    expect(frameContext(file, 6).name).toBe('oBar');
  });

  it('includes parameters, and marks the ones passed by reference', () => {
    const file = sourceFile('Params.pkg', [
      'Procedure PopDialog String sTitle Integer ByRef iMode', // 1
      '    String sLocal', //                                    2
      '    Move "x" to sLocal', //                               3
      'End_Procedure' //                                         4
    ]);

    const locals = frameContext(file, 3).locals;
    expect(locals.map((entry) => entry.name)).toEqual(['sTitle', 'iMode', 'sLocal']);
    expect(locals.find((entry) => entry.name === 'iMode')?.byRef).toBe(true);
  });

  it('gives a frame in a file it cannot read a name rather than failing', () => {
    // Runtime library sources are not always present on the machine running the debugger, and a
    // frame without a name is far better than a stack trace that throws.
    const context = frameContext(join(directory, 'does-not-exist.pkg'), 12);
    expect(context.name).toBe('does-not-exist.pkg');
    expect(context.locals).toEqual([]);
  });
});
