import {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticTag
} from 'vscode-languageserver';
import {
  DfNode,
  Range,
  SourceUnit,
  Token,
  TokenKind,
  buildCfg,
  reachableBlocks,
  walk
} from '@vscode-dataflex/parser';
import { RULES, RuleId, RuleSettings, defaultRuleSettings } from './rules';
import type { MethodOwner } from './overrides';

export const DIAGNOSTIC_SOURCE = 'dataflex';

/** A rule's own baseline severity, where it declares one. */
const RULE_SEVERITY: ReadonlyMap<string, DiagnosticSeverity> = new Map(
  RULES.filter((rule) => rule.defaultSeverity !== undefined).map((rule) => [
    rule.id,
    rule.defaultSeverity === 'warning'
      ? DiagnosticSeverity.Warning
      : rule.defaultSeverity === 'information'
        ? DiagnosticSeverity.Information
        : DiagnosticSeverity.Hint
  ])
);

/** `// df-ignore:<rule>` on the reported line, or the line above it, silences a finding. */
const SUPPRESSION = /\/\/\s*df-ignore\s*:\s*([a-z-]+(?:\s*,\s*[a-z-]+)*)/i;

/**
 * `// df-analysis-ignore` anywhere in a file turns analysis off for the whole file, optionally
 * for named rules only (`// df-analysis-ignore: unused-local, dead-procedure`).
 *
 * Useful for generated code: a vendor ActiveX wrapper in one workspace holds 97% of that
 * workspace's findings, and none of them are actionable.
 */
const FILE_SUPPRESSION = /\/\/\s*df-analysis-ignore\s*(?::\s*([a-z-]+(?:\s*,\s*[a-z-]+)*))?/i;

/**
 * Rules disabled for a whole file by an in-file comment.
 *
 * Returns `'all'` for a bare marker, a set of rule ids for a named list, or `undefined` when the
 * file carries no marker.
 */
export function fileSuppression(unit: SourceUnit): 'all' | Set<string> | undefined {
  for (const token of unit.tokens) {
    if (token.kind !== TokenKind.Comment) {
      continue;
    }
    const match = FILE_SUPPRESSION.exec(token.text);
    if (match === null) {
      continue;
    }
    const named = match[1];
    if (named === undefined) {
      return 'all';
    }
    return new Set(named.split(',').map((value) => value.trim().toLowerCase()));
  }
  return undefined;
}

/**
 * The suppression test, for rules that are reported from outside `analyze`.
 *
 * `argument-count` needs the whole index to know what a message name resolves to, so it is
 * appended by the caller after `analyze` has returned -- which left it the one rule no
 * `// df-ignore` could switch off, whole-file marker included. Exposing the same test keeps every
 * rule answerable to the same comments rather than most of them.
 */
export function suppressionFor(unit: SourceUnit): (rule: RuleId, range: Range) => boolean {
  const forFile = fileSuppression(unit);
  const lines = sourceLines(unit);
  return (rule, range) =>
    forFile === 'all' || forFile?.has(rule) === true || isSuppressed(lines, range, rule);
}

interface Pos {
  line: number;
  character: number;
}

/** Negative if `a` precedes `b`, zero if equal, positive otherwise. */
function comparePositions(a: Pos, b: Pos): number {
  return a.line === b.line ? a.character - b.character : a.line - b.line;
}

/** True when `range` lies wholly inside `outer`. */
function withinRange(range: Range, outer: Range): boolean {
  return (
    comparePositions(range.start, outer.start) >= 0 && comparePositions(range.end, outer.end) <= 0
  );
}

/** Index of the first token starting at or after `position`. Tokens are in source order. */
function firstTokenAtOrAfter(tokens: Token[], position: Pos): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (comparePositions(tokens[mid]!.range.start, position) < 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * Tallies identifier occurrences inside a range, in a single pass.
 *
 * Built once per scope and shared by every local and parameter in it. The previous shape --
 * filtering the whole file's token array once per declaration -- was O(tokens x declarations),
 * which took 214 seconds on a 64k-line generated file and ran on every keystroke.
 *
 * Working from tokens rather than raw text is what makes reference detection trustworthy: an
 * occurrence inside a `//` comment or a string literal is not a use, and the lexer has already
 * classified both.
 */
function tallyIdentifiers(tokens: Token[], range: Range): Map<string, number> {
  const counts = new Map<string, number>();

  const bump = (key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  for (let i = firstTokenAtOrAfter(tokens, range.start); i < tokens.length; i++) {
    const token = tokens[i]!;
    if (comparePositions(token.range.end, range.end) > 0) {
      break;
    }
    if (token.kind !== TokenKind.Identifier) {
      continue;
    }
    const text = token.text.toLowerCase();
    bump(text);
    // A dotted name (`myStruct.field`) also references its leading identifier.
    const dot = text.indexOf('.');
    if (dot > 0) {
      bump(text.slice(0, dot));
    }
  }

  return counts;
}

export interface AnalyzeOptions {
  settings?: Partial<RuleSettings>;
  /**
   * Default severity for reported findings.
   *
   * `Hint` greys the code out but VS Code does not list hints in the Problems panel, so a user
   * who wants findings enumerated needs to raise this.
   */
  severity?: DiagnosticSeverity;
  /**
   * Severity for particular rules, overriding `severity`.
   *
   * The reason this exists: `unused-local` legitimately finds thousands of results on a large
   * codebase, and at a listed severity it buries every other rule. Demoting just that one back to
   * a hint keeps it visible in the editor without drowning the Problems panel.
   */
  severityOverrides?: Record<string, DiagnosticSeverity>;
  /**
   * Answers whether a method overrides something an ancestor class declares.
   *
   * Supplied by the server, which owns the symbol index; a single file cannot answer it. Without
   * it `unused-parameter` reports every event override, because overriding an event means taking
   * the framework's parameters whether the body uses them or not.
   */
  overridesAncestor?: (methodName: string, owner: MethodOwner) => boolean;
}

/**
 * Runs the enabled rules over one parsed file.
 *
 * Analysis is deliberately confined to what a single file can prove. Anything needing whole-
 * program reachability -- dead procedures above all -- is unsafe without the preprocessor layer,
 * because a `#COMMAND` body can `Send` a message this parse never sees.
 */
export function analyze(unit: SourceUnit, options: AnalyzeOptions = {}): Diagnostic[] {
  const settings = { ...defaultRuleSettings(), ...options.settings };
  const suppressedForFile = fileSuppression(unit);
  if (suppressedForFile === 'all') {
    return [];
  }

  const diagnostics: Diagnostic[] = [];
  const lines = sourceLines(unit);

  const report = (rule: RuleId, range: Range, message: string): void => {
    if (settings[rule] !== true || isSuppressed(lines, range, rule)) {
      return;
    }
    if (suppressedForFile?.has(rule) === true) {
      return;
    }
    // The user's explicit choice wins; then the rule's own baseline, so a correctness warning is
    // not quietly demoted by a global default meant for tidiness findings; then that global.
    const severity =
      options.severityOverrides?.[rule] ??
      RULE_SEVERITY.get(rule) ??
      options.severity ??
      DiagnosticSeverity.Hint;
    diagnostics.push({
      range,
      message,
      severity,
      // The Unnecessary tag is what fades the code out. It only makes sense while the finding is
      // a quiet hint; at warning severity the user asked to be told, not to have it dimmed.
      tags: severity === DiagnosticSeverity.Hint ? [DiagnosticTag.Unnecessary] : undefined,
      source: DIAGNOSTIC_SOURCE,
      code: rule
    });
  };

  checkImplicitGlobals(unit, report);

  walk(unit.root, (node, parents) => {
    if (node.kind !== 'procedure' && node.kind !== 'function') {
      return;
    }
    const container = [...parents]
      .reverse()
      .find((parent) => parent.kind === 'class' || parent.kind === 'object');
    const owner: MethodOwner = {
      // `Function X for cY` grafts the method onto a class declared elsewhere.
      ownerClass:
        node.forClass ?? (container?.kind === 'object' ? container.superClass : container?.name),
      ownerIsObject: container?.kind === 'object'
    };
    checkScope(node, unit.tokens, report, owner, options);
  });

  return diagnostics;
}

/** Rules that apply within one procedure or function body. */
function checkScope(
  scope: DfNode,
  tokens: Token[],
  report: (rule: RuleId, range: Range, message: string) => void,
  owner: MethodOwner,
  options: AnalyzeOptions
): void {
  // One tally for the whole scope, shared by every local and parameter below.
  const counts = tallyIdentifiers(tokens, scope.range);
  const referencesTo = (name: string): number => counts.get(name.toLowerCase()) ?? 0;

  // --- unused locals ------------------------------------------------------
  const locals: DfNode[] = [];
  walk(scope, (node) => {
    if (node.kind === 'variable' && node.name !== undefined) {
      locals.push(node);
    }
  });

  const seenNames = new Map<string, DfNode>();
  for (const local of locals) {
    const name = local.name!;
    const key = name.toLowerCase();

    const previous = seenNames.get(key);
    if (previous !== undefined) {
      report(
        'duplicate-declaration',
        local.nameRange ?? local.headerRange,
        `'${name}' is already declared in this scope (line ${previous.headerRange.start.line + 1}).`
      );
    } else {
      seenNames.set(key, local);
    }

    // One occurrence is the declaration itself; anything more is a use.
    if (referencesTo(name) <= 1) {
      report('unused-local', local.nameRange ?? local.headerRange, `'${name}' is never used.`);
    }
  }

  // --- unused parameters --------------------------------------------------
  // Two shapes are legitimately allowed to ignore their parameters, and reporting them is what
  // made this rule unusable on real code:
  //   - an override of something a parent class declares -- the framework decides the signature,
  //     not the author, and DataFlex events are the common case;
  //   - an empty body, which is a deliberate no-op stub suppressing inherited behaviour.
  const isOverride =
    scope.name !== undefined && options.overridesAncestor?.(scope.name, owner) === true;

  if (!isOverride && !hasEmptyBody(scope)) {
    for (const param of scope.params ?? []) {
      if (referencesTo(param.name) <= 1) {
        report('unused-parameter', param.range, `Parameter '${param.name}' is never used.`);
      }
    }
  }

  // --- unreachable code ---------------------------------------------------
  checkUnreachable(scope, report);
}

/**
 * Reports variables declared outside any method.
 *
 * DataFlex makes such a declaration a **global**, scoped to the whole program from that line
 * onward -- `Global_Variable` changes nothing about the scope, only the clarity of the intent. So
 * a `String sFoo` sitting in an `Object ... End_Object` body is not per-object state at all: every
 * instance shares one variable, silently.
 *
 * `Global_Variable String gsFoo` needs no special case here: it parses as a statement rather than
 * a variable declaration, as does `Property`, so both fall outside this rule by construction.
 */
function checkImplicitGlobals(
  unit: SourceUnit,
  report: (rule: RuleId, range: Range, message: string) => void
): void {
  walk(unit.root, (node, parents) => {
    // `Global_Variable` is the deliberate form this rule recommends, so it is never a finding.
    if (node.isGlobal === true) {
      return;
    }
    if (node.kind !== 'variable' || node.name === undefined) {
      return;
    }
    // Inside a method it is an ordinary local.
    if (parents.some((parent) => parent.kind === 'procedure' || parent.kind === 'function')) {
      return;
    }
    // A declaration inside a struct is a field, whatever the tree calls it.
    if (parents.some((parent) => parent.kind === 'struct')) {
      return;
    }

    const container = [...parents]
      .reverse()
      .find((parent) => parent.kind === 'object' || parent.kind === 'class');

    const where =
      container?.name === undefined
        ? 'outside any method'
        : `outside any method of '${container.name}'`;

    let message =
      `'${node.name}' is declared ${where}, which makes it a program-wide global shared by every ` +
      'object rather than per-object state. Use a Property for object state, or Global_Variable ' +
      'to declare a global deliberately.';

    // A global string without an explicit length is a second, quieter bug: only a
    // `Global_Variable String gsX 255` declaration may set one.
    if (node.type?.toLowerCase() === 'string') {
      message += ' A global String defaults to 80 characters and truncates silently.';
    }

    report('implicit-global', node.nameRange ?? node.headerRange, message);
  });
}

/** True when a method contains no runnable code -- a deliberate no-op override. */
function hasEmptyBody(scope: DfNode): boolean {
  return !(scope.children ?? []).some(
    (child) =>
      child.kind === 'statement' ||
      child.kind === 'unknown' ||
      child.kind === 'block' ||
      child.kind === 'caseArm'
  );
}

/**
 * Reports statements no path can reach, using the control-flow graph.
 *
 * This replaced a scan that matched on verb strings and raw statement text, which needed a
 * special case for single-line conditionals and another for `Case` arms -- and shipped a bug in
 * the second. The graph handles both because the parser now models them structurally.
 *
 * Findings are collapsed to one per contiguous dead run. A stray `Procedure_Return` can kill
 * dozens of following statements across several nested blocks; naming the first is what the
 * reader needs, and the rest would be noise about a single cause.
 */
function checkUnreachable(
  scope: DfNode,
  report: (rule: RuleId, range: Range, message: string) => void
): void {
  const cfg = buildCfg(scope);
  if (cfg.imprecise) {
    // An unmodelled jump could reach anything; silence beats a confident wrong answer.
    return;
  }

  const reachable = reachableBlocks(cfg);
  const dead = new Set<DfNode>();
  for (const block of cfg.blocks) {
    if (!reachable.has(block.id)) {
      for (const statement of block.statements) {
        dead.add(statement);
      }
    }
  }
  if (dead.size === 0) {
    return;
  }

  // Statements in source order, so a dead run can be recognised as consecutive.
  const ordered: DfNode[] = [];
  walk(scope, (node) => {
    if (node.kind === 'statement' || node.kind === 'unknown') {
      ordered.push(node);
    }
  });

  let inRun = false;
  for (const statement of ordered) {
    if (!dead.has(statement)) {
      inRun = false;
      continue;
    }
    // `Case Break` closing an arm that already returned is technically dead, but DataFlex
    // authors write one on every arm out of habit. Reporting it buries the findings that matter.
    if (statement.verb === 'case') {
      continue;
    }
    if (!inRun) {
      report('unreachable-code', statement.range, 'Unreachable: no path reaches this statement.');
      inRun = true;
    }
  }
}

function sourceLines(unit: SourceUnit): string[] {
  // Reconstructing from tokens would lose comments' exact text; the lexer keeps comment tokens,
  // which is all suppression needs.
  const lines: string[] = [];
  for (const token of unit.tokens) {
    if (token.kind !== TokenKind.Comment) {
      continue;
    }
    const line = token.range.start.line;
    lines[line] = (lines[line] ?? '') + token.text;
  }
  return lines;
}

function isSuppressed(commentLines: string[], range: Range, rule: RuleId): boolean {
  for (const line of [range.start.line, range.start.line - 1]) {
    const comment = commentLines[line];
    if (comment === undefined) {
      continue;
    }
    const match = SUPPRESSION.exec(comment);
    if (match === null) {
      continue;
    }
    const rules = match[1]!.split(',').map((value) => value.trim().toLowerCase());
    if (rules.includes(rule) || rules.includes('all')) {
      return true;
    }
  }
  return false;
}
