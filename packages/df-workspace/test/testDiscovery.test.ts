import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IncludeResolver } from '../src/includeResolver';
import { TestDiscovery, TestNode, reportedProcedureName } from '../src/testDiscovery';

const FIXTURE_ROOT = join(__dirname, '..', '..', '..', 'fixtures', 'dfunit', 'AppSrc');

/**
 * Discovery runs against a checked-in fixture rather than an installed workspace, so it does not
 * need DataFlex present and covers both DFUnit test forms deliberately.
 */
function discover(): TestNode[] {
  const resolver = new IncludeResolver([FIXTURE_ROOT, join(FIXTURE_ROOT, 'Tests')]);
  // No symbol index: discovery must work off the literal base-class names too, because it runs
  // before indexing finishes.
  const discovery = new TestDiscovery(resolver);
  return discovery.discoverProjects([{ name: 'RunTests.src' }]).flatMap((p) => p.applications);
}

/** Flattens to `path -> kind`, using the DFUnit-reported names that results are keyed on. */
function flatten(nodes: TestNode[], prefix: string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of nodes) {
    const path = [...prefix, node.reportedName];
    out.set(path.join('/'), node.kind);
    for (const [key, value] of flatten(node.children, path)) {
      out.set(key, value);
    }
  }
  return out;
}

describe('reportedProcedureName', () => {
  it('mirrors what DFUnit does to a published procedure name', () => {
    // cDFUnitTestCollector.RegisterInterface strips `msg_` and turns `_` into spaces; matching on
    // the raw name would never find the result in the report.
    expect(reportedProcedureName('If_it_is_divisible_by_4')).toBe('If it is divisible by 4');
    expect(reportedProcedureName('msg_TrueIsTrue')).toBe('TrueIsTrue');
    expect(reportedProcedureName('msg_A_b_c')).toBe('A b c');
    expect(reportedProcedureName('Simple')).toBe('Simple');
  });
});

describe('TestDiscovery', () => {
  it('finds the test application and uses psTestFixtureName as its reported name', () => {
    const applications = discover();
    expect(applications).toHaveLength(1);
    expect(applications[0]!.kind).toBe('application');
    expect(applications[0]!.name).toBe('oTestApp');
    expect(applications[0]!.reportedName).toBe('Probe');
  });

  it('follows `Use` into spec packages', () => {
    // The fixtures live in Tests\SanityTests.pkg, reachable only through the `Use` in the .src.
    const paths = flatten(discover());
    expect([...paths.keys()]).toContain('Probe/Sanity');
    expect(paths.get('Probe/Sanity')).toBe('fixture');
  });

  it('discovers both test forms with their reported names', () => {
    const paths = flatten(discover());

    // Published procedure on the application, underscores turned into spaces.
    expect(paths.get('Probe/Top level passes')).toBe('test');

    // cTest object named by psTestName.
    expect(paths.get('Probe/Sanity/Integer arithmetic')).toBe('test');

    // cTest object with no psTestName falls back to the object name.
    expect(paths.get('Probe/Sanity/oUnnamedTest')).toBe('test');

    // Published procedure inside a nested fixture.
    expect(paths.get('Probe/Sanity/oNested/If it is divisible by 4')).toBe('test');
  });

  it('does not mistake lifecycle procedures for tests', () => {
    // `Procedure Setup` has no { Published=True } tag.
    const paths = flatten(discover());
    expect([...paths.keys()].some((key) => key.toLowerCase().includes('setup'))).toBe(false);
  });

  it('treats a cTest object as a leaf', () => {
    const sanity = discover()[0]!.children.find((c) => c.reportedName === 'Sanity')!;
    const integerMath = sanity.children.find((c) => c.reportedName === 'Integer arithmetic')!;
    // Its `Procedure Test` body is the test, not a child test.
    expect(integerMath.children).toEqual([]);
  });

  it('records a navigable location for every node', () => {
    const paths: TestNode[] = [];
    const gather = (nodes: TestNode[]): void => {
      for (const node of nodes) {
        paths.push(node);
        gather(node.children);
      }
    };
    gather(discover());

    expect(paths.length).toBeGreaterThan(4);
    for (const node of paths) {
      expect(node.file).toMatch(/\.(src|pkg)$/i);
      expect(node.nameRange.start.line).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns nothing for a project with no test application', () => {
    const resolver = new IncludeResolver([join(FIXTURE_ROOT, 'Tests')]);
    expect(new TestDiscovery(resolver).discoverProjects([{ name: 'SanityTests.pkg' }])).toEqual([]);
  });

  it('returns nothing for a project that does not resolve', () => {
    const resolver = new IncludeResolver([FIXTURE_ROOT]);
    expect(new TestDiscovery(resolver).discoverProjects([{ name: 'NoSuch.src' }])).toEqual([]);
  });
});
