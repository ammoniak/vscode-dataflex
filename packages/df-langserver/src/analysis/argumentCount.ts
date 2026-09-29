import { DfNode, SourceUnit, callArguments, walk } from '@vscode-dataflex/parser';
import { Range } from 'vscode-languageserver';

/**
 * Reports call sites that pass the wrong number of arguments.
 *
 * DataFlex will happily compile `Send Foo 1` against `Procedure Foo Integer a String b`: the
 * missing argument is simply not passed, and the callee reads whatever the parameter defaults to.
 * That is legal and occasionally deliberate, which is why the check is gated on the one thing that
 * distinguishes the two cases -- whether the callee inspects `num_arguments`.
 */

/** What the workspace index can say about a message name. */
export interface CalleeArity {
  /** Declared parameter count, when every declaration of the name agrees on one. */
  paramCount: number;
  /** How many declarations that answer came from, for the message. */
  declarations: number;
}

/**
 * Resolves a message name to a checkable arity.
 *
 * Returns `undefined` whenever the answer is not certain, and every uncertain case must return
 * `undefined` rather than a guess: DataFlex dispatches dynamically, so a wrong answer here is a
 * false positive on correct code.
 */
export type ResolveArity = (name: string) => CalleeArity | undefined;

/** The slice of the workspace index this rule needs. */
export interface ArityIndex {
  lookup(name: string): {
    kind: string;
    file: string;
    paramCount?: number;
    inspectsArgumentCount?: boolean;
  }[];
}

/**
 * Builds the resolver from a workspace index.
 *
 * Four guards, each answering `undefined`, and each earned from a false positive on real code:
 *
 *  - **Nothing declares the name.** Nothing to compare against.
 *  - **A declaration reads `num_arguments`.** That is how DataFlex writes an optional parameter,
 *    so callers legitimately pass fewer.
 *  - **Declarations disagree on arity.** Several classes may declare the same message; dispatch
 *    picks at runtime, so no single answer is right.
 *  - **No declaration is the workspace's own.** This one matters most. `Send DefineParam to
 *    hDispatchDriver` addresses an OLE dispatch object that handles the message dynamically, with
 *    no declaration anywhere -- yet the name happens to match a private 7-parameter method of an
 *    unrelated framework class, which produced 4,486 confident and entirely wrong findings.
 *    Framework declarations still count for the agreement check above, so a name the user and the
 *    runtime both declare is still vetoed; they just cannot be the sole basis for reporting.
 */
export function makeArityResolver(
  index: ArityIndex,
  isOwnFile: (file: string) => boolean
): ResolveArity {
  return (name) => {
    const methods = index
      .lookup(name)
      .filter((declaration) => declaration.kind === 'procedure' || declaration.kind === 'function');
    if (methods.length === 0) {
      return undefined;
    }
    if (methods.some((declaration) => declaration.inspectsArgumentCount === true)) {
      return undefined;
    }
    const counts = new Set(methods.map((declaration) => declaration.paramCount ?? -1));
    if (counts.size !== 1) {
      return undefined;
    }
    const [only] = counts;
    if (only === undefined || only < 0) {
      return undefined;
    }
    if (!methods.some((declaration) => isOwnFile(declaration.file))) {
      return undefined;
    }
    return { paramCount: only, declarations: methods.length };
  };
}

/**
 * Verbs whose arguments this rule counts.
 *
 * `Set` and `WebSet` are deliberately absent. Their value follows `to` (`Set psCaption to "x"`),
 * so the argument list before it is empty and every setter call would look like it was missing an
 * argument.
 */
const CHECKED_VERBS = new Set(['send', 'get', 'webget', 'broadcast', 'delegate']);

export interface ArgumentCountFinding {
  range: Range;
  message: string;
}

/** Finds argument-count mismatches in one file. */
export function findArgumentCountMismatches(
  unit: SourceUnit,
  resolve: ResolveArity
): ArgumentCountFinding[] {
  const findings: ArgumentCountFinding[] = [];

  walk(unit.root, (node: DfNode) => {
    if (node.kind !== 'statement' || node.verb === undefined || !CHECKED_VERBS.has(node.verb)) {
      return;
    }

    const call = callArguments(unit, node);
    if (call === undefined || call.imprecise) {
      // A fragment the expression layer could not model means the count is not trustworthy, and
      // an untrustworthy count must never produce a diagnostic.
      return;
    }

    const arity = resolve(call.target);
    if (arity === undefined || arity.paramCount === call.args.length) {
      return;
    }

    const passed = call.args.length;
    const expected = arity.paramCount;
    const head =
      `'${call.target}' takes ${args(expected)} but ${passed} ${passed === 1 ? 'is' : 'are'} passed here.`;
    const missing = expected - passed;
    const tail =
      missing > 0
        ? ` The missing ${missing === 1 ? 'one' : 'ones'} will not be set, and '${call.target}' does not ` +
          'check num_arguments, so it reads them regardless.'
        : ` The extra ${-missing === 1 ? 'one is' : 'ones are'} ignored.`;

    findings.push({ range: node.targetRange ?? node.headerRange, message: head + tail });
  });

  return findings;
}

function args(count: number): string {
  return count === 1 ? '1 argument' : `${count} arguments`;
}
