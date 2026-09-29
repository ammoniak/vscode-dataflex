import { pathToFileURL } from 'node:url';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import { parseSource } from '@vscode-dataflex/parser';
import { IncludeResolver, SymbolIndex, readSourceFile } from '@vscode-dataflex/workspace';
import { AnalyzedFile, AnalyzeWorkspaceResponse } from '../protocol';
import { analyze, fileSuppression, suppressionFor } from './analyze';
import { RuleSettings } from './rules';
import { deadMethodDiagnostics, findDeadMethods } from './deadCode';
import { findArgumentCountMismatches, makeArityResolver } from './argumentCount';
import { MethodOwner, overridesAncestor } from './overrides';
import { isExcluded, isWorkspaceOwnedFile, ownedFiles } from './workspaceFiles';

export interface AnalyzeWorkspaceOptions {
  resolver: IncludeResolver;
  /** Absent means the index is not ready: `dead-procedure` and `argument-count` are then skipped. */
  index?: SymbolIndex;
  root: string;
  settings: RuleSettings;
  severity: DiagnosticSeverity;
  severityOverrides: Record<string, DiagnosticSeverity>;
  exclude: readonly string[];
  /** An explicit rule list, which is authoritative rather than a filter -- see below. */
  rules?: readonly string[];
}

/**
 * Analyses every source file the workspace itself owns.
 *
 * Dependencies are excluded deliberately: findings in `DfPkg` packages or the runtime library are
 * somebody else's code and would swamp the ones the user can act on.
 *
 * Lives here rather than in the request handler so the language server and any other host -- the
 * MCP server, a script -- run the same analysis rather than two that drift.
 */
export function analyzeWorkspace(options: AnalyzeWorkspaceOptions): AnalyzeWorkspaceResponse {
  const { resolver, index, root, severity, severityOverrides, exclude } = options;

  // An explicit rule list is authoritative: picking a rule for a report is a direct request to
  // run it, so it overrides the settings that govern live analysis. Narrowing only -- treating
  // the list as a filter over already-enabled rules -- would silently do nothing for the two
  // rules that ship off, which are exactly the ones worth asking for on demand.
  const requestedSettings = { ...options.settings };
  if (options.rules !== undefined) {
    const wanted = new Set(options.rules);
    for (const key of Object.keys(requestedSettings) as (keyof RuleSettings)[]) {
      requestedSettings[key] = wanted.has(key);
    }
  }

  // Both built once for the whole run rather than per file. With no index the honest answer is
  // "cannot tell", and the rules that depend on one then report nothing rather than guessing.
  const overrideCheck =
    index === undefined
      ? undefined
      : (name: string, owner: MethodOwner): boolean => overridesAncestor(index, name, owner);
  const resolveArity =
    index === undefined
      ? undefined
      : makeArityResolver(index, (file) => isWorkspaceOwnedFile(file, root));

  const all = ownedFiles(resolver.allSourceFiles(), root);
  const own = all.filter((file) => !isExcluded(file, exclude));
  const skipped = all.length - own.length;

  const byUri = new Map<string, Diagnostic[]>();
  const suppressionByFile = new Map<string, 'all' | Set<string>>();
  const byRule: Record<string, number> = {};
  let findings = 0;

  for (const file of own) {
    const text = readSourceFile(file);
    if (text === undefined) {
      continue;
    }
    let diagnostics;
    let unit;
    try {
      // Parsed with the same vocabulary the index was built with. Without it a call written with
      // a workspace `#COMMAND` verb parses as `unknown` here while the index read it as a
      // statement, so the two views of one file disagree about what is even in it.
      unit = parseSource(text, {
        uri: file,
        ...(index === undefined
          ? {}
          : { knownTypes: index.typeNames, knownCommands: index.commandNames })
      });
      diagnostics = analyze(unit, {
        settings: requestedSettings,
        severity,
        severityOverrides,
        overridesAncestor: overrideCheck
      });
    } catch {
      continue;
    }
    // Record file-level suppression even for clean files, since the whole-workspace rules below
    // are reported from the index rather than from this loop.
    const suppressed = fileSuppression(unit);
    if (suppressed !== undefined) {
      suppressionByFile.set(file.toLowerCase(), suppressed);
    }

    // Needs the index to know what a message name resolves to, so it is answered here rather than
    // in `analyze()`, which sees one file at a time.
    if (requestedSettings['argument-count'] === true && resolveArity !== undefined) {
      const silenced = suppressionFor(unit);
      for (const finding of findArgumentCountMismatches(unit, resolveArity)) {
        if (silenced('argument-count', finding.range)) {
          continue;
        }
        diagnostics.push({
          range: finding.range,
          message: finding.message,
          severity: severityOverrides['argument-count'] ?? severity,
          source: 'dataflex',
          code: 'argument-count'
        });
      }
    }

    if (diagnostics.length === 0) {
      continue;
    }
    for (const diagnostic of diagnostics) {
      const rule = String(diagnostic.code);
      byRule[rule] = (byRule[rule] ?? 0) + 1;
    }
    findings += diagnostics.length;
    byUri.set(pathToFileURL(file).toString(), diagnostics);
  }

  // --- whole-workspace rules ------------------------------------------------
  // `dead-procedure` asks whether anything anywhere calls a method, so it cannot be answered from
  // a single file and is never reported live while typing.
  if (requestedSettings['dead-procedure'] === true && index !== undefined) {
    const analysable = new Set(own.map((file) => file.toLowerCase()));
    const result = findDeadMethods(index, root);
    const deadSeverity = severityOverrides['dead-procedure'] ?? severity;

    const permitted = {
      ...result,
      dead: result.dead.filter(({ declaration }) => {
        const key = declaration.file.toLowerCase();
        if (!analysable.has(key)) {
          return false;
        }
        const suppression = suppressionByFile.get(key);
        return suppression !== 'all' && suppression?.has('dead-procedure') !== true;
      })
    };

    for (const [uri, diagnostics] of deadMethodDiagnostics(permitted, deadSeverity, (file) =>
      pathToFileURL(file).toString()
    )) {
      const existing = byUri.get(uri) ?? [];
      byUri.set(uri, [...existing, ...diagnostics]);
      findings += diagnostics.length;
      byRule['dead-procedure'] = (byRule['dead-procedure'] ?? 0) + diagnostics.length;
    }
  }

  const files: AnalyzedFile[] = [...byUri].map(([uri, diagnostics]) => ({ uri, diagnostics }));
  return { files, filesAnalyzed: own.length, filesSkipped: skipped, findings, byRule };
}
