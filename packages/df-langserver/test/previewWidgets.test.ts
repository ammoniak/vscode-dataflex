import { describe, expect, it } from 'vitest';
import { parseSource } from '@vscode-dataflex/parser';
import { SymbolIndex } from '@vscode-dataflex/workspace';
import { buildPreviewModel } from '../src/preview/model';
import type { PreviewObject } from '../src/preview/model';

/**
 * Objects a class declares, and what a widget container does with the ones that are widgets.
 *
 * Two things the source nesting does not say on its own. A class's `Construct_Object` creates
 * subobjects in every instance of it, which is where a widget's whole content lives; and
 * `cWebWidgetContainer` keeps its `cWebWidget` children out of the client tree altogether, handing
 * them to an internal container that owns the grid. See `docs/PREVIEW.md`.
 */

const LIB = 'C:\\DfPkg\\Web_UI\\AppSrc\\Web.pkg';
const LIBRARY = [
  'Class cWebObject is a cObject',
  '    Procedure Construct_Object',
  '        { WebProperty=Client }',
  '        Property Integer piColumnIndex -1',
  '        { WebProperty=Client }',
  '        Property Integer piColumnSpan 1',
  '        { WebProperty=Client }',
  '        Property Integer piRowSpan 1',
  '        { WebProperty=Client }',
  '        Property Integer piHeight 0',
  '        { WebProperty=Client }',
  '        Property String psCaption ""',
  '        Set psJSClass to "df.WebObject"',
  '    End_Procedure',
  'End_Class',
  '',
  'Class cWebView is a cWebObject',
  '    Procedure Construct_Object',
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
  'Class cWebGroup is a cWebObject',
  '    Procedure Construct_Object',
  '        { WebProperty=Client }',
  '        Property Integer piColumnCount 12',
  '        { WebProperty=Client }',
  '        Property Integer piRowCount 0',
  '        { WebProperty=Client }',
  '        Property String psDefaultRowHeight ""',
  '        { WebProperty=Client }',
  '        Property String psDefaultColumnWidth ""',
  '        { WebProperty=Client }',
  '        Property Integer peLayoutType 0',
  '        Set psJSClass to "df.WebGroup"',
  '    End_Procedure',
  'End_Class',
  '',
  'Class cWebImage is a cWebObject',
  '    Procedure Construct_Object',
  '        { WebProperty=Client }',
  '        Property String psUrl ""',
  '        Set psJSClass to "df.WebImage"',
  '    End_Procedure',
  'End_Class',
  '',
  'Class cWebLabel is a cWebObject',
  '    Procedure Construct_Object',
  '        Set psJSClass to "df.WebLabel"',
  '    End_Procedure',
  'End_Class',
  '',
  'Class cWebWidget is a cWebGroup',
  '    Procedure Construct_Object',
  '        { WebProperty=Client }',
  '        Property String psWidgetName ""',
  '        Set psJSClass to "df.WebWidget"',
  '    End_Procedure',
  'End_Class',
  '',
  'Class cWebWidgetContainer is a cWebGroup',
  '    Procedure Construct_Object',
  '        Set piColumnCount to 12',
  '        Set piRowCount to 0',
  '        Set psDefaultRowHeight to "80px"',
  '        Set psJSClass to "df.WebWidgetContainer"',
  '    End_Procedure',
  'End_Class',
  '',
  'Class cWebWidgetContainerInternal is a cWebGroup',
  '    Procedure Construct_Object',
  '        Set peLayoutType to 2',
  '        Set psJSClass to "df.WebWidgetContainerInternal"',
  '    End_Procedure',
  'End_Class',
  '',
  'Class cWebContextMenu is a cWebObject',
  '    Procedure Construct_Object',
  '        Set psJSClass to "df.WebContextMenu"',
  '    End_Procedure',
  'End_Class',
  ''
].join('\n');

/** The same library with no internal container, for the workspace that has not got one. */
const WITHOUT_HOST = LIBRARY.replace(
  'Class cWebWidgetContainerInternal is a cWebGroup',
  'Class cUnusedInternal is a cWebGroup'
);

const CONSTANTS = 'C:\\DfPkg\\Web_UI\\AppSrc\\WebUIConstants.pkg';
const CONSTANT_SOURCE = [
  'Enum_List',
  '    Define rmDesktop for 10',
  '    Define rmTablet',
  '    Define rmTabletLandscape',
  '    Define rmTabletPortrait',
  'End_Enum_List',
  ''
].join('\n');

const WIDGETS = 'C:\\ws\\AppSrc\\Dashboard\\cTileWidget.wo';
const WIDGET_SOURCE = [
  'Composite cTileWidget is a cWebWidget',
  '    Set psWidgetName to "oTileWidget"',
  '',
  '    Object oModuleIcon is a cWebImage',
  '        Set psUrl to "Images/Module.png"',
  '        Set piHeight to 200',
  '    End_Object',
  'End_Composite',
  '',
  'Composite cProjectTileWidget is a cTileWidget',
  '    Set psWidgetName to "oProjectTileWidget"',
  '',
  '    Object oBadge is a cWebLabel',
  '        Set psCaption to "Projects"',
  '    End_Object',
  'End_Composite',
  ''
].join('\n');

const FILE = 'C:\\ws\\AppSrc\\vwDashboard.wo';

function build(source: string, extra: Record<string, string> = {}, lib = LIBRARY) {
  const index = new SymbolIndex();
  index.indexFile(LIB, lib);
  index.indexFile(WIDGETS, WIDGET_SOURCE);
  for (const [path, text] of Object.entries(extra)) {
    index.indexFile(path, text);
  }
  index.indexFile(FILE, source);

  const files: Record<string, string> = { [LIB]: lib, [WIDGETS]: WIDGET_SOURCE, ...extra };
  return buildPreviewModel(parseSource(source, { uri: FILE }), index, {
    readFile: (path) => files[path]
  });
}

/** The object with this name, anywhere in the tree. */
function find(model: ReturnType<typeof build>, name: string): PreviewObject | undefined {
  const walk = (node: PreviewObject): PreviewObject | undefined => {
    if (node.sName === name) {
      return node;
    }
    for (const child of node.aObjs) {
      const found = walk(child);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  return walk(model.definition.obj);
}

function typeOf(model: ReturnType<typeof build>, name: string): string | undefined {
  const object = find(model, name);
  return model.definition.aClasses.find((entry) => entry.hClassId === object?.hClassId)?.sType;
}

function names(object: PreviewObject | undefined): string[] {
  return (object?.aObjs ?? []).map((child) => child.sName);
}

describe('objects a class declares', () => {
  const VIEW = [
    'Object oVwDashboard is a cWebView',
    '    Object oMainPanel is a cWebPanel',
    '        Object oTile is a cTileWidget',
    '            Set piColumnIndex to 4',
    '        End_Object',
    '    End_Object',
    'End_Object',
    ''
  ].join('\n');

  it('are expanded into every instance, the way Construct_Object creates them', () => {
    const model = build(VIEW);
    expect(names(find(model, 'oTile'))).toEqual(['oModuleIcon']);
    expect(typeOf(model, 'oModuleIcon')).toBe('df.WebImage');
    expect(find(model, 'oModuleIcon')?.props).toEqual({
      psUrl: 'Images/Module.png',
      piHeight: 200
    });
  });

  it('come base-first, then the ones the class itself declares', () => {
    const model = build(VIEW.replace('is a cTileWidget', 'is a cProjectTileWidget'));
    expect(names(find(model, 'oTile'))).toEqual(['oModuleIcon', 'oBadge']);
  });

  it('are keyed to the file they are written in, so a click leaves the view', () => {
    const model = build(VIEW);
    expect(model.ranges['oVwDashboard.oMainPanel.oTile']?.file).toBeUndefined();
    const icon = model.ranges['oVwDashboard.oMainPanel.oTile.oModuleIcon'];
    expect(icon?.file).toBe(WIDGETS);
    expect(icon?.range.start.line).toBe(3);
  });

  it('are found in a Class with a Construct_Object as well as in a Composite', () => {
    const PLAIN = 'C:\\ws\\AppSrc\\cPlainWidget.pkg';
    const source = [
      'Class cPlainWidget is a cWebWidget',
      '    Procedure Construct_Object',
      '        Forward Send Construct_Object',
      '        Object oInner is a cWebLabel',
      '            Set psCaption to "Inner"',
      '        End_Object',
      '    End_Procedure',
      'End_Class',
      ''
    ].join('\n');
    const model = build(VIEW.replace('is a cTileWidget', 'is a cPlainWidget'), { [PLAIN]: source });
    expect(names(find(model, 'oTile'))).toEqual(['oInner']);
    expect(find(model, 'oInner')?.props).toEqual({ psCaption: 'Inner' });
  });

  it('nest: a class-declared object expands its own class in turn', () => {
    const OUTER = 'C:\\ws\\AppSrc\\cOuter.pkg';
    const source = [
      'Composite cOuter is a cWebGroup',
      '    Object oNestedTile is a cTileWidget',
      '    End_Object',
      'End_Composite',
      ''
    ].join('\n');
    const model = build(VIEW.replace('is a cTileWidget', 'is a cOuter'), { [OUTER]: source });
    expect(names(find(model, 'oTile'))).toEqual(['oNestedTile']);
    expect(names(find(model, 'oNestedTile'))).toEqual(['oModuleIcon']);
  });

  it('do not collide: an object body redeclaring the name keeps the class version', () => {
    const model = build(
      [
        'Object oVwDashboard is a cWebView',
        '    Object oTile is a cTileWidget',
        '        Object oModuleIcon is a cWebLabel',
        '            Set psCaption to "Mine"',
        '        End_Object',
        '    End_Object',
        'End_Object',
        ''
      ].join('\n')
    );
    expect(names(find(model, 'oTile'))).toEqual(['oModuleIcon']);
    expect(typeOf(model, 'oModuleIcon')).toBe('df.WebImage');
  });

  it('terminate when a class declares an object of its own class', () => {
    const LOOP = 'C:\\ws\\AppSrc\\cLoop.pkg';
    const source = [
      'Composite cLoop is a cWebGroup',
      '    Object oAgain is a cLoop',
      '    End_Object',
      'End_Composite',
      ''
    ].join('\n');
    const model = build(VIEW.replace('is a cTileWidget', 'is a cLoop'), { [LOOP]: source });
    expect(names(find(model, 'oTile'))).toEqual(['oAgain']);
    expect(names(find(model, 'oAgain'))).toEqual([]);
  });

  it('keep their own Set statements out of the class defaults', () => {
    // `Set piHeight to 200` is oModuleIcon's. Read as a default of cTileWidget it would give every
    // instance of the widget the icon's height, and piHeight is published, so it is accepted.
    const model = build(VIEW);
    const tile = find(model, 'oTile');
    const tileClass = model.definition.aClasses.find((entry) => entry.hClassId === tile?.hClassId);
    expect(tileClass?.props).toEqual({ psWidgetName: 'oTileWidget' });
  });
});

describe('a widget container', () => {
  const DASHBOARD = [
    'Object oVwDashboard is a cWebView',
    '    Object oMainPanel is a cWebPanel',
    '        Object oWidgetContainer is a cWebWidgetContainer',
    '            Set piRowCount to 15',
    '            Set piColumnCount to 9',
    '',
    '            Object oTile is a cTileWidget',
    '                Set piColumnIndex to 4',
    '                Set piColumnSpan to 2',
    '            End_Object',
    '',
    '            Object oMenu is a cWebContextMenu',
    '            End_Object',
    '        End_Object',
    '    End_Object',
    'End_Object',
    ''
  ].join('\n');

  it('puts its widgets in an internal container, which is where the grid is', () => {
    const model = build(DASHBOARD);
    expect(names(find(model, 'oWidgetContainer'))).toEqual(['oPreviewWidgetHost', 'oMenu']);
    expect(typeOf(model, 'oPreviewWidgetHost')).toBe('df.WebWidgetContainerInternal');
    expect(names(find(model, 'oPreviewWidgetHost'))).toEqual(['oTile']);
  });

  it('copies the grid across, because initJSON sets the wrapper before the child exists', () => {
    const model = build(DASHBOARD);
    expect(find(model, 'oPreviewWidgetHost')?.props).toEqual({
      piRowCount: 15,
      piColumnCount: 9,
      psDefaultRowHeight: '80px'
    });
  });

  it('copies the mode-resolved grid, not the base one', () => {
    // On a live client the wrapper's `propRule` reaches the internal container through
    // `set_piColumnCount`'s forward, so the tablet count is what the grid ends up with.
    const source = DASHBOARD.replace(
      '            Set piColumnCount to 9',
      '            Set piColumnCount to 9\n            WebSetResponsive piColumnCount rmTablet to 4'
    );
    const index = new SymbolIndex();
    index.indexFile(LIB, LIBRARY);
    index.indexFile(CONSTANTS, CONSTANT_SOURCE);
    index.indexFile(WIDGETS, WIDGET_SOURCE);
    index.indexFile(FILE, source);
    const files: Record<string, string> = {
      [LIB]: LIBRARY,
      [CONSTANTS]: CONSTANT_SOURCE,
      [WIDGETS]: WIDGET_SOURCE
    };
    const model = buildPreviewModel(parseSource(source, { uri: FILE }), index, {
      readFile: (path) => files[path],
      mode: 22
    });
    expect(find(model, 'oPreviewWidgetHost')?.props.piColumnCount).toBe(4);
  });

  it('keeps the widget its own placement and its expanded content', () => {
    const model = build(DASHBOARD);
    expect(find(model, 'oTile')?.props).toEqual({ piColumnIndex: 4, piColumnSpan: 2 });
    expect(names(find(model, 'oTile'))).toEqual(['oModuleIcon']);
  });

  it('re-keys the ranges, so a click inside a widget still finds its source', () => {
    const model = build(DASHBOARD);
    const under = 'oVwDashboard.oMainPanel.oWidgetContainer.oPreviewWidgetHost';
    expect(model.ranges[`${under}.oTile`]?.range.start.line).toBe(6);
    expect(model.ranges[`${under}.oTile.oModuleIcon`]?.file).toBe(WIDGETS);
    expect(model.ranges['oVwDashboard.oMainPanel.oWidgetContainer.oTile']).toBeUndefined();
  });

  it('reveals the container itself when the grid behind the widgets is clicked', () => {
    const model = build(DASHBOARD);
    const container = 'oVwDashboard.oMainPanel.oWidgetContainer';
    expect(model.ranges[`${container}.oPreviewWidgetHost`]).toEqual(model.ranges[container]);
  });

  it('says so and draws them in place when the internal container is not indexed', () => {
    const model = build(DASHBOARD, {}, WITHOUT_HOST);
    expect(names(find(model, 'oWidgetContainer'))).toEqual(['oTile', 'oMenu']);
    expect(model.problems.some((p) => p.message.includes('cWebWidgetContainerInternal'))).toBe(
      true
    );
  });
});
