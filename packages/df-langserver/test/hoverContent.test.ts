import { describe, expect, it } from 'vitest';
import {
  callSyntax,
  commandHover,
  declarationHover,
  localHover,
  tableHover
} from '../src/providers/hoverContent';
import { docsEntryForCommand, docsPlatform, docsUrlFor } from '../src/providers/docsLink';
import type { DeclarationFacts } from '../src/providers/hoverContent';

const WEB_UI = 'C:\\ws\\MyApp\\DfPkg\\DataFlex_dev_Web_UI-1.0.52\\AppSrc\\cWebForm.pkg';
const WINDOWS_PKG = 'C:\\Program Files\\DataFlex 26.0\\Pkg\\dfForm.pkg';
const OWN = 'C:\\ws\\MyApp\\AppSrc\\Platform\\cAppDialog.pkg';

function facts(overrides: Partial<DeclarationFacts> = {}): DeclarationFacts {
  return {
    kind: 'procedure',
    name: 'PopDialogX',
    file: OWN,
    where: 'Platform/cAppDialog.pkg',
    ...overrides
  };
}

describe('localHover', () => {
  it('describes a local variable with its type', () => {
    // Locals are not indexed by design, so before this the hover showed nothing at all for them.
    const text = localHover({ kind: 'local', name: 'sTitle', type: 'String', container: 'Foo' });
    expect(text).toContain('String sTitle');
    expect(text).toContain('Local variable of `Foo`');
  });

  it('marks a parameter as such, with ByRef', () => {
    const text = localHover({
      kind: 'parameter',
      name: 'iCol',
      type: 'Integer',
      byRef: true,
      container: 'AdjustForMultiDisplay'
    });
    expect(text).toContain('Integer ByRef iCol');
    expect(text).toContain('Parameter of `AdjustForMultiDisplay`');
  });

  it('names the struct a field belongs to', () => {
    const text = localHover({ kind: 'field', name: 'sCaption', type: 'String', container: 'tTopic' });
    expect(text).toContain('Struct field of `tTopic`');
  });

  it('survives a variable with no declared type', () => {
    expect(() => localHover({ kind: 'local', name: 'x' })).not.toThrow();
  });
});

describe('callSyntax', () => {
  it('renders a procedure as a Send', () => {
    expect(
      callSyntax(
        facts({
          params: [
            { name: 'sTitle', type: 'String', byRef: false, range: {} as never },
            { name: 'iMode', type: 'Integer', byRef: false, range: {} as never }
          ]
        })
      )
    ).toBe('Send PopDialogX sTitle iMode');
  });

  it('renders a function as a Get ... to', () => {
    expect(
      callSyntax(
        facts({
          kind: 'function',
          name: 'IsValid',
          type: 'Boolean',
          params: [{ name: 'iId', type: 'Integer', byRef: false, range: {} as never }]
        })
      )
    ).toBe('Get IsValid iId to bResult');
  });

  it('renders a setter as a Set ... to', () => {
    expect(
      callSyntax(
        facts({
          name: 'psCaption',
          isSetter: true,
          params: [{ name: 'sValue', type: 'String', byRef: false, range: {} as never }]
        })
      )
    ).toBe('Set psCaption to sValue');
  });

  it('renders a procedure with no parameters', () => {
    expect(callSyntax(facts({ name: 'Refresh' }))).toBe('Send Refresh');
  });

  it('says nothing for a class', () => {
    expect(callSyntax(facts({ kind: 'class', name: 'cWebForm' }))).toBeUndefined();
  });
});

describe('declarationHover', () => {
  it('names the ancestor an override shadows', () => {
    const text = declarationHover(
      facts({ overrides: { declaringClass: 'cAppDialog', name: 'PopDialogX' } })
    );
    expect(text).toContain('**Overrides** `cAppDialog.PopDialogX`');
  });

  it('renders the inheritance chain', () => {
    const text = declarationHover(
      facts({ kind: 'class', name: 'cX', hierarchy: ['cX', 'cWebForm', 'cObject'] })
    );
    expect(text).toContain('`cX` → `cWebForm` → `cObject`');
  });

  it('elides a very deep chain', () => {
    const text = declarationHover(
      facts({
        kind: 'class',
        name: 'cX',
        hierarchy: ['cX', 'a', 'b', 'c', 'd', 'e', 'f']
      })
    );
    expect(text).toContain('… (2 more)');
    expect(text).not.toContain('`f`');
  });

  it('omits the chain when there is no ancestry to show', () => {
    expect(declarationHover(facts({ kind: 'class', hierarchy: ['cX'] }))).not.toContain('Inherits');
  });

  it('calls them references only when the name is unambiguous', () => {
    // One declaration, in the user's own code: dispatch cannot land anywhere else.
    expect(declarationHover(facts({ uses: 12, usesAreExact: true }))).toContain('12 references');
  });

  it('calls them occurrences when the name is ambiguous', () => {
    // DataFlex dispatches dynamically, so every `Send Refresh` counts toward every `Refresh`.
    expect(declarationHover(facts({ uses: 12, usesAreExact: false }))).toContain(
      '12 occurrences of this name'
    );
  });

  it('says nothing about uses when there are none', () => {
    expect(declarationHover(facts({ uses: 0 }))).not.toContain('Uses');
  });

  it('shows each badge only when it applies', () => {
    const text = declarationHover(
      facts({
        published: true,
        webPublished: true,
        webProperty: 'Client',
        visibility: 'Private',
        acceptsVariableArguments: true
      })
    );
    expect(text).toContain('_published_');
    expect(text).toContain('_web-published_');
    expect(text).toContain('_web property (Client)_');
    expect(text).toContain('_private_');
    expect(text).toContain('_accepts a variable number of arguments_');

    const plain = declarationHover(facts());
    expect(plain).not.toContain('_published_');
    expect(plain).not.toContain('_web-published_');
  });

  it('puts each parameter on its own line', () => {
    const text = declarationHover(
      facts({
        params: [
          { name: 'sTitle', type: 'String', byRef: false, range: {} as never },
          { name: 'iMode', type: 'Integer', byRef: false, range: {} as never }
        ]
      })
    );
    expect(text).toContain('Procedure PopDialogX\n    String  sTitle\n    Integer iMode');
  });

  it('summarises other declarations on one line instead of repeating the card', () => {
    // `psCaption` is declared 18 times across the Web UI. Rendering a second full card for the
    // next one produced something so nearly identical to the first that the hover read as having
    // duplicated itself.
    const text = declarationHover(
      facts({
        kind: 'property',
        name: 'psCaption',
        type: 'String',
        others: {
          count: 17,
          where: ['AppSrc/cWebButton.pkg', 'AppSrc/cWebCard.pkg', 'AppSrc/cWebCheckbox.pkg', 'x/y.pkg']
        }
      })
    );

    expect(text).toContain('**Also in** `AppSrc/cWebButton.pkg`, `AppSrc/cWebCard.pkg`, `AppSrc/cWebCheckbox.pkg` and 14 more');
    // The signature block must appear exactly once.
    expect(text.match(/Property String psCaption/g)).toHaveLength(1);
  });

  it('names them all when there are only a few', () => {
    const text = declarationHover(
      facts({ others: { count: 2, where: ['a/one.pkg', 'b/two.pkg'] } })
    );
    expect(text).toContain('**Also in** `a/one.pkg`, `b/two.pkg`  ');
    expect(text).not.toContain('more');
  });

  it('says nothing about others when the name is declared once', () => {
    expect(declarationHover(facts())).not.toContain('Also in');
  });

  it('links to the documentation when one was built', () => {
    const text = declarationHover(
      facts({ kind: 'class', name: 'cWebForm', docsUrl: 'https://docs.dataflex.dev/VdfClassRef/Web/cWebForm/' })
    );
    expect(text).toContain('](https://docs.dataflex.dev/VdfClassRef/Web/cWebForm/)');
  });
});

describe('docsUrlFor', () => {
  it('links a Web UI class', () => {
    expect(
      docsUrlFor({ kind: 'class', name: 'cWebForm', file: WEB_UI, workspaceOwned: false })
    ).toBe('https://docs.dataflex.dev/VdfClassRef/Web/cWebForm/');
  });

  it('links a Windows class from the installed library', () => {
    expect(
      docsUrlFor({ kind: 'class', name: 'dbForm', file: WINDOWS_PKG, workspaceOwned: false })
    ).toBe('https://docs.dataflex.dev/VdfClassRef/Windows/dbForm/');
  });

  it('never links a class the workspace declares', () => {
    // The user's own classes are not in the documentation, so a link here is a guaranteed 404 on
    // exactly the code they look at most.
    expect(
      docsUrlFor({ kind: 'class', name: 'cAppWebForm', file: OWN, workspaceOwned: true })
    ).toBeUndefined();
  });

  it('does not link a member whose owning class is unknown', () => {
    // The page is keyed by class. DataFlex has one flat namespace and `Refresh` is declared by
    // dozens of classes, so without an owner there is no page to choose.
    expect(
      docsUrlFor({ kind: 'procedure', name: 'Refresh', file: WEB_UI, workspaceOwned: false })
    ).toBeUndefined();
  });

  it('links a member through its owning class', () => {
    expect(
      docsUrlFor({
        kind: 'procedure',
        name: 'AppendNewRow',
        file: WEB_UI,
        workspaceOwned: false,
        ownerClass: 'cWebList'
      })
    ).toBe('https://docs.dataflex.dev/VdfClassRef/Web/cWebList-Procedure-AppendNewRow/');
  });

  it('uses the site casing, not the casing the source happened to use', () => {
    // DataFlex is case-insensitive, MkDocs is not: `is a datadictionary` must not 404.
    expect(
      docsUrlFor({ kind: 'class', name: 'datadictionary', file: WINDOWS_PKG, workspaceOwned: false })
    ).toBe('https://docs.dataflex.dev/VdfClassRef/WebAndWindows/DataDictionary/');
  });

  it('falls back to the class page when the member has no page of its own', () => {
    // `DataDictionary` is documented and `Save` is one of its methods, but
    // `DataDictionary-Procedure-Save` is a 404 -- the site documents a subset.
    expect(
      docsUrlFor({
        kind: 'procedure',
        name: 'Save',
        file: WINDOWS_PKG,
        workspaceOwned: false,
        ownerClass: 'DataDictionary'
      })
    ).toBe('https://docs.dataflex.dev/VdfClassRef/WebAndWindows/DataDictionary/');
  });

  it('covers the WebAndWindows section the old scraper never saw', () => {
    expect(docsPlatform('DataDictionary')).toBe('WebAndWindows');
  });
});

describe('docsEntryForCommand', () => {
  it('links a command, with the irregular stem the site actually uses', () => {
    // Not derivable: the page is `Saverecord_Command`, with a lower-case `r`.
    expect(docsEntryForCommand('SaveRecord')?.url).toBe(
      'https://docs.dataflex.dev/LanguageReference/Saverecord_Command/'
    );
  });

  it('prefers the command page when a word is also a function and a directive', () => {
    // `If_Command`, `If_Function` and `IF_Compiler_Directive` all exist.
    expect(docsEntryForCommand('If')?.url).toBe(
      'https://docs.dataflex.dev/LanguageReference/If_Command/'
    );
  });

  it('carries the summary the documentation gives', () => {
    expect(docsEntryForCommand('Clear')?.description).toBe(
      'To erase all data from the record buffers of one or more database tables.'
    );
  });

  it('says nothing about a word the documentation does not cover', () => {
    expect(docsEntryForCommand('NotARealDataFlexCommand')).toBeUndefined();
  });

  it('is disabled by an empty base URL', () => {
    expect(docsEntryForCommand('Save', '')).toBeUndefined();
  });

  it('does not link a library class the documentation does not cover', () => {
    // `Pkg` ships COM wrappers and internal helpers that have no documentation page. Deciding by
    // convention instead was dead 57% of the time when audited against the live site.
    expect(
      docsUrlFor({
        kind: 'class',
        name: 'cCrystalSections',
        file: WINDOWS_PKG,
        workspaceOwned: false
      })
    ).toBeUndefined();
  });

  it('is disabled by an empty base URL', () => {
    expect(
      docsUrlFor({ kind: 'class', name: 'cWebForm', file: WEB_UI, workspaceOwned: false, baseUrl: '' })
    ).toBeUndefined();
  });

  it('reads the section from the generated list, not from the class name', () => {
    // `Form` and `dbForm` are Windows classes, so no `cWeb*` rule could place them correctly.
    expect(docsPlatform('cWebForm')).toBe('Web');
    expect(docsPlatform('dbForm')).toBe('Windows');
    expect(docsPlatform('Form')).toBe('Windows');
    expect(docsPlatform('cNotADataFlexClass')).toBeUndefined();
  });

  it('matches the class name case-insensitively, as DataFlex does', () => {
    expect(docsPlatform('CWEBFORM')).toBe('Web');
  });
});

describe('tableHover', () => {
  const CUSTOMER = { table: 'Customer', tableNumber: 25, fieldCount: 15, where: 'DDSrc/Customer.fd' };

  it('describes a column with its type, position and table', () => {
    const text = tableHover({ ...CUSTOMER, field: { name: 'Name', type: 'String', number: 2 } });
    expect(text).toContain('String Customer.Name');
    expect(text).toContain('_Field 2 of table `Customer` (#25)_');
    expect(text).toContain('`DDSrc/Customer.fd`');
  });

  it('describes the table itself when the cursor is not on a column', () => {
    const text = tableHover(CUSTOMER);
    expect(text).toContain('_Database table #25, 15 fields_');
    expect(text).not.toContain('Field ');
  });

  it('does not say "1 fields"', () => {
    expect(tableHover({ ...CUSTOMER, fieldCount: 1 })).toContain('1 field_');
  });

  /** Column length and the SQL type behind it are in the database, not the `.fd`. */
  it('claims nothing the field definition does not state', () => {
    const text = tableHover({ ...CUSTOMER, field: { name: 'Name', type: 'String', number: 2 } });
    expect(text).not.toMatch(/length|varchar|nullable/i);
  });
});

describe('commandHover', () => {
  it('leads with what the command does, then links', () => {
    const text = commandHover({
      name: 'Save',
      summary: 'To save changes made to a record buffer.',
      docsUrl: 'https://docs.dataflex.dev/LanguageReference/Save_Command/'
    });
    expect(text).toContain('_DataFlex command_');
    expect(text).toContain('To save changes made to a record buffer.');
    expect(text).toContain('](https://docs.dataflex.dev/LanguageReference/Save_Command/)');
  });

  it('echoes the casing the author used', () => {
    const text = commandHover({ name: 'sAvE', docsUrl: 'https://x/' });
    expect(text).toContain('sAvE');
  });

  it('still links when the page carries no summary', () => {
    const text = commandHover({ name: 'Save', docsUrl: 'https://x/' });
    expect(text).toContain('](https://x/)');
  });
});

describe('the Manages row', () => {
  const DD: DeclarationFacts = {
    kind: 'class',
    name: 'cCustomerDataDictionary',
    file: 'C:\\ws\\DDSrc\\cCustomerDataDictionary.dd',
    where: 'DDSrc/cCustomerDataDictionary.dd',
    superClass: 'DataDictionary'
  };

  it('names the table a data dictionary manages', () => {
    const text = declarationHover({
      ...DD,
      manages: { table: 'Customer', number: 25, fieldCount: 15 }
    });
    expect(text).toContain('**Manages** `Customer` — table #25, 15 fields');
  });

  /** The DD states the table; the `.fd` file is what adds the counts, and may be absent. */
  it('names the table even when the workspace has no field definition for it', () => {
    const text = declarationHover({ ...DD, manages: { table: 'Customer' } });
    expect(text).toContain('**Manages** `Customer`');
    expect(text).not.toContain('table #');
  });

  it('says nothing for a class that manages no table', () => {
    expect(declarationHover(DD)).not.toContain('Manages');
  });
});

describe('struct rendering', () => {
  const BASE: DeclarationFacts = {
    kind: 'struct',
    name: 'tRow',
    file: 'C:\\ws\\x.pkg',
    where: 'ws/x.pkg'
  };

  it('renders the members as a struct body', () => {
    const text = declarationHover({
      ...BASE,
      fields: [
        { name: 'sName', type: 'String' },
        { name: 'iCount', type: 'Integer' }
      ]
    });
    expect(text).toContain('Struct tRow');
    expect(text).toContain('String  sName');
    expect(text).toContain('Integer iCount');
    expect(text).toContain('End_Struct');
  });

  /** A struct with no members is legal, and must not render an empty body or crash on the width. */
  it('renders a struct with no members as just its name', () => {
    const text = declarationHover({ ...BASE, fields: [] });
    expect(text).toContain('Struct tRow');
    expect(text).not.toContain('End_Struct');
  });

  it('elides a very long member list rather than owning the screen', () => {
    const fields = Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, type: 'String' }));
    const text = declarationHover({ ...BASE, fields });
    expect(text).toContain('f11');
    expect(text).not.toContain('f12 ');
    expect(text).toContain('// 8 more');
  });
});

/**
 * DataFlex composes as much by mixin as by inheritance: 30% of the classes on a real search path
 * import at least one, and `cWebApp` pulls in fourteen contributing over three hundred members.
 * None of that is in the `is a` chain, so a hover showing only the chain describes half the class.
 */
describe('the Mixes in row', () => {
  const CLASS_FACTS: DeclarationFacts = {
    kind: 'class',
    name: 'cComChilkatCrypt2',
    file: 'C:\\ws\\x.pkg',
    where: 'ws/x.pkg'
  };

  it('names the protocols a class mixes in', () => {
    const text = declarationHover({
      ...CLASS_FACTS,
      mixins: ['cComIChilkatCrypt2', 'cCom_IChilkatEvents']
    });
    expect(text).toContain('**Mixes in** `cComIChilkatCrypt2`, `cCom_IChilkatEvents`');
  });

  /** Mixin names run long, so the list is cut short and the remainder counted. */
  it('elides a long list rather than filling the hover', () => {
    const text = declarationHover({
      ...CLASS_FACTS,
      mixins: ['aMixin', 'bMixin', 'cMixin', 'dMixin', 'eMixin']
    });
    expect(text).toContain('`aMixin`, `bMixin`, `cMixin` … 2 more');
    expect(text).not.toContain('dMixin');
  });

  it('says nothing for a class that mixes in nothing', () => {
    expect(declarationHover(CLASS_FACTS)).not.toContain('Mixes in');
    expect(declarationHover({ ...CLASS_FACTS, mixins: [] })).not.toContain('Mixes in');
  });

  it('sits with the inheritance row, not in place of it', () => {
    const text = declarationHover({
      ...CLASS_FACTS,
      // Two, because a single ancestor is already on the header line and is not repeated.
      hierarchy: ['cBase', 'cRoot'],
      mixins: ['aMixin']
    });
    expect(text).toContain('**Inherits**');
    expect(text).toContain('**Mixes in**');
    expect(text.indexOf('**Inherits**')).toBeLessThan(text.indexOf('**Mixes in**'));
  });
});

describe('constants', () => {
  /**
   * The head shows the declaration as written; the rows say what it is worth. A value that the
   * head already shows is not repeated below it -- `Define C_Max for 100` followed by "Value 100"
   * reads as the hover stuttering.
   */
  it('renders a plain define with its type and no Value row', () => {
    const text = declarationHover(
      facts({ kind: 'define', name: 'C_Max', value: '100', constant: { value: 100, type: 'Integer' } })
    );
    expect(text).toContain('```dataflex\nDefine C_Max for 100\n```');
    expect(text).toContain('**Type** Integer');
    expect(text).not.toContain('**Value**');
  });

  it('shows what an alias resolves to', () => {
    const text = declarationHover(
      facts({
        kind: 'define',
        name: 'C_IconDefault',
        value: 'C_IconHistory',
        constant: { value: 'Images/History.png', type: 'String' }
      })
    );
    expect(text).toContain('Define C_IconDefault for C_IconHistory');
    expect(text).toContain('**Value** `"Images/History.png"`');
    expect(text).toContain('**Type** String');
  });

  it('shows an enum member its position', () => {
    const text = declarationHover(
      facts({
        kind: 'enumValue',
        name: 'alignRight',
        constant: { value: 2, type: 'Integer', fromEnum: true }
      })
    );
    expect(text).toContain('```dataflex\nDefine alignRight\n```');
    expect(text).toContain('**Value** `2` — position in its `Enum_List`');
    expect(text).toContain('**Type** Integer');
  });

  it('renders a directive as written', () => {
    const text = declarationHover(
      facts({
        kind: 'define',
        name: 'C_Replaced',
        value: '"text"',
        directive: '#REPLACE',
        constant: { value: 'text', type: 'String' }
      })
    );
    expect(text).toContain('```dataflex\n#REPLACE C_Replaced "text"\n```');
    expect(text).not.toContain('**Value**');
    expect(text).toContain('**Type** String');
  });

  it('spells a hexadecimal and a boolean out', () => {
    expect(
      declarationHover(
        facts({ kind: 'define', name: 'C_Flags', value: '|CI$FF', constant: { value: 255, type: 'Integer' } })
      )
    ).toContain('**Value** `255`');
    expect(
      declarationHover(
        facts({ kind: 'define', name: 'C_Yes', value: 'true', constant: { value: true, type: 'Boolean' } })
      )
    ).toContain('**Value** `True`');
  });

  it('says nothing about a value it could not resolve', () => {
    const text = declarationHover(facts({ kind: 'define', name: 'C_Computed', value: '(C_Wide * 2)' }));
    expect(text).toContain('Define C_Computed for (C_Wide * 2)');
    expect(text).not.toContain('**Value**');
    expect(text).not.toContain('**Type**');
  });

  it('renders a define with no value as just the name', () => {
    expect(declarationHover(facts({ kind: 'define', name: 'C_Flag' }))).toContain('```dataflex\nDefine C_Flag\n```');
  });
});
