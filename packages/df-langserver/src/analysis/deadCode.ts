import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import type { Declaration, SymbolIndex } from '@vscode-dataflex/workspace';
import { DIAGNOSTIC_SOURCE } from './analyze';
import { isWorkspaceOwnedFile } from './workspaceFiles';
import { overridesAncestor } from './overrides';

/** Why a method was considered reachable. Reported so a finding can be argued with. */
export type LiveReason =
  | 'override'
  | 'published'
  | 'referenced'
  | 'dynamic'
  | 'framework'
  | 'entry-point';

export interface DeadMethod {
  declaration: Declaration;
  /** Lower-cased name, for grouping. */
  key: string;
}

export interface DeadCodeResult {
  dead: DeadMethod[];
  /** How many candidates each reason spared, for tuning the rule. */
  sparedBy: Record<LiveReason, number>;
  candidates: number;
}

/**
 * Methods the runtime calls by name regardless of any declaration we can see.
 *
 * Deliberately tiny. The general case is handled by override detection, which is both more
 * accurate and not a guess: if an ancestor class declares the same member, something can call it.
 */
const ENTRY_POINTS = new Set(['construct_object', 'end_construct_object', 'main', 'test']);

/**
 * Finds procedures and functions that nothing appears to call.
 *
 * DataFlex makes this dangerous in three specific ways, and each is handled rather than hoped
 * about:
 *
 *  - **Framework hooks.** Overriding a method an ancestor class declares means the framework may
 *    invoke it, even though nothing in the workspace mentions the name. This is checked against
 *    the resolved class chain, *not* against a naming convention -- `OnClick` is no more special
 *    than `Refresh_Data`, and a hook named neither would be missed by a name rule.
 *  - **Dynamic dispatch.** `Send (RefProc(...))` and runtime-built message names mean a literal
 *    containing the method's name is enough to assume it is reachable.
 *  - **Macro-generated calls.** A `#COMMAND` body can `Send` a message the unexpanded parse never
 *    sees. Until the preprocessor layer exists, macro bodies are counted as references like any
 *    other code, which errs towards silence.
 *
 * Only methods in files the workspace owns are reported; framework and package code is somebody
 * else's problem.
 */
export function findDeadMethods(index: SymbolIndex, workspaceRoot: string): DeadCodeResult {
  const sparedBy: Record<LiveReason, number> = {
    override: 0,
    published: 0,
    referenced: 0,
    dynamic: 0,
    framework: 0,
    'entry-point': 0
  };

  const dead: DeadMethod[] = [];
  let candidates = 0;

  for (const declaration of index.allDeclarations()) {
    if (declaration.kind !== 'procedure' && declaration.kind !== 'function') {
      continue;
    }
    if (!isWorkspaceOwnedFile(declaration.file, workspaceRoot)) {
      sparedBy.framework++;
      continue;
    }

    candidates++;
    const name = declaration.name;
    const key = name.toLowerCase();

    if (ENTRY_POINTS.has(key)) {
      sparedBy['entry-point']++;
      continue;
    }

    if (declaration.published === true) {
      sparedBy.published++;
      continue;
    }

    if (overridesAncestor(index, name, declaration)) {
      sparedBy.override++;
      continue;
    }

    if (index.appearsInLiteral(name)) {
      sparedBy.dynamic++;
      continue;
    }

    // Every declaration of the name contributes one identifier token. Anything beyond that is a
    // reference -- a call, a `Send`, a `Set`, or a mention inside a macro body.
    if (index.referenceCount(name) > index.declarationCount(name)) {
      sparedBy.referenced++;
      continue;
    }

    dead.push({ declaration, key });
  }

  return { dead, sparedBy, candidates };
}

/** Turns findings into diagnostics grouped by file URI. */
export function deadMethodDiagnostics(
  result: DeadCodeResult,
  severity: DiagnosticSeverity,
  toUri: (file: string) => string
): Map<string, Diagnostic[]> {
  const byFile = new Map<string, Diagnostic[]>();

  for (const { declaration } of result.dead) {
    const uri = toUri(declaration.file);
    const diagnostics = byFile.get(uri) ?? [];
    diagnostics.push({
      range: declaration.nameRange,
      message:
        `'${declaration.name}' is never called, does not override anything a parent class ` +
        'declares, and is not published.',
      severity,
      source: DIAGNOSTIC_SOURCE,
      code: 'dead-procedure'
    });
    byFile.set(uri, diagnostics);
  }

  return byFile;
}
