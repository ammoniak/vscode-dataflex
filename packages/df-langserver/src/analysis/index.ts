/**
 * The analysis surface, for hosts that are not a language server.
 *
 * A subpath export rather than an addition to the root barrel, for the reason given in
 * `providers/index.ts`: the extension is bundled from this package, and widening the root barrel
 * pulls code it never calls into `out/extension.js`.
 */
export { analyze, fileSuppression, suppressionFor, DIAGNOSTIC_SOURCE } from './analyze';
export { analyzeWorkspace } from './analyzeWorkspace';
export type { AnalyzeWorkspaceOptions } from './analyzeWorkspace';
export type { AnalyzeOptions } from './analyze';
export { RULES, defaultRuleSettings } from './rules';
export type { RuleId, RuleInfo, RuleSettings, SeverityName } from './rules';
export { findDeadMethods, deadMethodDiagnostics } from './deadCode';
export type { DeadCodeResult, DeadMethod, LiveReason } from './deadCode';
export { findArgumentCountMismatches, makeArityResolver } from './argumentCount';
export type { ArgumentCountFinding, ArityIndex, CalleeArity, ResolveArity } from './argumentCount';
export { overridesAncestor, findOverridden } from './overrides';
export type { MethodOwner, OverriddenMember } from './overrides';
export { isWorkspaceOwnedFile, ownedFiles, matchesGlob, isExcluded } from './workspaceFiles';
