/**
 * Static analysis rules.
 *
 * Every rule reports at `Hint` severity with the `Unnecessary` tag, so findings grey the code out
 * rather than adding noise to the Problems panel. Each is independently switchable, and a rule
 * whose false-positive rate has not been measured on real code ships **off**.
 */
export type RuleId =
  | 'unused-local'
  | 'unused-parameter'
  | 'unreachable-code'
  | 'duplicate-declaration'
  | 'dead-procedure'
  | 'implicit-global'
  | 'argument-count';

/** Severity names accepted in settings and as a rule's built-in default. */
export type SeverityName = 'hint' | 'information' | 'warning';

export interface RuleInfo {
  id: RuleId;
  title: string;
  /** Whether the rule is enabled when the user has not said otherwise. */
  defaultEnabled: boolean;
  /**
   * The rule's own baseline severity, when `Hint` is the wrong default for it.
   *
   * Most findings are tidiness and should grey the code out rather than interrupt. A rule that
   * reports a *correctness* hazard needs to be seen, which means reaching the Problems panel --
   * and VS Code does not list hints there at all.
   *
   * An explicit `dataflex.analysis.severityOverrides` entry still wins over this.
   */
  defaultSeverity?: SeverityName;
  /**
   * True when the rule needs the whole workspace index and cannot run on a single file.
   *
   * These are reported by *DataFlex: Analyze Workspace* only -- never live while typing, where
   * the answer would depend on how stale the index happened to be.
   */
  workspaceOnly?: boolean;
}

export const RULES: readonly RuleInfo[] = [
  {
    id: 'unused-local',
    title: 'Local variable is never read',
    defaultEnabled: true
  },
  {
    id: 'unreachable-code',
    title: 'Code after Procedure_Return / Function_Return cannot run',
    defaultEnabled: true
  },
  {
    id: 'duplicate-declaration',
    title: 'A local name is declared twice in the same scope',
    defaultEnabled: true
  },
  {
    // Was opt-in while it reported every event override's unused arguments -- 1,629 findings on
    // a 285k-line workspace. Excluding overrides and empty stubs cut that to 526, all in hand-written code that
    // genuinely ignores an argument, which is worth seeing by default.
    id: 'unused-parameter',
    title: 'Parameter is never read',
    defaultEnabled: true
  },
  {
    // Needs whole-program reachability, and DataFlex dispatches dynamically. Off until its
    // false-positive rate has been judged on the codebase it is pointed at.
    id: 'dead-procedure',
    title: 'Procedure or function is never called',
    defaultEnabled: false,
    workspaceOnly: true
  },
  {
    // Needs the whole index to know what a message name resolves to, so it cannot be answered
    // from one file. Measured on a 568-file application: 53 findings, every one inspected --
    // among them a call whose argument was commented out, one whose argument list still had
    // `//` in the middle of it, and a file that does not compile at all. Precise enough to be on,
    // and a correctness signal rather than untidiness, so it is loud.
    id: 'argument-count',
    title: 'Call passes the wrong number of arguments',
    defaultEnabled: true,
    defaultSeverity: 'warning',
    workspaceOnly: true
  },
  {
    // A correctness hazard rather than untidiness, and rare -- five occurrences across a
    // 568-file application -- so it is on, and loud, by default.
    id: 'implicit-global',
    title: 'Variable outside a method is an implicit global',
    defaultEnabled: true,
    defaultSeverity: 'warning'
  }
];

export type RuleSettings = Record<RuleId, boolean>;

export function defaultRuleSettings(): RuleSettings {
  return Object.fromEntries(RULES.map((rule) => [rule.id, rule.defaultEnabled])) as RuleSettings;
}
