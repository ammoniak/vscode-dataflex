import * as vscode from 'vscode';
import type { DataFlexStatus } from '@vscode-dataflex/langserver/protocol';

/**
 * Shows which workspace and project the extension is working against.
 *
 * It doubles as the first place to look when something is not working: a warning triangle means
 * the workspace never resolved, and the tooltip carries the reason.
 */
export class DataFlexStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private selectedProject: string | undefined;
  private status: DataFlexStatus | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'dataflex.selectProject';
  }

  dispose(): void {
    this.item.dispose();
  }

  /** The project builds and runs target; defaults to the first the workspace declares. */
  /**
   * The project the user chose, or `undefined` meaning every project in the workspace.
   *
   * `undefined` used to fall back to the first project, which made "build the whole workspace"
   * unreachable: `df-cli build <sws>` compiles every project, but a `--target` was always passed.
   */
  getSelectedProject(): string | undefined {
    return this.selectedProject;
  }

  /**
   * The project to run.
   *
   * `df-cli run` needs exactly one, so unlike a build this cannot mean "all"; with no explicit
   * choice the workspace's first project is the sensible default.
   */
  getProjectToRun(): string | undefined {
    return this.selectedProject ?? this.status?.projects[0]?.name;
  }

  /** `undefined` selects every project. */
  setSelectedProject(name: string | undefined): void {
    this.selectedProject = name;
    this.render();
  }

  update(status: DataFlexStatus): void {
    this.status = status;
    // Drop a stale selection if the workspace no longer declares that project.
    if (
      this.selectedProject !== undefined &&
      !status.projects.some((project) => project.name === this.selectedProject)
    ) {
      this.selectedProject = undefined;
    }
    this.render();
  }

  private render(): void {
    const status = this.status;
    if (status === undefined) {
      this.item.hide();
      return;
    }

    if (status.lastError !== undefined) {
      this.item.text = '$(warning) DataFlex';
      this.item.tooltip = status.lastError;
      this.item.command = 'dataflex.reloadWorkspace';
      this.item.show();
      return;
    }

    if (status.workspaceName === undefined) {
      this.item.hide();
      return;
    }

    const project = this.selectedProject;
    const indexing = status.indexReady ? '' : ' $(sync~spin)';
    this.item.text = `$(database) ${status.workspaceName} · ${project ?? 'all projects'}${indexing}`;
    this.item.tooltip = new vscode.MarkdownString(
      [
        `**Workspace** \`${status.swsPath ?? '(unknown)'}\``,
        `**Project** \`${project ?? '(none)'}\``,
        `**Dependencies** ${status.dependencyCount}`,
        `**Search path** ${status.searchPathCount} entries`,
        status.indexReady
          ? `**Index** ${status.indexedFiles} files, ${status.indexedNames} names, ${status.indexedClasses} classes`
          : '**Index** building…',
        status.loadedSuccessfully
          ? ''
          : '\n⚠️ df-cli reported the workspace did not load cleanly; navigation may be incomplete.',
        '',
        'Click to select a different project.'
      ]
        .filter((line) => line !== '')
        .join('\n\n')
    );
    this.item.command = 'dataflex.selectProject';
    this.item.show();
  }
}
