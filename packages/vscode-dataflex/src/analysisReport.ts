import * as vscode from 'vscode';
import {
  AnalyzeWorkspaceRequest,
  AnalyzeWorkspaceResponse
} from '@vscode-dataflex/langserver/protocol';
import { RULES } from '@vscode-dataflex/langserver/rules';
import { DataFlexClient } from './client';

/**
 * Runs static analysis across the whole workspace and puts the results in the Problems panel.
 *
 * Live analysis reports at `Hint` severity, which greys code out in the editor but -- by VS Code's
 * design -- is not listed in the Problems panel. That is the right default for something you did
 * not ask for, but it leaves no way to see findings in bulk. This command is that way: it reports
 * at `Information` or above so every finding is listed and navigable.
 */
export class AnalysisReport implements vscode.Disposable {
  private static readonly MEMENTO_KEY = 'dataflex.analysis.reportRules';
  private readonly collection: vscode.DiagnosticCollection;

  constructor(
    private readonly client: DataFlexClient,
    private readonly memento: vscode.Memento
  ) {
    this.collection = vscode.languages.createDiagnosticCollection('dataflex-workspace');
  }

  /**
   * Asks which rules to report on, remembering the last choice.
   *
   * `unused-local` alone finds thousands of results on a large codebase, and at a listed severity
   * it buries every other rule in the Problems panel. Choosing per run is the direct fix; the
   * `dataflex.analysis.severityOverrides` setting is the durable one.
   */
  private async pickRules(): Promise<string[] | undefined> {
    const remembered = this.memento.get<string[]>(AnalysisReport.MEMENTO_KEY);
    const previous = new Set(remembered ?? RULES.map((rule) => rule.id));

    const picked = await vscode.window.showQuickPick(
      RULES.map((rule) => ({
        label: rule.id,
        description: rule.workspaceOnly === true ? `${rule.title} (workspace only)` : rule.title,
        picked: previous.has(rule.id)
      })),
      {
        canPickMany: true,
        title: 'DataFlex: which rules should the report include?',
        placeHolder: 'Untick a noisy rule to keep the rest readable'
      }
    );

    if (picked === undefined) {
      return undefined;
    }
    const rules = picked.map((item) => item.label);
    await this.memento.update(AnalysisReport.MEMENTO_KEY, rules);
    return rules;
  }

  dispose(): void {
    this.collection.dispose();
  }

  clear(): void {
    this.collection.clear();
  }

  async run(): Promise<void> {
    const status = this.client.getStatus();
    if (status.swsPath === undefined) {
      vscode.window.showErrorMessage('DataFlex: no workspace loaded.');
      return;
    }

    const rules = await this.pickRules();
    if (rules === undefined) {
      return;
    }
    if (rules.length === 0) {
      vscode.window.showInformationMessage('DataFlex: no rules selected.');
      return;
    }

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `DataFlex: analysing ${status.workspaceName ?? 'workspace'}…`,
        cancellable: false
      },
      async () =>
        this.client.request<AnalyzeWorkspaceResponse>(AnalyzeWorkspaceRequest, { rules })
    );

    if (result === undefined) {
      vscode.window.showErrorMessage('DataFlex: analysis failed. See the DataFlex output channel.');
      return;
    }

    this.collection.clear();
    for (const file of result.files) {
      this.collection.set(
        vscode.Uri.parse(file.uri),
        file.diagnostics.map((diagnostic) => toVsCodeDiagnostic(diagnostic))
      );
    }

    const skipped = result.filesSkipped > 0 ? `, ${result.filesSkipped} skipped by exclude` : '';

    if (result.findings === 0) {
      vscode.window.showInformationMessage(
        `DataFlex: no findings in ${result.filesAnalyzed} file(s)${skipped}.`
      );
      return;
    }

    const summary = Object.entries(result.byRule)
      .sort((a, b) => b[1] - a[1])
      .map(([rule, count]) => `${rule}: ${count}`)
      .join(', ');

    const choice = await vscode.window.showInformationMessage(
      `DataFlex: ${result.findings} finding(s) in ${result.files.length} of ` +
        `${result.filesAnalyzed} file(s)${skipped} — ${summary}`,
      'Show Problems',
      'Clear'
    );
    if (choice === 'Show Problems') {
      await vscode.commands.executeCommand('workbench.actions.view.problems');
    } else if (choice === 'Clear') {
      this.clear();
    }
  }
}

/**
 * Converts a server diagnostic, lifting `Hint` to `Information`.
 *
 * A Hint would be invisible in the Problems panel, which defeats the point of asking for a report.
 */
function toVsCodeDiagnostic(diagnostic: {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  message: string;
  severity?: number;
  code?: string | number;
  tags?: number[];
}): vscode.Diagnostic {
  const range = new vscode.Range(
    diagnostic.range.start.line,
    diagnostic.range.start.character,
    diagnostic.range.end.line,
    diagnostic.range.end.character
  );

  // LSP severities are 1=Error .. 4=Hint; VS Code's are 0=Error .. 3=Hint.
  const lspSeverity = diagnostic.severity ?? 4;
  const severity =
    lspSeverity >= 4 ? vscode.DiagnosticSeverity.Information : ((lspSeverity - 1) as vscode.DiagnosticSeverity);

  const result = new vscode.Diagnostic(range, diagnostic.message, severity);
  result.source = 'dataflex';
  if (diagnostic.code !== undefined) {
    result.code = diagnostic.code;
  }
  // Deliberately no Unnecessary tag: in a report the point is to be listed, not faded out.
  return result;
}
