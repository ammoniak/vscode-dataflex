import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_TYPES, STATEMENT_VERBS } from '@vscode-dataflex/parser';
import * as oniguruma from 'vscode-oniguruma';
import * as textmate from 'vscode-textmate';

/**
 * Tokenises DataFlex with the real TextMate grammar, using the same engine VS Code does.
 *
 * Highlighting is otherwise only verifiable by eye, and a grammar regression (a rule that stops
 * matching, or one that swallows the rest of the file) is both easy to introduce and hard to
 * spot in a screenshot.
 */
const GRAMMAR_PATH = join(__dirname, '..', 'syntaxes', 'dataflex.tmLanguage.json');
const SCOPE = 'source.dataflex';

let grammar: textmate.IGrammar;

beforeAll(async () => {
  const wasm = readFileSync(
    join(__dirname, '..', '..', '..', 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm')
  );
  await oniguruma.loadWASM(wasm.buffer as ArrayBuffer);

  const registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
      createOnigString: (str) => new oniguruma.OnigString(str)
    }),
    loadGrammar: async (scopeName) => {
      if (scopeName !== SCOPE) {
        return null;
      }
      return textmate.parseRawGrammar(readFileSync(GRAMMAR_PATH, 'utf8'), GRAMMAR_PATH);
    }
  });

  const loaded = await registry.loadGrammar(SCOPE);
  expect(loaded).not.toBeNull();
  grammar = loaded!;
});

/** Returns [text, scopes] pairs for every token on `line`, in order. */
function tokenize(line: string, previous?: textmate.StateStack) {
  const result = grammar.tokenizeLine(line, previous ?? textmate.INITIAL);
  return {
    tokens: result.tokens.map((token) => ({
      text: line.slice(token.startIndex, token.endIndex),
      scopes: token.scopes
    })),
    state: result.ruleStack
  };
}

/** The scopes applied to the first token whose text is exactly `text`. */
function scopesOf(line: string, text: string): string[] {
  const token = tokenize(line).tokens.find((t) => t.text === text);
  if (token === undefined) {
    throw new Error(
      `no token "${text}" in: ${tokenize(line)
        .tokens.map((t) => JSON.stringify(t.text))
        .join(' ')}`
    );
  }
  return token.scopes;
}

function hasScope(line: string, text: string, scope: string): boolean {
  return scopesOf(line, text).some((s) => s.startsWith(scope));
}

describe('DataFlex TextMate grammar', () => {
  it('scopes an object declaration and its class', () => {
    const line = '    Object oCustomerCity is a cWebForm';
    expect(hasScope(line, 'Object', 'keyword.other.object')).toBe(true);
    expect(hasScope(line, 'oCustomerCity', 'entity.name.variable.object')).toBe(true);
    expect(hasScope(line, 'cWebForm', 'entity.name.type.class')).toBe(true);
  });

  it('scopes a class declaration and its parent', () => {
    const line = 'Class cWebForm is a cWebBaseDEO';
    expect(hasScope(line, 'cWebForm', 'entity.name.type.class')).toBe(true);
    expect(hasScope(line, 'cWebBaseDEO', 'entity.other.inherited-class')).toBe(true);
  });

  it('scopes WebSet distinctly from Set', () => {
    expect(hasScope('WebSet psValue of oX to sVal', 'WebSet', 'keyword.other.webproperty')).toBe(true);
    expect(hasScope('    Set psLabel to "Name:"', 'Set', 'keyword.other.message')).toBe(true);
    expect(hasScope('    Set psLabel to "Name:"', 'psLabel', 'variable.other.property')).toBe(true);
  });

  it('scopes the { Tag=Value } annotation form', () => {
    const line = '    { WebProperty=Client }';
    expect(hasScope(line, 'WebProperty', 'entity.other.attribute-name')).toBe(true);
    expect(scopesOf(line, 'WebProperty')).toContain('meta.annotation.dataflex');
  });

  it('scopes a property declaration', () => {
    const line = '    Property String psPlaceHolder ""';
    expect(hasScope(line, 'Property', 'storage.type.property')).toBe(true);
    expect(hasScope(line, 'String', 'storage.type')).toBe(true);
    expect(hasScope(line, 'psPlaceHolder', 'variable.other.property')).toBe(true);
  });

  it('scopes the Procedure Set setter form with the property as the name', () => {
    const line = '    Procedure Set Auto_Locate_State Integer iState';
    expect(hasScope(line, 'Procedure', 'storage.type.function')).toBe(true);
    expect(hasScope(line, 'Auto_Locate_State', 'entity.name.function')).toBe(true);
  });

  it('scopes a function signature with for/Returns', () => {
    const line = 'Function Main_Panel_Id for cDesktop Returns Integer';
    expect(hasScope(line, 'Main_Panel_Id', 'entity.name.function')).toBe(true);
    expect(hasScope(line, 'cDesktop', 'entity.name.type.class')).toBe(true);
    expect(hasScope(line, 'Integer', 'storage.type')).toBe(true);
  });

  it('is case-insensitive, as the language is', () => {
    expect(hasScope('OBJECT oX IS A cWebView', 'OBJECT', 'keyword.other.object')).toBe(true);
    expect(hasScope('object oX is a cWebView', 'object', 'keyword.other.object')).toBe(true);
  });

  it('scopes preprocessor directives and macro arguments', () => {
    expect(hasScope('#IFDEF Is$WebApp', '#IFDEF', 'keyword.control.directive.conditional')).toBe(true);
    expect(hasScope('#COMMAND Activate_View R', '#COMMAND', 'keyword.control.directive')).toBe(true);
    expect(hasScope('    Register_Object !3', '!3', 'variable.parameter.preprocessor')).toBe(true);
  });

  it('does not let an unterminated string swallow the following line', () => {
    // DataFlex string literals cannot span lines; a runaway string rule would grey out the file.
    const first = tokenize('Set psLabel to "oops');
    const second = tokenize('Object oX is a cWebView', first.state);
    expect(second.tokens.find((t) => t.text === 'Object')!.scopes).toEqual(
      expect.arrayContaining([expect.stringMatching(/^keyword\.other\.object/)])
    );
  });

  it('carries a block comment across lines and then stops', () => {
    const first = tokenize('/* prose');
    const second = tokenize('still prose', first.state);
    expect(second.tokens[0]!.scopes).toContain('comment.block.dataflex');

    const third = tokenize('*/', second.state);
    const fourth = tokenize('Class cIniProcessor is a cObject', third.state);
    expect(fourth.tokens.find((t) => t.text === 'cIniProcessor')!.scopes).toEqual(
      expect.arrayContaining([expect.stringMatching(/^entity\.name\.type\.class/)])
    );
  });

  it('carries a prefixed multi-line string across lines and then stops', () => {
    // `@SQL"""` blocks are common in real views; a grammar that ends the literal on the opening
    // quote highlights the embedded SQL as DataFlex code and never recovers.
    let state = tokenize('    Move @SQL"""').state;
    const sql = tokenize('        SELECT Betrag FROM Kassabuch', state);
    expect(sql.tokens[0]!.scopes).toContain('string.quoted.triple.dataflex');

    state = tokenize('    """ to sSQLStatement', sql.state).state;
    const after = tokenize('Object oX is a cWebView', state);
    expect(after.tokens.find((t) => t.text === 'Object')!.scopes).toEqual(
      expect.arrayContaining([expect.stringMatching(/^keyword\.other\.object/)])
    );
  });

  it('carries an @"..." multi-line string across lines', () => {
    const first = tokenize('Set psTooltipText to (@"[bold]Kunden');
    const middle = tokenize('● Total: {kunden}', first.state);
    expect(middle.tokens[0]!.scopes).toContain('string.quoted.double.multiline.dataflex');

    const state = tokenize('● A: {a}")', middle.state).state;
    const after = tokenize('End_Object', state);
    expect(after.tokens.find((t) => t.text === 'End_Object')!.scopes).toEqual(
      expect.arrayContaining([expect.stringMatching(/^keyword\.other\.block/)])
    );
  });

  it('scopes a line comment', () => {
    expect(hasScope('    Set piColumnCount to 10 // wide', '// wide', 'comment.line')).toBe(true);
  });

  it('leaves no token unscoped beyond the root in a realistic view', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', '..', 'fixtures', 'WebCustomer.wo'),
      'utf8'
    ).split(/\r?\n/);

    let state: textmate.StateStack = textmate.INITIAL;
    let scoped = 0;
    let total = 0;
    for (const line of source) {
      const result = grammar.tokenizeLine(line, state);
      state = result.ruleStack;
      for (const token of result.tokens) {
        if (line.slice(token.startIndex, token.endIndex).trim().length === 0) {
          continue;
        }
        total++;
        if (token.scopes.length > 1) {
          scoped++;
        }
      }
    }
    // Operators, keywords, names, literals and comments should all carry a scope; a few bare
    // identifiers (statement arguments) legitimately do not.
    expect(total).toBeGreaterThan(50);
    expect(scoped / total).toBeGreaterThan(0.75);
  });
});

/**
 * Every statement verb and every built-in type must get a scope.
 *
 * This is the guard on `scripts/sync-grammar.ts`. The grammar and `keywords.ts` used to be
 * independent lists and drifted: `Save`, `SaveRecord`, `Delete`, `Clear` and `Find` were verbs
 * the parser understood while the grammar left them unhighlighted. Adding a verb to
 * `keywords.ts` now fails here until `npm run grammar-sync` has been run.
 */
describe('grammar covers the parser keyword tables', () => {
  /** The scope a verb gets when it leads a statement, or undefined when it gets none. */
  function verbScope(word: string): string | undefined {
    const line = `    ${word} Something`;
    const token = tokenize(line).tokens.find((t) => t.text.toLowerCase() === word);
    return token?.scopes.find((scope) => scope !== SCOPE);
  }

  it('scopes every entry of STATEMENT_VERBS', () => {
    const unscoped = [...STATEMENT_VERBS].filter((verb) => verbScope(verb) === undefined);
    expect(unscoped).toEqual([]);
  });

  it('scopes the verbs that were missing before the generator existed', () => {
    for (const verb of ['save', 'saverecord', 'delete', 'clear', 'find']) {
      expect(verbScope(verb)).toBeDefined();
    }
  });

  it('scopes every entry of BUILTIN_TYPES', () => {
    const unscoped = [...BUILTIN_TYPES].filter(
      (type) => !hasScope(`    ${type} xValue`, type, 'storage.type')
    );
    expect(unscoped).toEqual([]);
  });

  /**
   * `Set`, `Get` and `Send` used to be anchored to the start of the line, so a verb after any
   * leading token was left unscoped. DataFlex allows both on one line.
   */
  it('scopes a message verb that is not the first word on the line', () => {
    expect(hasScope('    If (bOk) Send DoIt', 'Send', 'keyword.other.message')).toBe(true);
    expect(hasScope('    If (bOk) Set piValue to 1', 'Set', 'keyword.other.message')).toBe(true);
  });

  /**
   * A word boundary must keep `Set` from matching inside a longer identifier.
   *
   * Un-anchoring `Set`/`Get` made this reachable: without the word boundary, `(Set|Get)\s+` finds
   * the `set` inside `Offset` and would colour half a property name.
   */
  it('does not scope a verb spelled inside a longer identifier', () => {
    // Unmatched text comes back as one whole-line token, so assert on the scopes present rather
    // than looking the word up.
    const scopes = tokenize('    Offset psCaption').tokens.flatMap((t) => t.scopes);
    expect(scopes.filter((scope) => scope.startsWith('keyword'))).toEqual([]);
  });
});
