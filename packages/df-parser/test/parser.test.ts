import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSource } from '../src/parser';
import { DfNode, nodeChainAt, walk } from '../src/ast';

const FIXTURES = join(__dirname, '..', '..', '..', 'fixtures');

function parse(source: string) {
  return parseSource(source, { uri: 'test.pkg' });
}

/** All nodes of a kind, flattened. */
function nodesOfKind(root: DfNode, kind: DfNode['kind']): DfNode[] {
  const found: DfNode[] = [];
  walk(root, (node) => {
    if (node.kind === kind) {
      found.push(node);
    }
  });
  return found;
}

function child(node: DfNode, name: string): DfNode {
  const found = node.children?.find((c) => c.name?.toLowerCase() === name.toLowerCase());
  if (found === undefined) {
    throw new Error(`no child named ${name}; have ${node.children?.map((c) => c.name).join(', ')}`);
  }
  return found;
}

describe('objects and classes', () => {
  it('nests objects and records the `is a` class', () => {
    const unit = parse(readFileSync(join(FIXTURES, 'WebCustomer.wo'), 'utf8'));
    expect(unit.diagnostics).toEqual([]);

    const view = child(unit.root, 'oCustomer');
    expect(view.kind).toBe('object');
    expect(view.superClass).toBe('cWebView');

    const panel = child(view, 'oWebMainPanel');
    expect(panel.superClass).toBe('cWebPanel');

    const name = child(panel, 'oCustomerName');
    expect(name.superClass).toBe('cWebForm');
    expect(child(panel, 'oCustomerCity').superClass).toBe('cWebForm');
  });

  it('records the parent class of a class declaration', () => {
    const unit = parse('Class cWebForm is a cWebBaseDEO\nEnd_Class\n');
    const cls = child(unit.root, 'cWebForm');
    expect(cls.kind).toBe('class');
    expect(cls.superClass).toBe('cWebBaseDEO');
  });
});

describe('properties', () => {
  it('attaches { Tag=Value } metadata and the trailing comment to the declaration', () => {
    const unit = parse(
      [
        'Class cWebForm is a cWebBaseDEO',
        '    { WebProperty=Client }',
        '    { Category="Appearance" }',
        '    Property String psPlaceHolder ""              // Placeholder text.',
        'End_Class'
      ].join('\n')
    );

    const property = nodesOfKind(unit.root, 'property')[0]!;
    expect(property.name).toBe('psPlaceHolder');
    expect(property.type).toBe('String');
    expect(property.value).toBe('""');
    expect(property.doc).toBe('Placeholder text.');
    expect(property.metadata).toEqual([
      expect.objectContaining({ name: 'WebProperty', value: 'Client' }),
      expect.objectContaining({ name: 'Category', value: 'Appearance' })
    ]);
  });

  it('splits several tags sharing one brace pair', () => {
    // `{ WebProperty=Server Visibility=Private }` occurs 245 times in the Web UI package alone.
    // Reading to the closing brace would make the WebProperty value "ServerVisibility=Private".
    const unit = parse(
      ['{ WebProperty=Server Visibility=Private }', 'Property String psInvokingStateHash ""'].join('\n')
    );
    expect(nodesOfKind(unit.root, 'property')[0]!.metadata).toEqual([
      expect.objectContaining({ name: 'WebProperty', value: 'Server' }),
      expect.objectContaining({ name: 'Visibility', value: 'Private' })
    ]);
  });

  it('keeps a quoted value containing spaces and commas intact', () => {
    const unit = parse(
      ['{ EnumList="True,False,C_WebDefault" }', 'Property Integer pbPromptButton C_WebDefault'].join('\n')
    );
    expect(nodesOfKind(unit.root, 'property')[0]!.metadata).toEqual([
      expect.objectContaining({ name: 'EnumList', value: 'True,False,C_WebDefault' })
    ]);
  });

  it('handles a tag with no value', () => {
    const unit = parse(['{ Published }', 'Property String psX ""'].join('\n'));
    expect(nodesOfKind(unit.root, 'property')[0]!.metadata).toEqual([
      expect.objectContaining({ name: 'Published', value: undefined })
    ]);
  });

  it('handles a property with a non-literal default', () => {
    const unit = parse('Property Integer pbPromptButton C_WebDefault\n');
    const property = nodesOfKind(unit.root, 'property')[0]!;
    expect(property.name).toBe('pbPromptButton');
    expect(property.value).toBe('C_WebDefault');
  });
});

describe('procedures and functions', () => {
  it('reads a typed parameter list with ByRef', () => {
    const unit = parse(
      'Procedure AdjustForMultiDisplay Integer iHeight Integer ByRef iCol\nEnd_Procedure\n'
    );
    const proc = nodesOfKind(unit.root, 'procedure')[0]!;
    expect(proc.name).toBe('AdjustForMultiDisplay');
    expect(proc.params).toEqual([
      expect.objectContaining({ type: 'Integer', name: 'iHeight', byRef: false }),
      expect.objectContaining({ type: 'Integer', name: 'iCol', byRef: true })
    ]);
  });

  it('does not count `Global` as a parameter', () => {
    // `Global` marks the method, not a parameter. Treating it as a type pairs it with the real
    // first type and leaves the last name dangling, so every global method in the runtime library
    // reported one parameter too many -- and any arity check built on that is wrong everywhere.
    const unit = parse(
      'Function CreateDirectoryRecursive Global String sDir Returns Boolean\nEnd_Function\n'
    );
    const fn = nodesOfKind(unit.root, 'function')[0]!;
    expect(fn.params).toEqual([expect.objectContaining({ type: 'String', name: 'sDir' })]);
    expect(fn.type).toBe('Boolean');
  });

  it('reads a global procedure parameter list', () => {
    const unit = parse('Procedure DfCovHit Global Integer iProbe\nEnd_Procedure\n');
    const proc = nodesOfKind(unit.root, 'procedure')[0]!;
    expect(proc.params).toEqual([expect.objectContaining({ type: 'Integer', name: 'iProbe' })]);
  });

  it('recognises the `Procedure Set <Name>` property-setter form', () => {
    const unit = parse('Procedure Set Auto_Locate_State Integer iState\nEnd_Procedure\n');
    const proc = nodesOfKind(unit.root, 'procedure')[0]!;
    // The method is named after the property, not "Set".
    expect(proc.name).toBe('Auto_Locate_State');
    expect(proc.isSetter).toBe(true);
    expect(proc.params).toEqual([expect.objectContaining({ type: 'Integer', name: 'iState' })]);
  });

  it('reads the `for <Class>` graft clause and the return type', () => {
    const unit = parse('Function Main_Panel_Id for cDesktop Returns Integer\nEnd_Function\n');
    const fn = nodesOfKind(unit.root, 'function')[0]!;
    expect(fn.name).toBe('Main_Panel_Id');
    expect(fn.forClass).toBe('cDesktop');
    expect(fn.type).toBe('Integer');
    expect(fn.params).toEqual([]);
  });

  it('accepts End_Procedure and End_Function interchangeably', () => {
    // Both forms appear in the shipped runtime library; the compiler accepts either.
    const unit = parse(
      [
        'Function Status_Help_Value Returns String',
        'End_Procedure',
        'Procedure SQLPrepare String sSQLQuery',
        'End_Function'
      ].join('\n')
    );
    expect(unit.diagnostics).toEqual([]);
    expect(nodesOfKind(unit.root, 'function')).toHaveLength(1);
    expect(nodesOfKind(unit.root, 'procedure')).toHaveLength(1);
  });
});

describe('variables', () => {
  it('emits one node per name on a multi-name declaration', () => {
    const unit = parse('Procedure Foo\n    String sName sValue\nEnd_Procedure\n');
    const vars = nodesOfKind(unit.root, 'variable');
    expect(vars.map((v) => v.name)).toEqual(['sName', 'sValue']);
    expect(vars.every((v) => v.type === 'String')).toBe(true);
  });

  it('handles an array declaration', () => {
    const unit = parse('Procedure Foo\n    String[] sValues\nEnd_Procedure\n');
    const declared = nodesOfKind(unit.root, 'variable')[0]!;
    expect(declared.name).toBe('sValues');
    expect(declared.type).toBe('String[]');
  });

  it('uses struct names declared in the same file as types', () => {
    const unit = parse(
      ['Struct tComboItemData', '    String sCaption', 'End_Struct', 'tComboItemData myRow'].join('\n')
    );
    const declared = nodesOfKind(unit.root, 'variable')[0]!;
    expect(declared.name).toBe('myRow');
    expect(declared.type).toBe('tComboItemData');
  });

  it('uses struct names supplied by the caller (what the workspace linker provides)', () => {
    const unit = parseSource('tDataSourceRow row\n', {
      knownTypes: new Set(['tdatasourcerow'])
    });
    expect(nodesOfKind(unit.root, 'variable')[0]!.name).toBe('row');
  });
});

describe('structs and enums', () => {
  it('reads modern struct fields', () => {
    const unit = parse(
      ['Struct tComboItemData', '    String sCaption   // Displayed value', '    Integer iData', 'End_Struct'].join('\n')
    );
    const struct = nodesOfKind(unit.root, 'struct')[0]!;
    expect(struct.name).toBe('tComboItemData');
    expect(struct.children?.map((f) => [f.type, f.name])).toEqual([
      ['String', 'sCaption'],
      ['Integer', 'iData']
    ]);
    expect(struct.children?.[0]!.doc).toBe('Displayed value');
  });

  it('reads an array-typed struct field as a field, not a variable', () => {
    // Requiring an identifier straight after the type made `tHelpTopic[] aSubTopics` fall through
    // to the local-variable branch. That mislabelled it in the outline, and made every array
    // struct field look like a variable declared outside a method -- an implicit global.
    const unit = parse(
      [
        'Struct tHelpTopic',
        '    String sCaption',
        '    tHelpTopic[] aSubTopics',
        '    String[] sValues',
        'End_Struct'
      ].join('\n')
    );

    expect(nodesOfKind(unit.root, 'variable')).toEqual([]);
    const struct = nodesOfKind(unit.root, 'struct')[0]!;
    expect(struct.children?.map((f) => [f.type, f.name])).toEqual([
      ['String', 'sCaption'],
      ['tHelpTopic[]', 'aSubTopics'],
      ['String[]', 'sValues']
    ]);
  });

  it('reads the legacy `Type` / `Field x As y` form', () => {
    const unit = parse(['Type tPOINT', '    Field tPOINT.x as DWORD', 'End_Type'].join('\n'));
    const struct = nodesOfKind(unit.root, 'struct')[0]!;
    expect(struct.name).toBe('tPOINT');
    // The struct qualifier is stripped so the field name matches the modern form.
    expect(struct.children?.map((f) => [f.type, f.name])).toEqual([['DWORD', 'x']]);
  });

  it('reads both enum list spellings', () => {
    const unit = parse(
      ['Enum_List', '    Define ddrtsNone', 'End_Enum_List', 'Enumeration_List', '    Define NO_LOCATE', 'End_Enumeration_List'].join('\n')
    );
    expect(unit.diagnostics).toEqual([]);
    expect(nodesOfKind(unit.root, 'enumValue').map((e) => e.name)).toEqual(['ddrtsNone', 'NO_LOCATE']);
  });

  it('keeps an explicit enum member value, as written', () => {
    const unit = parse(
      ['Enum_List', '    Define lpLeft', '    Define lpTop for 4 // resets', '    Define lpRight', 'End_Enum_List'].join('\n')
    );
    expect(nodesOfKind(unit.root, 'enumValue').map((e) => [e.name, e.value])).toEqual([
      ['lpLeft', undefined],
      ['lpTop', '4'],
      ['lpRight', undefined]
    ]);
  });
});

describe('statements', () => {
  it('extracts verb, target and the `of` object', () => {
    const unit = parse('WebSet psValue of oCustomerCity to "unknown"\n');
    const statement = nodesOfKind(unit.root, 'statement')[0]!;
    expect(statement.verb).toBe('webset');
    expect(statement.target).toBe('psValue');
    expect(statement.ofObject).toBe('oCustomerCity');
  });

  it('does not mistake the value in `Set x to y` for a receiver', () => {
    const statement = nodesOfKind(parse('Set psLabel to "Name:"\n').root, 'statement')[0]!;
    expect(statement.target).toBe('psLabel');
    expect(statement.ofObject).toBeUndefined();
  });

  it('takes the receiver after `to` for a message send', () => {
    const statement = nodesOfKind(parse('Send Activate_View to oCustomer\n').root, 'statement')[0]!;
    expect(statement.verb).toBe('send');
    expect(statement.target).toBe('Activate_View');
    expect(statement.ofObject).toBe('oCustomer');
  });
});

describe('single-line conditionals', () => {
  it('normalises `If (cond) <stmt>` into the same shape as the Begin/End form', () => {
    // Control-flow analysis then has one shape to handle instead of a statement whose consequent
    // is buried in raw text.
    const unit = parse('Procedure Foo\n    If (bDone) Function_Return 0\nEnd_Procedure\n');
    const block = nodesOfKind(unit.root, 'block')[0]!;

    expect(block.blockKind).toBe('if');
    expect(block.inline).toBe(true);
    expect(block.condition).toBe('(bDone)');

    const consequent = block.children![0]!;
    expect(consequent.kind).toBe('statement');
    expect(consequent.verb).toBe('function_return');
    expect(consequent.transfer).toBe('return');
  });

  it('marks the Begin/End form as not inline', () => {
    const unit = parse(
      ['Procedure Foo', '    If (x) Begin', '        Send A', '    End', 'End_Procedure'].join('\n')
    );
    const block = nodesOfKind(unit.root, 'block')[0]!;
    expect(block.blockKind).toBe('if');
    expect(block.inline).toBeUndefined();
  });

  it('handles an unparenthesised multi-token condition', () => {
    // The runtime library writes `If iRet Eq 0 Function_Return -1`; taking only one token as the
    // condition left `Eq 0 ...` to be misread as a statement.
    const unit = parse('Procedure Foo\n    If iRet Eq 0 Function_Return -1\nEnd_Procedure\n');
    const block = nodesOfKind(unit.root, 'block')[0]!;
    expect(block.condition).toBe('iRet Eq 0');
    expect(block.children![0]!.verb).toBe('function_return');
  });

  it('nests `Else If (cond) <stmt>`', () => {
    const unit = parse('Procedure Foo\n    Else If (x) Send Refresh\nEnd_Procedure\n');
    const outer = nodesOfKind(unit.root, 'block')[0]!;
    expect(outer.blockKind).toBe('else');

    const inner = outer.children![0]!;
    expect(inner.kind).toBe('block');
    expect(inner.blockKind).toBe('if');
    expect(inner.condition).toBe('(x)');
    expect(inner.children![0]!.verb).toBe('send');
  });

  it('leaves the line as one statement when the consequent is not a recognised verb', () => {
    // Claiming block structure we cannot verify would also hide the unrecognised verb, which is
    // exactly what the unknown-rate metric exists to surface.
    const unit = parse('Procedure Foo\n    If (x) SomeUnknownMacro oThing\nEnd_Procedure\n');
    expect(nodesOfKind(unit.root, 'block')).toEqual([]);
    const statement = nodesOfKind(unit.root, 'statement').find((s) => s.verb === 'if');
    expect(statement).toBeDefined();
  });

  it('recognises a consequent that is a caller-supplied command', () => {
    const unit = parseSource('Procedure Foo\n    If (x) WebSetResponsive oGrid\nEnd_Procedure\n', {
      knownCommands: new Set(['websetresponsive'])
    });
    const block = nodesOfKind(unit.root, 'block')[0]!;
    expect(block.blockKind).toBe('if');
    expect(block.children![0]!.verb).toBe('websetresponsive');
  });
});

describe('control transfers', () => {
  it('categorises statements that leave unconditionally', () => {
    const unit = parse(
      [
        'Procedure Foo',
        '    Procedure_Return',
        'End_Procedure',
        'Function Bar Returns Integer',
        '    Function_Return 0',
        'End_Function'
      ].join('\n')
    );
    const transfers = nodesOfKind(unit.root, 'statement')
      .filter((s) => s.transfer !== undefined)
      .map((s) => [s.verb, s.transfer]);
    expect(transfers).toEqual([
      ['procedure_return', 'return'],
      ['function_return', 'return']
    ]);
  });

  it('leaves an ordinary statement uncategorised', () => {
    const unit = parse('Procedure Foo\n    Send DoThing\nEnd_Procedure\n');
    expect(nodesOfKind(unit.root, 'statement')[0]!.transfer).toBeUndefined();
  });
});

describe('blocks', () => {
  it('nests Begin/End blocks and labels them by the opening keyword', () => {
    const unit = parse(
      ['Procedure Foo', '    If (x) Begin', '        Move 1 to i', '    End', '    Else Begin', '    End', 'End_Procedure'].join('\n')
    );
    expect(unit.diagnostics).toEqual([]);
    const blocks = nodesOfKind(unit.root, 'block');
    expect(blocks.map((b) => b.blockKind)).toEqual(['if', 'else']);
  });

  it('closes For and While with Loop, and Repeat with Until', () => {
    const unit = parse(
      ['For i from 1 to 10', 'Loop', 'While (x)', 'Loop', 'Repeat', 'Until (y)'].join('\n')
    );
    expect(unit.diagnostics).toEqual([]);
    expect(nodesOfKind(unit.root, 'block').map((b) => b.blockKind)).toEqual(['for', 'while', 'repeat']);
  });

  it('closes Case Begin with Case End', () => {
    const unit = parse(['Case Begin', '    Case (x=1) Begin', '    End', 'Case End'].join('\n'));
    expect(unit.diagnostics).toEqual([]);
  });

  it('records which keyword closed a block', () => {
    const unit = parse(
      ['For i from 1 to 10', 'Loop', 'Repeat', 'Until (x)', 'While (y) Begin', 'End'].join('\n')
    );
    expect(nodesOfKind(unit.root, 'block').map((b) => b.closedBy)).toEqual(['loop', 'until', 'end']);
  });
});

describe('case arms', () => {
  const FLAT = [
    'Function F Returns String',
    '    Case Begin',
    '        Case (x=1)',
    '            Function_Return "a"',
    '            Case Break',
    '        Case (x=2)',
    '            Send DoSomething',
    '            Case Break',
    '        Case Else',
    '            Send Fallback',
    '    Case End',
    'End_Function'
  ].join('\n');

  it('groups each arm of a flat Case block into its own node', () => {
    // Written without `Begin`, the arms are flat siblings in source. Grouping them is what lets
    // reachability be computed per arm rather than special-cased.
    const unit = parse(FLAT);
    expect(unit.diagnostics).toEqual([]);

    const arms = nodesOfKind(unit.root, 'caseArm');
    expect(arms).toHaveLength(3);
    expect(arms.map((a) => a.condition)).toEqual(['(x=1)', '(x=2)', undefined]);
  });

  it('puts an arm\'s statements inside that arm', () => {
    const arms = nodesOfKind(parse(FLAT).root, 'caseArm');

    const first = arms[0]!.children!.map((c) => c.verb);
    expect(first).toEqual(['function_return', 'case']);

    const second = arms[1]!.children!.map((c) => c.verb);
    expect(second).toEqual(['send', 'case']);

    // `Case Else` has no condition and runs to `Case End`.
    expect(arms[2]!.children!.map((c) => c.verb)).toEqual(['send']);
  });

  it('marks Case Break as a control transfer', () => {
    const arm = nodesOfKind(parse(FLAT).root, 'caseArm')[0]!;
    const breakStatement = arm.children!.find((c) => c.verb === 'case')!;
    expect(breakStatement.transfer).toBe('break');
  });

  it('handles the `Case (cond) Begin ... End` form', () => {
    const unit = parse(
      [
        'Function F Returns String',
        '    Case Begin',
        '        Case (x=1) Begin',
        '            Send A',
        '        End',
        '        Case (x=2) Begin',
        '            Send B',
        '        End',
        '    Case End',
        'End_Function'
      ].join('\n')
    );
    expect(unit.diagnostics).toEqual([]);

    const arms = nodesOfKind(unit.root, 'caseArm');
    expect(arms).toHaveLength(2);
    // This form is delimited by `End`; the bare form closes at the next arm instead.
    expect(arms.map((a) => a.closedBy)).toEqual(['end', 'end']);
    expect(arms[0]!.children!.map((c) => c.target)).toEqual(['A']);
    expect(arms[1]!.children!.map((c) => c.target)).toEqual(['B']);
  });

  it('does not treat `Case Begin` itself as an arm', () => {
    const unit = parse(['Case Begin', '    Case (x=1)', 'Case End'].join('\n'));
    const outer = nodesOfKind(unit.root, 'block').find((b) => b.blockKind === 'case');
    expect(outer).toBeDefined();
    expect(outer!.kind).toBe('block');
    expect(nodesOfKind(unit.root, 'caseArm')).toHaveLength(1);
  });
});

describe('macro-defined commands', () => {
  it('recognises a #COMMAND declared in the same file as a statement verb', () => {
    const unit = parse(
      ['#COMMAND WebSetResponsive R', '#ENDCOMMAND', 'WebSetResponsive oFoo'].join('\n')
    );
    expect(unit.unknownCount).toBe(0);
    const statement = nodesOfKind(unit.root, 'statement').at(-1)!;
    expect(statement.verb).toBe('websetresponsive');
    expect(statement.target).toBe('oFoo');
  });

  it('recognises a #COMMAND supplied by the caller (what the workspace linker provides)', () => {
    // DataFlex statement syntax is largely macro-defined -- the runtime library declares ~499
    // commands and application libraries add their own -- so a hardcoded verb list cannot work.
    // The linker collects the declared command names and passes them in.
    //
    // `WebSetResponsive` is a real `#COMMAND` from an application library, deliberately *not* in
    // STATEMENT_VERBS: verbs that macros define must be discovered, not baked in.
    const withoutIndex = parseSource('WebSetResponsive oFoo\n');
    expect(withoutIndex.unknownCount).toBe(1);

    const withIndex = parseSource('WebSetResponsive oFoo\n', {
      knownCommands: new Set(['websetresponsive'])
    });
    expect(withIndex.unknownCount).toBe(0);
    expect(nodesOfKind(withIndex.root, 'statement')[0]!.target).toBe('oFoo');
  });
});

describe('macro bodies', () => {
  it('does not track block structure inside a #COMMAND body', () => {
    // The runtime library closes `Function !1_Handle` with `End_Procedure` inside macros; a
    // parser that tracked blocks here would corrupt the rest of the file.
    const unit = parse(
      [
        '#COMMAND Activate_View R "AS""FOR" R',
        '    Function !1_Handle Returns Handle',
        '        Function_Return (!3(Self))',
        '    End_Procedure',
        '#ENDCOMMAND',
        'Class cAfter is a cObject',
        'End_Class'
      ].join('\n')
    );
    expect(unit.diagnostics).toEqual([]);
    // The class after the macro is a sibling of the command, not nested inside it.
    expect(unit.root.children?.map((c) => c.kind)).toEqual(['command', 'class']);
    expect(unit.root.children?.[0]!.children?.every((c) => c.kind === 'macroBody')).toBe(true);
    // Macro template text is not counted as unclassified DataFlex.
    expect(unit.unknownCount).toBe(0);
  });
});

describe('tolerance', () => {
  it('reports an unterminated block but still returns a tree', () => {
    const unit = parse('Object oX is a cWebView\n    Set psCaption to "x"\n');
    expect(unit.diagnostics).toHaveLength(1);
    expect(unit.diagnostics[0]!.message).toMatch(/Unterminated object 'oX'/);
    expect(child(unit.root, 'oX').children).toHaveLength(1);
  });

  it('reports an unmatched closer without discarding the file', () => {
    const unit = parse('End_Object\nClass cX is a cObject\nEnd_Class\n');
    expect(unit.diagnostics[0]!.message).toMatch(/Unmatched/);
    expect(child(unit.root, 'cX').kind).toBe('class');
  });

  it('never throws on random input', () => {
    expect(() => parse('}}} !@#$ \n Object \n End_Object End_Object')).not.toThrow();
  });
});

describe('nodeChainAt', () => {
  it('returns the enclosing object chain, which is what completion ranks on', () => {
    const unit = parse(readFileSync(join(FIXTURES, 'WebCustomer.wo'), 'utf8'));
    // Line 19 (0-based) is `Set psLabel to "City:"` inside oCustomerCity.
    const source = readFileSync(join(FIXTURES, 'WebCustomer.wo'), 'utf8').split(/\r?\n/);
    const line = source.findIndex((l) => l.includes('"City:"'));
    expect(line).toBeGreaterThan(0);

    const chain = nodeChainAt(unit.root, line, 12);
    const objects = chain.filter((n) => n.kind === 'object').map((n) => n.name);
    expect(objects).toEqual(['oCustomer', 'oWebMainPanel', 'oCustomerCity']);
  });
});

/**
 * `Composite <Name> is a <Class>` declares a class whose body is written like an object -- the
 * documentation calls it an instantiable template.
 *
 * It used to parse as a statement, which left everything inside it at file scope: the nested
 * objects, and the event overrides that are the whole point of a widget. Nothing could tell that
 * `Procedure OnInitializeWidget` overrode anything, so it had no documentation link and no
 * override badge.
 */
describe('Composite', () => {
  const SOURCE = [
    'Composite cMyWidget is a cWebWidget',
    '    Set piDefaultColSpan to 4',
    '    Object oLabel is a cWebLabel',
    '    End_Object',
    '    Procedure OnInitializeWidget',
    '    End_Procedure',
    'End_Composite',
    ''
  ].join('\n');

  it('declares a class, with its superclass', () => {
    const unit = parse(SOURCE);
    const node = unit.root.children?.find((c) => c.kind === 'class');
    expect(node?.name).toBe('cMyWidget');
    expect(node?.superClass).toBe('cWebWidget');
  });

  it('contains its members rather than leaving them at file scope', () => {
    const unit = parse(SOURCE);
    const composite = unit.root.children?.find((c) => c.kind === 'class');
    const kinds = (composite?.children ?? []).map((c) => c.kind);
    expect(kinds).toContain('object');
    expect(kinds).toContain('procedure');
    // Nothing escaped to the top level besides the composite itself.
    expect(unit.root.children?.filter((c) => c.kind === 'procedure')).toHaveLength(0);
  });

  it('is closed by End_Composite', () => {
    const unit = parse(SOURCE + 'Procedure After\nEnd_Procedure\n');
    const after = unit.root.children?.filter((c) => c.kind === 'procedure');
    expect(after).toHaveLength(1);
    expect(after?.[0]?.name).toBe('After');
  });
});
