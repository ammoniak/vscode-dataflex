import { SemanticTokensLegend } from 'vscode-languageserver';
import { SourceUnit, TokenKind, nodeChainAt } from '@vscode-dataflex/parser';
import type { SymbolIndex } from '@vscode-dataflex/workspace';

/**
 * Semantic tokens: the colours TextMate cannot work out on its own.
 *
 * The grammar decides by shape -- a word at the start of a line, a word after `is a` -- and that is
 * as far as a regular expression can reach. It cannot tell a class from a struct from a property,
 * because in DataFlex they look identical: bare identifiers in one flat namespace. The index can,
 * so this colours what is *known* and stays silent about the rest, leaving the grammar's answer in
 * place rather than overriding it with a guess.
 *
 * Deliberately narrow. Every token emitted here overrides the grammar, so a wrong one is worse
 * than none: it makes correct code look like something it is not.
 */

/** Token types this server emits, in the order the protocol indexes them. */
export const SEMANTIC_TOKEN_TYPES = [
  'class',
  'struct',
  'property',
  'method',
  'function',
  'variable',
  'parameter'
] as const;

/** Modifiers, likewise ordered. */
export const SEMANTIC_TOKEN_MODIFIERS = ['declaration', 'definitionLibrary'] as const;

export const SEMANTIC_TOKENS_LEGEND: SemanticTokensLegend = {
  tokenTypes: [...SEMANTIC_TOKEN_TYPES],
  tokenModifiers: ['declaration', 'defaultLibrary']
};

type TokenType = (typeof SEMANTIC_TOKEN_TYPES)[number];

const TYPE_INDEX = new Map<TokenType, number>(
  SEMANTIC_TOKEN_TYPES.map((name, index) => [name, index])
);

const DECLARATION_BIT = 1 << 0;
const DEFAULT_LIBRARY_BIT = 1 << 1;

/**
 * The token type a declaration kind paints.
 *
 * `object` deliberately has none: an object instance is already coloured by the grammar's
 * `Object oX is a cY` rule, and re-colouring every mention of `oCustomer_DD` as a variable would
 * fight it for no gain.
 */
const BY_KIND: ReadonlyMap<string, TokenType> = new Map([
  ['class', 'class'],
  ['struct', 'struct'],
  ['property', 'property'],
  ['procedure', 'method'],
  ['function', 'function'],
  ['variable', 'variable']
]);

/** One token in the flat encoding the protocol wants, before it is delta-compressed. */
interface Absolute {
  line: number;
  character: number;
  length: number;
  type: number;
  modifiers: number;
}

/**
 * Encodes tokens as the protocol's flat array of 5-tuples, each relative to the one before it.
 *
 * Sorted first: the deltas are meaningless unless the tokens are in document order, and the walk
 * that produced them is in token order only by accident.
 */
export function encode(tokens: Absolute[]): number[] {
  const sorted = [...tokens].sort((a, b) => a.line - b.line || a.character - b.character);
  const data: number[] = [];
  let lastLine = 0;
  let lastCharacter = 0;

  for (const token of sorted) {
    const deltaLine = token.line - lastLine;
    const deltaCharacter = deltaLine === 0 ? token.character - lastCharacter : token.character;
    data.push(deltaLine, deltaCharacter, token.length, token.type, token.modifiers);
    lastLine = token.line;
    lastCharacter = token.character;
  }
  return data;
}

/**
 * Semantic tokens for one document.
 *
 * Only identifiers the index knows, and only when every declaration of that name agrees on what it
 * is. DataFlex's flat namespace means `Refresh` is a method in 23 places; if a name were also a
 * class somewhere, colouring it either way would be wrong half the time, so it is left alone.
 */
export function semanticTokens(
  unit: SourceUnit,
  index: SymbolIndex | undefined,
  options: { root?: string } = {}
): number[] {
  if (index === undefined) {
    return [];
  }

  const resolved = new Map<string, { type: number; library: boolean } | undefined>();
  const tokens: Absolute[] = [];

  for (const token of unit.tokens) {
    if (token.kind !== TokenKind.Identifier || token.text.includes('.')) {
      continue;
    }
    const key = token.text.toLowerCase();

    if (!resolved.has(key)) {
      resolved.set(key, classify(index, token.text, options.root));
    }
    const answer = resolved.get(key);
    if (answer === undefined) {
      continue;
    }

    const declaration = isDeclarationSite(unit, token.range.start.line, token.range.start.character);
    tokens.push({
      line: token.range.start.line,
      character: token.range.start.character,
      length: token.text.length,
      type: answer.type,
      modifiers:
        (declaration ? DECLARATION_BIT : 0) | (answer.library ? DEFAULT_LIBRARY_BIT : 0)
    });
  }

  return encode(tokens);
}

/** The one token type every declaration of this name agrees on, or `undefined`. */
function classify(
  index: SymbolIndex,
  name: string,
  root: string | undefined
): { type: number; library: boolean } | undefined {
  const declarations = index.lookup(name);
  if (declarations.length === 0) {
    return undefined;
  }

  let type: TokenType | undefined;
  for (const declaration of declarations) {
    const candidate = BY_KIND.get(declaration.kind);
    if (candidate === undefined) {
      return undefined;
    }
    if (type === undefined) {
      type = candidate;
    } else if (type !== candidate) {
      // The name means different things in different places; the grammar's guess is as good.
      return undefined;
    }
  }
  if (type === undefined) {
    return undefined;
  }

  const library =
    root !== undefined &&
    declarations.every((entry) => !entry.file.toLowerCase().startsWith(root.toLowerCase()));

  return { type: TYPE_INDEX.get(type)!, library };
}

/** True when this position is the name in its own declaration, rather than a use of it. */
function isDeclarationSite(unit: SourceUnit, line: number, character: number): boolean {
  const chain = nodeChainAt(unit.root, line, character);
  const node = chain[chain.length - 1];
  return (
    node?.nameRange !== undefined &&
    node.nameRange.start.line === line &&
    node.nameRange.start.character === character
  );
}
