/**
 * What a constant is worth, read off the index.
 *
 * A `Define` names a literal, or another `Define`, or sits in an `Enum_List` where its value is its
 * position. The index carries all three -- the text after `for`, and the position -- so a value
 * can be resolved without opening the declaring file, which is what lets the hover answer on a
 * mouse movement and the preview answer once for a whole view.
 *
 * Anything not understood is `undefined`, never a guess: an expression such as `(C_Width * 2)`
 * depends on rules this does not implement, and a wrong number is worse than none.
 */
import type { Declaration, SymbolIndex } from './symbolIndex';

/** What a constant can stand for. */
export type ConstantValue = string | number | boolean;

/** The DataFlex type a value would have, in the spelling a declaration uses. */
export type ConstantType = 'String' | 'Integer' | 'Number' | 'Boolean';

/** Value of the constant called `name`, following it through any constants it names in turn. */
export function constantValue(
  index: SymbolIndex,
  name: string,
  seen: Set<string> = new Set()
): ConstantValue | undefined {
  const declaration = index
    .lookup(name, 'any')
    .find((found) => found.kind === 'enumValue' || found.kind === 'define');
  return declaration === undefined ? undefined : declaredConstantValue(index, declaration, seen);
}

/**
 * Value of one constant declaration.
 *
 * `seen` holds the names already on the path, lower-cased, and is what stops `Define C_Loop for
 * C_Loop` -- which the compiler accepts -- from recursing: the second visit finds the name already
 * there and gives up on that branch.
 */
export function declaredConstantValue(
  index: SymbolIndex,
  declaration: Declaration,
  seen: Set<string> = new Set()
): ConstantValue | undefined {
  if (declaration.kind === 'enumValue') {
    return declaration.ordinal;
  }
  if (declaration.kind !== 'define') {
    return undefined;
  }

  const text = declaration.value?.trim() ?? '';
  const literal = literalValue(text);
  if (literal !== undefined) {
    return literal;
  }

  // An alias: `Define C_IconDefault for C_Icon_ShowHistory`.
  if (!/^[A-Za-z_][\w$]*$/.test(text)) {
    return undefined;
  }
  const own = declaration.name.toLowerCase();
  if (seen.has(own)) {
    return undefined;
  }
  seen.add(own);
  return constantValue(index, text, seen);
}

/**
 * The value a literal denotes, or `undefined` for anything that is not one.
 *
 * Applications use every form: numbers for sizes, strings for image paths, `True`/`False`, and
 * the compiler's own `|CI` / `|CS` spellings for an integer, a hexadecimal integer -- `|CI$FF` --
 * and a string. A bare name or an expression is not a literal and is left to the caller.
 */
export function literalValue(text: string): ConstantValue | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed[0] === '"' || trimmed[0] === "'" || /^@[A-Za-z]*["']/.test(trimmed)) {
    return unquote(trimmed);
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  const lower = trimmed.toLowerCase();
  if (lower === 'true') {
    return true;
  }
  if (lower === 'false') {
    return false;
  }

  const hex = /^\|CI\$([0-9A-Fa-f]{1,8})$/i.exec(trimmed);
  if (hex !== null) {
    return Number.parseInt(hex[1]!, 16);
  }
  const integer = /^\|CI(-?\d+)$/i.exec(trimmed);
  if (integer !== null) {
    return Number(integer[1]);
  }
  const string = /^\|CS(["'].*)$/i.exec(trimmed);
  if (string !== null) {
    return unquote(string[1]!);
  }
  return undefined;
}

/** The type a declaration would give `value`. */
export function constantType(value: ConstantValue): ConstantType {
  switch (typeof value) {
    case 'string':
      return 'String';
    case 'boolean':
      return 'Boolean';
    default:
      return Number.isInteger(value) ? 'Integer' : 'Number';
  }
}

/**
 * A string literal's contents.
 *
 * DataFlex has no escape character. A literal is delimited by matching quotes and may contain the
 * *other* quote freely; to embed a `"` you switch to `'`. So stripping the delimiters is the whole
 * job, and a doubled quote inside a literal is two quote characters, not one escaped one --
 * unescaping it would corrupt the JavaScript inside a `"""..."""` block.
 *
 * The multi-line forms are stripped too, since the lexer produces one token for each:
 * `"""..."""` and the `@"..."` / `@SQL"..."` prefixed forms.
 */
export function unquote(text: string): string {
  // `@"..."` and `@SQL"..."`: drop the prefix and fall through to the delimiter rules.
  const body = /^@[A-Za-z]*(["'])/.test(text) ? text.slice(text.search(/["']/)) : text;

  const quote = body[0];
  if (quote !== '"' && quote !== "'") {
    return body;
  }

  const triple = quote.repeat(3);
  if (body.startsWith(triple) && body.endsWith(triple) && body.length >= 6) {
    return body.slice(3, -3);
  }
  return body.endsWith(quote) && body.length > 1 ? body.slice(1, -1) : body.slice(1);
}
