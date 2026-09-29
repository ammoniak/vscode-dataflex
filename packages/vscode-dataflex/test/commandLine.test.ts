import { describe, expect, it } from 'vitest';
import { commandLine } from '../src/buildCommand';

/**
 * The `df-cli` command line for build, rebuild and run.
 *
 * These two shapes are easy to confuse and expensive to confuse: `build` takes the project as
 * `--target <name>` and compiles *every* project when it is omitted, while `run` takes it as a
 * positional argument and fails outright if given `--target`.
 *
 * The whole-workspace build was unreachable before this: the status bar's "selected project"
 * fell back to the first project, so a `--target` was always passed and `df-cli build <sws>` --
 * which compiles everything -- could not be produced from the UI at all.
 */

const SWS = 'C:\\ws\\MyApp\\MyApp.sws';

describe('building', () => {
  it('compiles every project when none is selected', () => {
    const { args } = commandLine('build', SWS, undefined, false);
    expect(args).toEqual(['build', SWS]);
    expect(args).not.toContain('--target');
  });

  it('compiles one project when it is selected', () => {
    expect(commandLine('build', SWS, 'WebApp', false).args).toEqual([
      'build',
      SWS,
      '--target',
      'WebApp'
    ]);
  });

  it('says which it is doing', () => {
    expect(commandLine('build', SWS, undefined, false).title).toBe('build all projects');
    expect(commandLine('build', SWS, 'WebApp', false).title).toBe('build WebApp');
  });

  it('adds --rebuild for a rebuild, before the target', () => {
    expect(commandLine('rebuild', SWS, 'WebApp', false).args).toEqual([
      'build',
      SWS,
      '--rebuild',
      '--target',
      'WebApp'
    ]);
    expect(commandLine('rebuild', SWS, undefined, false).title).toBe('rebuild all projects');
  });

  it('adds --restart-webapp only when the setting asks for it', () => {
    expect(commandLine('build', SWS, 'WebApp', true).args).toContain('--restart-webapp');
    expect(commandLine('build', SWS, 'WebApp', false).args).not.toContain('--restart-webapp');
  });

  it('can rebuild every project with the web app restarted', () => {
    expect(commandLine('rebuild', SWS, undefined, true).args).toEqual([
      'build',
      SWS,
      '--rebuild',
      '--restart-webapp'
    ]);
  });
});

describe('running', () => {
  /** `df-cli run` has no `--target`; passing one makes it fail. */
  it('passes the project positionally, never as --target', () => {
    const { args } = commandLine('run', SWS, 'WebApp', false);
    expect(args).toEqual(['run', SWS, 'WebApp']);
    expect(args).not.toContain('--target');
  });

  it('omits the project when there is none', () => {
    expect(commandLine('run', SWS, undefined, false).args).toEqual(['run', SWS]);
  });

  it('ignores the web app restart setting, which is a build option', () => {
    expect(commandLine('run', SWS, 'WebApp', true).args).not.toContain('--restart-webapp');
  });
});
