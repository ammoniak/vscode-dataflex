import { Position, SignatureHelp, SignatureInformation } from 'vscode-languageserver';
import { DfNode, SourceUnit, callArguments, walk } from '@vscode-dataflex/parser';
import type { Declaration, SymbolIndex } from '@vscode-dataflex/workspace';
import { callSyntax } from './hoverContent';

/**
 * Signature help for `Send`, `Get` and `Set`.
 *
 * DataFlex passes arguments positionally with no punctuation at all -- `Send DoIt a b c` -- so
 * there is nothing on the line to remind the author what the third argument is meant to be. That
 * is also why `argument-count` finds real mistakes: the language gives no feedback at the call
 * site. This is the same information, offered before the mistake instead of after.
 *
 * The call is parsed with the same `callArguments` the arity rule uses, so the two agree about
 * what counts as an argument. That matters more than it sounds: `to` means the receiver in
 * `Send DefineParam to hDriver x y` and the destination in `Get Sum 1 2 to iTotal`, and reading it
 * the wrong way once made a generated wrapper look like 4,486 defects.
 */

/** Distinct signatures offered at once. DataFlex's flat namespace repeats names heavily. */
const MAX_SIGNATURES = 5;

function signatureOf(declaration: Declaration): SignatureInformation | undefined {
  const label = callSyntax({
    kind: declaration.kind,
    name: declaration.name,
    file: declaration.file,
    where: '',
    params: declaration.params,
    type: declaration.type,
    isSetter: declaration.isSetter
  });
  if (label === undefined) {
    return undefined;
  }

  // Each parameter is located in the label by name, so the editor can bold the active one.
  const parameters = (declaration.params ?? []).map((param) => ({
    label: param.name,
    documentation: param.type === undefined ? undefined : `${param.type}${param.byRef ? ' ByRef' : ''}`
  }));

  return {
    label,
    documentation: declaration.doc,
    parameters
  };
}

/**
 * The statement the cursor is writing on this line.
 *
 * Found by line rather than by containment, because the cursor is normally *past* the last token:
 * `Send Configure ` with the caret after the space is exactly when this feature is wanted, and a
 * node's range ends at `Configure`. Asking which node contains the position finds the enclosing
 * procedure and no call at all.
 */
function statementOnLine(unit: SourceUnit, position: Position): DfNode | undefined {
  let found: DfNode | undefined;
  walk(unit.root, (node) => {
    if (
      node.kind === 'statement' &&
      node.headerRange.start.line === position.line &&
      node.headerRange.start.character <= position.character
    ) {
      found = node;
    }
  });
  return found;
}

/**
 * Which argument the cursor is on.
 *
 * Counted from the arguments already closed before it, so a cursor sitting in whitespace after
 * two arguments is writing the third. `imprecise` calls are still counted: a half-typed argument
 * is exactly the situation this feature exists for, and refusing to answer then would mean it
 * only worked once the line was already finished.
 */
export function activeParameterAt(args: readonly { range: { end: Position } }[], position: Position): number {
  let active = 0;
  for (const arg of args) {
    const end = arg.range.end;
    const before =
      end.line < position.line || (end.line === position.line && end.character < position.character);
    if (before) {
      active++;
    }
  }
  return active;
}

export function signatureHelp(
  unit: SourceUnit,
  position: Position,
  index: SymbolIndex | undefined
): SignatureHelp | undefined {
  if (index === undefined) {
    return undefined;
  }

  const node = statementOnLine(unit, position);
  if (node === undefined) {
    return undefined;
  }

  const call = callArguments(unit, node);
  if (call === undefined) {
    return undefined;
  }

  // Only things that take arguments. A property read has none, and offering an empty signature
  // pops an empty box over the code for no reason.
  const declarations = index
    .lookup(call.target)
    .filter(
      (entry) =>
        (entry.kind === 'procedure' || entry.kind === 'function') && (entry.params?.length ?? 0) > 0
    );
  if (declarations.length === 0) {
    return undefined;
  }

  const signatures: SignatureInformation[] = [];
  const seen = new Set<string>();
  for (const declaration of declarations) {
    const signature = signatureOf(declaration);
    if (signature === undefined || seen.has(signature.label)) {
      continue;
    }
    seen.add(signature.label);
    signatures.push(signature);
    if (signatures.length >= MAX_SIGNATURES) {
      break;
    }
  }
  if (signatures.length === 0) {
    return undefined;
  }

  const activeParameter = activeParameterAt(call.args, position);

  // The best-ranked signature that can actually accept this many arguments, so typing a fourth
  // argument moves the highlight to the overload that has one.
  const fits = signatures.findIndex((signature) => signature.parameters!.length > activeParameter);

  return {
    signatures,
    activeSignature: fits < 0 ? 0 : fits,
    activeParameter
  };
}
