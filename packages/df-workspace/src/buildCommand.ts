/** The tasks this extension contributes. Declared here so this module needs no `vscode` import. */
export type TaskName = 'build' | 'rebuild' | 'run';

/**
 * The `df-cli` arguments for a task.
 *
 * Pure, and exported, so the argument shapes can be asserted without an extension host. The two
 * shapes differ in a way that is easy to get wrong and expensive to get wrong: `build` takes the
 * project as `--target <name>` and compiles every project when it is omitted, while `run` takes it
 * as a positional argument and fails outright if given `--target`.
 */
export function commandLine(
  task: TaskName,
  swsPath: string,
  project: string | undefined,
  restartWebApp: boolean
): { args: string[]; title: string } {
  if (task === 'run') {
    // `df-cli run` takes the project as a positional argument -- unlike `build`, it has no
    // `--target` option, and passing one makes it fail.
    const args = ['run', swsPath];
    if (project !== undefined) {
      args.push(project);
    }
    return { args, title: `run ${project ?? ''}`.trim() };
  }

  const args = ['build', swsPath];
  if (task === 'rebuild') {
    args.push('--rebuild');
  }
  // No `--target` means every project in the workspace, which is the whole-workspace build.
  if (project !== undefined) {
    args.push('--target', project);
  }
  if (restartWebApp) {
    args.push('--restart-webapp');
  }
  return {
    args,
    title: `${task === 'rebuild' ? 'rebuild' : 'build'} ${project ?? 'all projects'}`
  };
}
