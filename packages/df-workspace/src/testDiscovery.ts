import { DfNode, Range, parseSource, walk } from '@vscode-dataflex/parser';
import { IncludeResolver } from './includeResolver';
import { SymbolIndex, readSourceFile } from './symbolIndex';

/**
 * Base classes that make an object part of a DFUnit suite.
 *
 * A class counts if it *derives* from one of these, which is the common case in application code
 * (`Class cMyFixture is a cTestFixture`). The names are also matched directly so discovery still
 * works before the symbol index has finished building.
 */
const TEST_APPLICATION_CLASS = 'cdfunittestapplication';
const FIXTURE_CLASSES = new Set(['ctestfixture']);
/** `Object oX is a cTest` is a test in its own right, with its body in `Procedure Test`. */
const TEST_CLASSES = new Set(['ctest']);

export type TestNodeKind = 'application' | 'fixture' | 'test';

/** One node of the discovered test tree, mirroring the DFUnit object nesting. */
export interface TestNode {
  kind: TestNodeKind;
  /** The identifier as written in source, used for display and navigation. */
  name: string;
  /**
   * The name DFUnit reports in its JUnit output, which is what results are matched on. It
   * differs from `name` in three ways, all from the framework's own logic:
   *   - a fixture or application uses `psTestFixtureName` when set, else the object name;
   *   - a `cTest` object uses `psTestName` when set, else the object name;
   *   - a published procedure has a leading `msg_` stripped and every `_` turned into a space,
   *     so `Procedure If_it_is_divisible_by_4` is reported as `If it is divisible by 4`.
   */
  reportedName: string;
  /** File the declaration lives in. */
  file: string;
  range: Range;
  nameRange: Range;
  children: TestNode[];
}

/** Everything discovered for one buildable project. */
export interface TestProject {
  /** Project name as it appears in the `.sws`, e.g. `UnitTest.src`. */
  project: string;
  /** The `.src` file the project builds. */
  file: string;
  /** Test applications declared in it. Usually exactly one. */
  applications: TestNode[];
}

function isFixtureClass(
  className: string | undefined,
  index: SymbolIndex | undefined,
  wanted: (lower: string) => boolean
): boolean {
  if (className === undefined) {
    return false;
  }
  if (wanted(className.toLowerCase())) {
    return true;
  }
  // Application code subclasses the framework classes; walk the chain to catch that.
  return index?.resolveChain(className).some((record) => wanted(record.name.toLowerCase())) === true;
}

/** True when a `Procedure` is marked `{ Published=True }`, which is what makes it a test. */
function isPublishedProcedure(node: DfNode): boolean {
  if (node.kind !== 'procedure' || node.name === undefined) {
    return false;
  }
  return (
    node.metadata?.some(
      (tag) =>
        tag.name.toLowerCase() === 'published' &&
        (tag.value === undefined || tag.value.toLowerCase() === 'true')
    ) === true
  );
}

/** Reads a `Set <property> to "literal"` directly inside an object body. */
function declaredStringProperty(node: DfNode, property: string): string | undefined {
  const statement = node.children?.find(
    (child) =>
      child.kind === 'statement' &&
      child.verb === 'set' &&
      child.target?.toLowerCase() === property.toLowerCase()
  );
  if (statement?.text === undefined) {
    return undefined;
  }
  return /\bto\s+"([^"]*)"/i.exec(statement.text)?.[1];
}

/**
 * The name DFUnit gives a published procedure.
 *
 * `cDFUnitTestCollector.RegisterInterface` strips a `msg_` prefix and replaces underscores with
 * spaces, so matching on the raw procedure name would never find the result.
 */
export function reportedProcedureName(procedureName: string): string {
  return procedureName.replace(/^msg_/i, '').replace(/_/g, ' ');
}

/**
 * Discovers the DFUnit test tree reachable from a project's `.src`.
 *
 * Tests are rarely declared in the project file itself -- the convention is
 * `Use Tests\TestLoader.pkg` inside the test application object, with fixtures spread across many
 * spec packages -- so discovery follows `Use` directives through the compiler search path.
 */
export class TestDiscovery {
  constructor(
    private readonly resolver: IncludeResolver,
    private readonly index?: SymbolIndex
  ) {}

  /** Discovers tests for every project that declares a test application. */
  discoverProjects(projects: { name: string }[]): TestProject[] {
    const found: TestProject[] = [];

    for (const project of projects) {
      const file = this.resolver.resolve(project.name);
      if (file === undefined) {
        continue;
      }
      const applications = this.discoverFile(file, new Set());
      if (applications.length > 0) {
        found.push({ project: project.name, file, applications });
      }
    }

    return found;
  }

  /**
   * Collects test applications declared in `file`, following `Use` into other files.
   *
   * `visited` guards against the include cycles that are normal in DataFlex, where a spec package
   * and the package under test both `Use` a shared header.
   */
  private discoverFile(file: string, visited: Set<string>): TestNode[] {
    const key = file.toLowerCase();
    if (visited.has(key)) {
      return [];
    }
    visited.add(key);

    const text = readSourceFile(file);
    if (text === undefined) {
      return [];
    }

    let root: DfNode;
    try {
      root = parseSource(text, { uri: file }).root;
    } catch {
      return [];
    }

    const applications: TestNode[] = [];
    walk(root, (node) => {
      if (
        node.kind === 'object' &&
        isFixtureClass(node.superClass, this.index, (n) => n === TEST_APPLICATION_CLASS)
      ) {
        applications.push(this.buildNode(node, 'application', file, visited));
        // Its children are handled by buildNode; do not descend again.
        return false;
      }
      return undefined;
    });

    return applications;
  }

  private buildNode(
    node: DfNode,
    kind: TestNodeKind,
    file: string,
    visited: Set<string>
  ): TestNode {
    const nameRange = node.nameRange ?? node.headerRange;
    const name = node.name ?? '(unnamed)';
    const result: TestNode = {
      kind,
      name,
      reportedName:
        (kind === 'test'
          ? declaredStringProperty(node, 'psTestName')
          : declaredStringProperty(node, 'psTestFixtureName')) ?? name,
      file,
      range: node.range,
      nameRange,
      children: []
    };

    // A `cTest` object is a leaf: its body is `Procedure Test`, not more tests.
    if (kind === 'test') {
      return result;
    }

    for (const child of node.children ?? []) {
      // `Object oX is a cTest` -- a test in its own right.
      if (
        child.kind === 'object' &&
        isFixtureClass(child.superClass, this.index, (n) => TEST_CLASSES.has(n))
      ) {
        result.children.push(this.buildNode(child, 'test', file, visited));
        continue;
      }

      // A nested fixture object.
      if (
        child.kind === 'object' &&
        isFixtureClass(child.superClass, this.index, (n) => FIXTURE_CLASSES.has(n))
      ) {
        result.children.push(this.buildNode(child, 'fixture', file, visited));
        continue;
      }

      // A published procedure is a test.
      if (isPublishedProcedure(child)) {
        result.children.push({
          kind: 'test',
          name: child.name!,
          reportedName: reportedProcedureName(child.name!),
          file,
          range: child.range,
          nameRange: child.nameRange ?? child.headerRange,
          children: []
        });
        continue;
      }

      // `Use <spec>.pkg` inside the object body pulls in more fixtures. The included file
      // declares them at its own top level, so they become children of this node.
      if (child.kind === 'use' && child.name !== undefined) {
        const included = this.resolver.resolve(child.name, file.replace(/[\\/][^\\/]*$/, ''));
        if (included !== undefined) {
          result.children.push(...this.discoverIncluded(included, visited));
        }
      }
    }

    return result;
  }

  /** Fixtures declared at the top level of an included spec file. */
  private discoverIncluded(file: string, visited: Set<string>): TestNode[] {
    const key = file.toLowerCase();
    if (visited.has(key)) {
      return [];
    }
    visited.add(key);

    const text = readSourceFile(file);
    if (text === undefined) {
      return [];
    }

    let root: DfNode;
    try {
      root = parseSource(text, { uri: file }).root;
    } catch {
      return [];
    }

    const nodes: TestNode[] = [];
    for (const child of root.children ?? []) {
      if (
        child.kind === 'object' &&
        isFixtureClass(child.superClass, this.index, (n) => TEST_CLASSES.has(n))
      ) {
        nodes.push(this.buildNode(child, 'test', file, visited));
      } else if (
        child.kind === 'object' &&
        isFixtureClass(child.superClass, this.index, (n) => FIXTURE_CLASSES.has(n))
      ) {
        nodes.push(this.buildNode(child, 'fixture', file, visited));
      } else if (child.kind === 'use' && child.name !== undefined) {
        // A loader package that only chains to other spec files.
        const included = this.resolver.resolve(child.name, file.replace(/[\\/][^\\/]*$/, ''));
        if (included !== undefined) {
          nodes.push(...this.discoverIncluded(included, visited));
        }
      }
    }
    return nodes;
  }
}
