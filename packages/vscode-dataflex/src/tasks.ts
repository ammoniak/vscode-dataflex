import * as vscode from 'vscode';
import { commandLine } from './buildCommand';
import type { TaskName } from './buildCommand';
import { DataFlexClient } from './client';
import { DataFlexStatusBar } from './statusBar';

export interface DataFlexTaskDefinition extends vscode.TaskDefinition {
  type: 'dataflex';
  task: TaskName;
  project?: string;
}

/**
 * Surfaces `df-cli build` / `df-cli run` as VS Code tasks.
 *
 * Going through the task system rather than a bare `child_process` is what wires compiler output
 * into the Problems panel via the contributed `dataflex` problem matcher, and gives the user a
 * terminal they can re-run.
 */
export class DataFlexTaskProvider implements vscode.TaskProvider {
  static readonly taskType = 'dataflex';

  constructor(
    private readonly client: DataFlexClient,
    private readonly statusBar: DataFlexStatusBar
  ) {}

  provideTasks(): vscode.Task[] {
    const status = this.client.getStatus();
    if (status.swsPath === undefined) {
      return [];
    }

    const tasks: vscode.Task[] = [];
    for (const task of ['build', 'rebuild'] as const) {
      const created = this.create({ type: 'dataflex', task });
      if (created !== undefined) {
        tasks.push(created);
      }
    }
    for (const project of status.projects) {
      const created = this.create({ type: 'dataflex', task: 'run', project: project.name });
      if (created !== undefined) {
        tasks.push(created);
      }
    }
    return tasks;
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    return this.create(task.definition as DataFlexTaskDefinition);
  }

  create(definition: DataFlexTaskDefinition): vscode.Task | undefined {
    const status = this.client.getStatus();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (status.cliPath === undefined || status.swsPath === undefined || folder === undefined) {
      return undefined;
    }

    // A build with no project compiles every project in the workspace, which is what `df-cli
    // build <sws>` does without a `--target`. A run must name one.
    const project =
      definition.project ??
      (definition.task === 'run'
        ? this.statusBar.getProjectToRun()
        : this.statusBar.getSelectedProject());
    const restartWebApp = vscode.workspace
      .getConfiguration('dataflex', folder)
      .get<boolean>('build.restartWebApp', false);
    const { args, title } = commandLine(definition.task, status.swsPath, project, restartWebApp);

    const task = new vscode.Task(
      definition,
      folder,
      title,
      DataFlexTaskProvider.taskType,
      new vscode.ProcessExecution(status.cliPath, args, { cwd: status.root }),
      '$dataflex'
    );
    task.group = definition.task === 'run' ? vscode.TaskGroup.Test : vscode.TaskGroup.Build;
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: true
    };
    return task;
  }
}
