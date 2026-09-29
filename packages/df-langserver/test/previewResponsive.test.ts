import { describe, expect, it } from 'vitest';
import { parseSource } from '@vscode-dataflex/parser';
import { SymbolIndex } from '@vscode-dataflex/workspace';
import { buildPreviewModel } from '../src/preview/model';

/**
 * `WebSetResponsive` rules, applied for a requested mode.
 *
 * These values never reach the client through `initJSON`: the server sends each rule separately as
 * a `propRule` client action and the client applies the ones its own mode activates. So a
 * statically built definition is the desktop base layout unless the rules are replayed here, which
 * is what makes a tablet or phone layout inspectable with no server.
 *
 * The selection is the framework's own, from `df.WebObject#enforceRule`: rules sorted by mode
 * descending, first one whose mode is `<=` the active mode wins. A threshold, not an exact match.
 */
const LIB = 'C:\\DfPkg\\Web_UI\\AppSrc\\Web.pkg';
const LIBRARY = [
  'Class cWebObject is a cObject',
  '    Procedure Construct_Object',
  '        Set psJSClass to "df.WebObject"',
  '    End_Procedure',
  'End_Class',
  '',
  'Class cWebView is a cWebObject',
  '    Procedure Construct_Object',
  '        { WebProperty=Client }',
  '        Property Integer piColumnCount 12',
  '        Set psJSClass to "df.WebView"',
  '    End_Procedure',
  'End_Class',
  '',
  'Class cWebForm is a cWebObject',
  '    Procedure Construct_Object',
  '        { WebProperty=Client }',
  '        Property Integer piColumnSpan 0',
  '        { WebProperty=Client }',
  '        Property Integer piColumnIndex 0',
  '        { WebProperty=Client }',
  '        Property Integer peRegion 0',
  '        Property Integer piServerOnly 0',
  '        Set psJSClass to "df.WebForm"',
  '    End_Procedure',
  'End_Class',
  ''
].join('\n');

const CONSTANTS = 'C:\\DfPkg\\Web_UI\\AppSrc\\WebUIConstants.pkg';
// The real values from WebUIConstants.pkg. They are not arbitrary: the `<=` selection depends on
// tablet sorting below mobile, and on the portrait/landscape variants sitting just above each base.
const CONSTANT_SOURCE = [
  'Define rmDesktop for 10',
  'Define rmTablet for 20',
  'Define rmTabletLandscape for 21',
  'Define rmTabletPortrait for 22',
  'Define rmMobile for 30',
  'Define rmMobileLandscape for 31',
  'Define rmMobilePortrait for 32',
  'Define prTop for 3',
  ''
].join('\n');

const FILE = 'C:\\ws\\AppSrc\\Customer.wo';

function build(source: string, mode?: number) {
  const index = new SymbolIndex();
  index.indexFile(LIB, LIBRARY);
  index.indexFile(CONSTANTS, CONSTANT_SOURCE);
  index.indexFile(FILE, source);
  const files: Record<string, string> = { [LIB]: LIBRARY, [CONSTANTS]: CONSTANT_SOURCE };

  return buildPreviewModel(parseSource(source, { uri: FILE }), index, {
    readFile: (path) => files[path],
    ...(mode === undefined ? {} : { mode })
  });
}

function props(model: ReturnType<typeof build>, name: string): Record<string, unknown> {
  const walk = (node: { sName: string; props: Record<string, unknown>; aObjs: unknown[] }): unknown => {
    if (node.sName === name) {
      return node.props;
    }
    for (const child of node.aObjs as { sName: string; props: Record<string, unknown>; aObjs: unknown[] }[]) {
      const found = walk(child);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  return (walk(model.definition.obj as never) ?? {}) as Record<string, unknown>;
}

const VIEW = [
  'Use cWebView.pkg',
  'Object oCustomer is a cWebView',
  '    Object oName is a cWebForm',
  '        Set piColumnSpan to 8',
  '        Set piColumnIndex to 0',
  '        WebSetResponsive piColumnSpan rmTablet to 14',
  '        WebSetResponsive piColumnSpan rmMobile to 28',
  '    End_Object',
  '',
  '    Object oOnlyTablet is a cWebForm',
  '        Set peRegion to 1',
  '        WebSetResponsive peRegion rmTablet to prTop',
  '    End_Object',
  '',
  '    Object oUntouched is a cWebForm',
  '        Set piColumnSpan to 6',
  '    End_Object',
  'End_Object',
  ''
].join('\n');

describe('WebSetResponsive', () => {
  it('is not applied at all without a mode, leaving the base layout', () => {
    expect(props(build(VIEW), 'oName')['piColumnSpan']).toBe(8);
  });

  it('is not applied at desktop either, since no rule is written for it', () => {
    expect(props(build(VIEW, 10), 'oName')['piColumnSpan']).toBe(8);
  });

  it('applies the tablet rule on a tablet', () => {
    expect(props(build(VIEW, 22), 'oName')['piColumnSpan']).toBe(14);
  });

  it('applies the mobile rule on a phone, not the tablet one', () => {
    expect(props(build(VIEW, 32), 'oName')['piColumnSpan']).toBe(28);
  });

  it('carries a tablet rule down to a phone when no mobile rule outranks it', () => {
    // The framework selects on `<=`, so rmTablet (20) is still in force at rmMobilePortrait (32).
    // Reproduced rather than tidied: it is what the running application does.
    expect(props(build(VIEW, 22), 'oOnlyTablet')['peRegion']).toBe(3);
    expect(props(build(VIEW, 32), 'oOnlyTablet')['peRegion']).toBe(3);
  });

  it('leaves the base value for a mode below every rule', () => {
    expect(props(build(VIEW, 10), 'oOnlyTablet')['peRegion']).toBe(1);
  });

  it('leaves properties with no rule alone at every mode', () => {
    for (const mode of [undefined, 10, 22, 32]) {
      expect(props(build(VIEW, mode), 'oUntouched')['piColumnSpan'], String(mode)).toBe(6);
    }
  });

  it('takes the most specific rule when two could apply', () => {
    const source = VIEW.replace(
      '        WebSetResponsive piColumnSpan rmMobile to 28',
      [
        '        WebSetResponsive piColumnSpan rmMobile to 28',
        '        WebSetResponsive piColumnSpan rmMobilePortrait to 24'
      ].join('\n')
    );
    // Both 30 and 32 are <= 32; the higher wins.
    expect(props(build(source, 32), 'oName')['piColumnSpan']).toBe(24);
    // On a landscape phone (31) only the rmMobile rule is eligible.
    expect(props(build(source, 31), 'oName')['piColumnSpan']).toBe(28);
  });

  it('reports a rule it cannot resolve rather than dropping it silently', () => {
    const source = VIEW.replace(
      '        WebSetResponsive piColumnSpan rmTablet to 14',
      '        WebSetResponsive piColumnSpan rmNotAMode to 14'
    );
    const model = build(source, 22);

    expect(props(model, 'oName')['piColumnSpan']).toBe(8);
    expect(model.problems.some((problem) => problem.message.includes('piColumnSpan'))).toBe(true);
  });

  it('ignores a rule for a property the browser never sees', () => {
    const source = VIEW.replace(
      '        WebSetResponsive piColumnSpan rmTablet to 14',
      '        WebSetResponsive piServerOnly rmTablet to 14'
    );
    expect(props(build(source, 22), 'oName')['piServerOnly']).toBeUndefined();
  });
});
