import { describe, expect, it } from 'vitest';
import { parseSource } from '@vscode-dataflex/parser';
import { SymbolIndex } from '@vscode-dataflex/workspace';
import { buildPreviewModel } from '../src/preview/model';

/**
 * The web view preview model.
 *
 * What is being asserted is that a `.wo` turns into the exact JSON `df.BaseApp#initJSON` builds an
 * object tree from. The tests below are the cheap half of that; the expensive half is
 * `npm run preview-check`, which puts the output through the real framework in a real browser,
 * because a definition can be structurally perfect and still draw nothing.
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
  '        Property String psCaption ""',
  '        { WebProperty=Client }',
  '        Property Integer piColumnCount 12',
  '        Set psJSClass to "df.WebView"',
  '    End_Procedure',
  'End_Class',
  '',
  'Class cWebPanel is a cWebView',
  '    Procedure Construct_Object',
  '        Set psJSClass to "df.WebPanel"',
  '    End_Procedure',
  'End_Class',
  '',
  'Class cWebForm is a cWebObject',
  '    Procedure Construct_Object',
  '        { WebProperty=Client }',
  '        Property String psLabel ""',
  '        { WebProperty=Client }',
  '        Property Integer peLabelAlign 0',
  '        { WebProperty=Client }',
  '        Property Boolean pbShowLabel True',
  '        Property String psServerOnly ""',
  '        Set psJSClass to "df.WebForm"',
  '    End_Procedure',
  'End_Class',
  '',
  '// A control that changes a default on itself, which the preview has to carry over.',
  'Class cQuietForm is a cWebForm',
  '    Procedure Construct_Object',
  '        Set pbShowLabel to False',
  '    End_Procedure',
  'End_Class',
  '',
  '// No psJSClass anywhere in its chain: nothing can draw it.',
  'Class cCustomerDataDictionary is a cObject',
  'End_Class',
  ''
].join('\n');

const CONSTANTS = 'C:\\DfPkg\\Web_UI\\AppSrc\\WebUIConstants.pkg';
const CONSTANT_SOURCE = [
  'Define C_WebDefault for -1',
  '',
  'Enum_List',
  '    Define alignLeft',
  '    Define alignCenter',
  '    Define alignRight',
  'End_Enum_List',
  ''
].join('\n');

const FILE = 'C:\\ws\\AppSrc\\Customer.wo';

function build(source: string, file = FILE) {
  const index = new SymbolIndex();
  index.indexFile(LIB, LIBRARY);
  index.indexFile(CONSTANTS, CONSTANT_SOURCE);
  index.indexFile(file, source);

  const files: Record<string, string> = { [LIB]: LIBRARY, [CONSTANTS]: CONSTANT_SOURCE };
  return buildPreviewModel(parseSource(source, { uri: file }), index, {
    readFile: (path) => files[path]
  });
}

/** The object with this name, anywhere in the tree. */
function find(model: ReturnType<typeof build>, name: string) {
  const walk = (node: { sName: string; aObjs: unknown[] }): unknown => {
    if (node.sName === name) {
      return node;
    }
    for (const child of node.aObjs as { sName: string; aObjs: unknown[] }[]) {
      const found = walk(child);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  return walk(model.definition.obj) as
    | { sName: string; hClassId: number; props: Record<string, unknown>; aObjs: unknown[] }
    | undefined;
}

/** The class entry an object points at. */
function classOf(model: ReturnType<typeof build>, name: string) {
  const object = find(model, name);
  return model.definition.aClasses.find((entry) => entry.hClassId === object?.hClassId);
}

const VIEW = [
  'Object oCustomer is a cWebView',
  '    Set piColumnCount to 10',
  '    Set psCaption to "Customer Maintenance"',
  '',
  '    Object oWebMainPanel is a cWebPanel',
  '        Object oCustomerName is a cWebForm',
  '            Set psLabel to "Name:"',
  '            Set peLabelAlign to alignRight',
  '        End_Object',
  '',
  '        Object oCustomerCity is a cQuietForm',
  '            Set psLabel to "City:"',
  '        End_Object',
  '    End_Object',
  'End_Object',
  ''
].join('\n');

describe('the definition', () => {
  it('is rooted at df.WebApp, which initJSON binds to the app itself', () => {
    const model = build(VIEW);
    const root = model.definition.obj;
    expect(root.sName).toBe('');
    expect(classOf(model, '')?.sType).toBe('df.WebApp');
    // The view hangs off it, so a file declaring only a view still has somewhere to render.
    expect(root.aObjs).toHaveLength(1);
    expect(model.view).toBe('oCustomer');
  });

  it('nests objects the way the source does', () => {
    const model = build(VIEW);
    const panel = find(model, 'oWebMainPanel');
    expect((panel?.aObjs as { sName: string }[]).map((o) => o.sName)).toEqual([
      'oCustomerName',
      'oCustomerCity'
    ]);
  });

  it('resolves each class to the JavaScript class that draws it', () => {
    const model = build(VIEW);
    expect(classOf(model, 'oCustomer')?.sType).toBe('df.WebView');
    expect(classOf(model, 'oWebMainPanel')?.sType).toBe('df.WebPanel');
    expect(classOf(model, 'oCustomerName')?.sType).toBe('df.WebForm');
  });

  it('inherits the JavaScript class from an ancestor when a class declares none', () => {
    // cQuietForm sets no psJSClass of its own; the runtime draws it as its parent does.
    const model = build(VIEW);
    expect(classOf(model, 'oCustomerCity')?.sType).toBe('df.WebForm');
  });

  it('gives two DataFlex classes their own entry even when they share a JavaScript class', () => {
    const model = build(VIEW);
    const form = classOf(model, 'oCustomerName');
    const quiet = classOf(model, 'oCustomerCity');
    expect(form?.sType).toBe(quiet?.sType);
    // Same sType, different entry: otherwise cQuietForm's own defaults would be lost.
    expect(form?.hClassId).not.toBe(quiet?.hClassId);
  });
});

describe('property values', () => {
  it('reads strings, stripping the quotes', () => {
    expect(find(build(VIEW), 'oCustomerName')?.props.psLabel).toBe('Name:');
  });

  it('reads numbers as numbers', () => {
    expect(find(build(VIEW), 'oCustomer')?.props.piColumnCount).toBe(10);
  });

  it('resolves an Enum_List constant to its ordinal', () => {
    // The framework wants 2. `alignRight` is meaningless to it, and the JavaScript side spells the
    // same constant `df.ciAlignRight`, so only the number carries across.
    expect(find(build(VIEW), 'oCustomerName')?.props.peLabelAlign).toBe(2);
  });

  it('carries over a default a class sets on itself', () => {
    expect(classOf(build(VIEW), 'oCustomerCity')?.props.pbShowLabel).toBe(false);
    expect(classOf(build(VIEW), 'oCustomerName')?.props.pbShowLabel).toBeUndefined();
  });

  it('reads a plain Define with an explicit value', () => {
    const model = build(
      ['Object oX is a cWebForm', '    Set peLabelAlign to C_WebDefault', 'End_Object', ''].join('\n')
    );
    expect(find(model, 'oX')?.props.peLabelAlign).toBe(-1);
  });

  it('ignores properties that are not client-side', () => {
    const model = build(
      ['Object oX is a cWebForm', '    Set psServerOnly to "nope"', 'End_Object', ''].join('\n')
    );
    // Not a { WebProperty=Client } property, so it means nothing in the browser.
    expect(find(model, 'oX')?.props.psServerOnly).toBeUndefined();
  });

  it('omits a value it cannot work out rather than guessing at one', () => {
    const model = build(
      ['Object oX is a cWebForm', '    Set psLabel to (Trim(sName))', 'End_Object', ''].join('\n')
    );
    // Absent, not null and not undefined: initJSON would set the property to that literal value,
    // and a control labelled "undefined" is worse than one left at its default.
    expect(Object.keys(find(model, 'oX')?.props ?? {})).not.toContain('psLabel');
    expect(model.problems.map((p) => p.message).join(' ')).toContain('psLabel');
  });

  it('leaves a Set aimed at another object to that object', () => {
    const model = build(
      [
        'Object oX is a cWebView',
        '    Set psCaption of oInner to "elsewhere"',
        '    Object oInner is a cWebForm',
        '    End_Object',
        'End_Object',
        ''
      ].join('\n')
    );
    expect(find(model, 'oX')?.props.psCaption).toBeUndefined();
  });
});

describe('what cannot be drawn', () => {
  it('drops an object whose class has no JavaScript counterpart, and says so', () => {
    const model = build(
      [
        'Object oCustomer is a cWebView',
        '    Object oCustomerDD is a cCustomerDataDictionary',
        '    End_Object',
        'End_Object',
        ''
      ].join('\n')
    );
    expect(find(model, 'oCustomerDD')).toBeUndefined();
    expect(model.problems[0]?.message).toContain('cCustomerDataDictionary');
  });

  it('reports a file with nothing renderable instead of an empty view', () => {
    const model = build(['Procedure DoNothing', 'End_Procedure', ''].join('\n'));
    expect(model.view).toBeUndefined();
    expect(model.definition.obj.aObjs).toHaveLength(0);
  });
});

describe('a custom control on its own', () => {
  const CONTROL = [
    'Class cMyWidget is a cWebForm',
    '    Procedure Construct_Object',
    '        Forward Send Construct_Object',
    '        Set psLabel to "Widget"',
    '    End_Procedure',
    'End_Class',
    ''
  ].join('\n');

  it('is wrapped in a view and a panel, since a control cannot lay itself out', () => {
    const model = build(CONTROL, 'C:\\ws\\AppSrc\\cMyWidget.pkg');
    expect(model.view).toBe('oPreviewHostView');
    expect(classOf(model, 'oPreviewHostView')?.sType).toBe('df.WebView');
    expect(classOf(model, 'oPreviewControl')?.sType).toBe('df.WebForm');
  });

  it('applies the defaults the control sets on itself', () => {
    const model = build(CONTROL, 'C:\\ws\\AppSrc\\cMyWidget.pkg');
    expect(classOf(model, 'oPreviewControl')?.props.psLabel).toBe('Widget');
  });
});

describe('source ranges', () => {
  it('records where each object was declared, keyed by the dotted long name findObj resolves', () => {
    const model = build(VIEW);
    expect(model.ranges['oCustomer.oWebMainPanel.oCustomerName']?.range.start.line).toBe(5);
    expect(model.ranges.oCustomer?.range.start.line).toBe(0);
    // The bare name is not a key: `df.BaseApp#findObj('oCustomerName')` would find nothing, and a
    // click tagged with it would reveal the view instead of the control.
    expect(model.ranges.oCustomerName).toBeUndefined();
  });

  it('keeps two objects with the same name apart when they live in different panels', () => {
    const model = build(
      [
        'Object oCustomer is a cWebView',
        '    Object oLeft is a cWebPanel',
        '        Object oName is a cWebForm',
        '        End_Object',
        '    End_Object',
        '    Object oRight is a cWebPanel',
        '        Object oName is a cWebForm',
        '        End_Object',
        '    End_Object',
        'End_Object',
        ''
      ].join('\n')
    );
    expect(model.ranges['oCustomer.oLeft.oName']?.range.start.line).toBe(2);
    expect(model.ranges['oCustomer.oRight.oName']?.range.start.line).toBe(6);
  });

  it('keys a lone custom control by its path inside the synthesised host', () => {
    const model = build(
      ['Class cWidget is a cWebForm', 'End_Class', ''].join('\n'),
      'C:\\ws\\AppSrc\\cWidget.pkg'
    );
    expect(model.ranges['oPreviewHostView.oPreviewHostPanel.oPreviewControl']?.range.start.line).toBe(0);
  });
});
