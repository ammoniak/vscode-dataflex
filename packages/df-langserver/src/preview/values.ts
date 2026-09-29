/**
 * Turning a DataFlex value expression into something the web framework can be handed.
 *
 * `initJSON` sets published properties straight onto the JavaScript control, so the value has to
 * arrive as the JSON type the framework expects: a string, a number, or a boolean. Source says
 * `Set peLabelAlign to alignRight`, and the framework wants `2`.
 *
 * That is the whole difficulty. The DataFlex and JavaScript sides of the framework name their
 * constants differently -- `alignRight` here, `df.ciAlignRight` there -- and agree only on the
 * numbers, so the name cannot simply be forwarded. The number lives in the position of a bare
 * `Define` inside an `Enum_List`, which is why constants are resolved through the workspace index
 * (`constantValues.ts` in the workspace package, shared with the hover) rather than a lookup table
 * that would go stale the moment the Web UI package is updated.
 *
 * Anything not understood returns `undefined` and is then omitted from the definition entirely,
 * never guessed at and never sent as `null`. The class default applies instead and the control
 * still draws; the alternative is a control that renders wrong in a way nobody can see.
 */
import { Token, TokenKind, parseSource } from '@vscode-dataflex/parser';
import type { SourceUnit } from '@vscode-dataflex/parser';
import { SymbolIndex, constantValue, readSourceFile, unquote } from '@vscode-dataflex/workspace';

/** What a published property can be set to in a definition. */
export type PreviewValue = string | number | boolean;

/**
 * Resolves value expressions, caching what it has to look up or parse to do so.
 *
 * One instance per preview build: a view names the same handful of constants over and over, and
 * the class bodies read for their defaults are the same few package files for every object.
 */
export class ValueResolver {
  private readonly units = new Map<string, SourceUnit | undefined>();
  private readonly constants = new Map<string, PreviewValue | undefined>();

  /**
   * `readFile` exists so this can be tested without a disk.
   *
   * Class bodies are read for their `Construct_Object` defaults, and the index knows the path but
   * not the text. Defaulting to `readSourceFile` keeps every caller in the server unchanged; a
   * test hands over a map of files it made up.
   */
  constructor(
    private readonly index: SymbolIndex,
    private readonly readFile: (path: string) => string | undefined = readSourceFile
  ) {}

  /**
   * The value the tokens denote, or `undefined` when it cannot be known statically.
   *
   * Deliberately narrow. A view's property values are overwhelmingly literals and constants; an
   * expression like `Set psCaption to (Trim(sName))` depends on data that does not exist at design
   * time, so there is nothing to resolve and pretending otherwise would be worse than leaving it.
   */
  resolve(tokens: readonly Token[]): PreviewValue | undefined {
    if (tokens.length === 1) {
      return this.single(tokens[0]!);
    }
    // `Set piWidth to -1`: the lexer gives the sign as its own punctuation token.
    if (tokens.length === 2 && tokens[0]!.text === '-' && tokens[1]!.kind === TokenKind.Number) {
      const magnitude = Number(tokens[1]!.text);
      return Number.isFinite(magnitude) ? -magnitude : undefined;
    }
    return undefined;
  }

  private single(token: Token): PreviewValue | undefined {
    if (token.kind === TokenKind.String) {
      return unquote(token.text);
    }
    if (token.kind === TokenKind.Number) {
      const value = Number(token.text);
      return Number.isFinite(value) ? value : undefined;
    }
    if (token.kind !== TokenKind.Identifier) {
      return undefined;
    }

    const lower = token.text.toLowerCase();
    if (lower === 'true') {
      return true;
    }
    if (lower === 'false') {
      return false;
    }
    return this.constantValue(token.text);
  }

  /**
   * Value of a `Define`, whether it stands alone or sits in an `Enum_List`.
   *
   * Cached including the misses: a name that is not a constant is asked about once per occurrence
   * otherwise, and each miss is an index lookup that returns nothing.
   */
  private constantValue(name: string): PreviewValue | undefined {
    const key = name.toLowerCase();
    if (this.constants.has(key)) {
      return this.constants.get(key);
    }
    const value = constantValue(this.index, name);
    this.constants.set(key, value);
    return value;
  }

  /**
   * The parsed contents of a file, from the cache when it is already there.
   *
   * Public because the model builder reads class bodies for their `Construct_Object` defaults and
   * would otherwise re-parse the same handful of package files for every object in a view.
   */
  unitOf(file: string): SourceUnit | undefined {
    return this.unitFor(file);
  }

  private unitFor(file: string): SourceUnit | undefined {
    if (this.units.has(file)) {
      return this.units.get(file);
    }
    const text = this.readFile(file);
    const unit = text === undefined ? undefined : parseSource(text, { uri: file });
    this.units.set(file, unit);
    return unit;
  }
}

/**
 * Forces a value to the type the property was declared with.
 *
 * DataFlex converts on assignment, so `Set psValue to 5000` puts the *string* "5000" into a String
 * property and nobody writing the view thinks twice about it. The framework does not convert: it
 * casts by the type the JavaScript class registered, and a property it did not register is
 * assigned raw. Handing it the number 5000 gets as far as rendering and then throws
 * `e.trim is not a function` from inside the framework -- one bad value, and the whole view is
 * blank. `WebOrder`'s own `OrderListSample.wo` does exactly this.
 *
 * An unknown or unrecognised type is left alone: a `Handle` or a `RowID` means nothing here, and
 * guessing at one is how the last bug got in.
 */
export function coerce(value: PreviewValue, declaredType: string | undefined): PreviewValue {
  switch (declaredType?.toLowerCase()) {
    case 'string':
    case 'char':
      return typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
    case 'integer':
    case 'uinteger':
    case 'number':
    case 'bigint':
    case 'ubigint':
    case 'short': {
      if (typeof value === 'number') {
        return value;
      }
      const parsed = Number(typeof value === 'boolean' ? (value ? 1 : 0) : value);
      return Number.isFinite(parsed) ? parsed : value;
    }
    case 'boolean':
      // The framework's own rule, from df.toBool: "0", "-1" and "false" are the false values, and
      // -1 is false because it is what C_WebDefault uses for "not set".
      return typeof value === 'boolean'
        ? value
        : value === 0 || value === -1 || value === '0' || value === '-1' || value === 'false'
          ? false
          : Boolean(value);
    default:
      return value;
  }
}
