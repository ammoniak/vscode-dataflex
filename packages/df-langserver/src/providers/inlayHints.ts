import { InlayHint, InlayHintKind, Range } from 'vscode-languageserver';
import { DfNode, SourceUnit, callArguments, walk } from '@vscode-dataflex/parser';
import type { Declaration, SymbolIndex } from '@vscode-dataflex/workspace';

/**
 * Parameter-name hints at call sites.
 *
 * `Send PopupOrderCustomerLookup Self "" "" "" "" ""` is real code from a real workspace, and there
 * is nothing in it to say what any of those arguments are. DataFlex passes positionally with no
 * punctuation and has no named-argument syntax, so the call site carries strictly less information
 * than in most languages -- the same reason `argument-count` finds real bugs.
 *
 * Hints are drawn only where they add something. A hint repeating what the reader can already see
 * is noise, and inlay hints are drawn *inside* the code: too many make it unreadable.
 */

/** Hints are only worth drawing on a call with at least this many arguments. */
const MIN_ARGUMENTS = 2;

/** Longest parameter name rendered before it is shortened; a long hint pushes the code around. */
const MAX_LABEL = 20;

export interface InlayHintOptions {
  /** Off by default: drawing inside the code is a strong preference, not a sensible default. */
  enabled?: boolean;
  /**
   * Hide the hint when the argument already carries the parameter's name.
   *
   * On by default, matching TypeScript's `suppressWhenArgumentMatchesName`, because
   * `sCustomerAccount: sCustomerAccount` says nothing. The cost is an asymmetry that reads as a
   * bug: a real call passing `Self sCustomerAccount sSearchName` to
   * `hReturnObj sCustomerAccount sSearchName` shows exactly one hint, and it looks like the other
   * two failed. Turning this off labels every argument.
   */
  suppressWhenArgumentMatchesName?: boolean;
}

/**
 * True when the hint would only repeat the argument.
 *
 * `Send Configure sName` with a parameter also called `sName` gains nothing from a `sName:` label,
 * and the same goes for `psCaption` passed to `psCaption`. Case-insensitive, because DataFlex is.
 */
function repeatsArgument(parameter: string, argument: string): boolean {
  const p = parameter.toLowerCase();
  const a = argument.toLowerCase().replace(/^[&#]/, '');
  return p === a || a.endsWith(p) || p.endsWith(a);
}

function shorten(name: string): string {
  return name.length <= MAX_LABEL ? name : `${name.slice(0, MAX_LABEL - 1)}...`;
}

/**
 * The declaration whose parameters name this call's arguments.
 *
 * DataFlex's flat namespace means a name is declared many times over, so a hint is drawn only when
 * every declaration that could take this many arguments agrees on what they are called. Guessing
 * between two signatures would label an argument with the wrong name, which is worse than no label
 * at all: the reader has no way to tell that it is wrong.
 */
function agreedSignature(
  index: SymbolIndex,
  name: string,
  argumentCount: number
): Declaration | undefined {
  const candidates = index
    .lookup(name)
    .filter(
      (entry) =>
        (entry.kind === 'procedure' || entry.kind === 'function') && (entry.params?.length ?? 0) > 0
    );
  if (candidates.length === 0) {
    return undefined;
  }

  // Compared over the arguments actually passed *and* declared, not over the whole signature.
  // Requiring the signature to cover every argument refused the calls that need help most: a real
  // one passes seven arguments to a two-parameter method, and naming the two it does declare is
  // precisely the information that makes the mistake visible.
  const shape = (entry: Declaration): string => {
    const params = entry.params ?? [];
    return params
      .slice(0, Math.min(argumentCount, params.length))
      .map((param) => param.name.toLowerCase())
      .join(',');
  };
  const wanted = shape(candidates[0]!);
  return candidates.every((entry) => shape(entry) === wanted) ? candidates[0]! : undefined;
}

/** Inlay hints for one document, restricted to the range the editor asked about. */
export function inlayHints(
  unit: SourceUnit,
  index: SymbolIndex | undefined,
  range: Range,
  options: InlayHintOptions = {}
): InlayHint[] {
  if (index === undefined || options.enabled !== true) {
    return [];
  }

  const suppressMatching = options.suppressWhenArgumentMatchesName !== false;
  const hints: InlayHint[] = [];

  walk(unit.root, (node: DfNode) => {
    if (node.kind !== 'statement') {
      return undefined;
    }
    const line = node.headerRange.start.line;
    if (line < range.start.line || line > range.end.line) {
      return undefined;
    }

    const call = callArguments(unit, node);
    // `imprecise` means a fragment did not parse, so the arguments cannot be trusted to line up
    // with the parameters -- exactly the case where a wrong label would be invisible.
    if (call === undefined || call.imprecise || call.args.length < MIN_ARGUMENTS) {
      return undefined;
    }

    const declaration = agreedSignature(index, call.target, call.args.length);
    if (declaration === undefined) {
      return undefined;
    }

    const params = declaration.params ?? [];
    for (let at = 0; at < call.args.length && at < params.length; at++) {
      const argument = call.args[at]!;
      const parameter = params[at]!;
      if (suppressMatching && repeatsArgument(parameter.name, argument.text)) {
        continue;
      }
      hints.push({
        position: argument.range.start,
        label: `${shorten(parameter.name)}:`,
        kind: InlayHintKind.Parameter,
        paddingRight: true
      });
    }
    return undefined;
  });

  return hints;
}
