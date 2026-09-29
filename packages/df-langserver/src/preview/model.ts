/**
 * Building the object definition the DataFlex web framework renders from.
 *
 * `df.BaseApp#initJSON` takes a JSON description of an object tree and instantiates the whole
 * thing: for each node it looks up a JavaScript constructor by name, creates it, applies published
 * property values, adds it to its parent and calls `create`. That is normally the server's reply to
 * `LoadWebApp`. It is also, exactly, something a parser can produce -- which is what makes a design
 * time preview possible at all, with no build, no server and no DataFlex process.
 *
 * The shape below mirrors what `initJSON` reads, so what this returns can be posted to the webview
 * and handed over unaltered. See `docs/PREVIEW.md`.
 *
 * What is deliberately *not* sent: the declared defaults of every published property. A control
 * class has a hundred or more, the JavaScript class already initialises its own, and pushing ours
 * over the top would be both slow and a way to introduce disagreements that only show up as a
 * control drawn subtly wrong. Only what the source actually says is sent -- the `Set` statements in
 * a class's `Construct_Object`, which is where a class changes a default (`cWebButton` does
 * `Set pbShowLabel to False`), and the `Set` statements in the object itself.
 */
import { DfNode, Range, SourceUnit, walk } from '@vscode-dataflex/parser';
import { SymbolIndex, argumentTokensBeforeTo, constantValue, valueTokensAfterTo } from '@vscode-dataflex/workspace';
import { PreviewValue, ValueResolver, coerce } from './values';

/** A published property a control exposes to the browser. */
interface ClientProperty {
  name: string;
  /** DataFlex declared type, which decides what the value has to be forced to. */
  type?: string;
}

/** A class entry, as `initJSON` reads it. */
export interface PreviewClass {
  hClassId: number;
  /** The JavaScript constructor, resolved off the global `df` namespace. */
  sType: string;
  props: Record<string, PreviewValue>;
  advProps: Record<string, PreviewValue>;
}

/** An object entry, as `initJSON` reads it. */
export interface PreviewObject {
  sName: string;
  hClassId: number;
  props: Record<string, PreviewValue>;
  advProps: Record<string, PreviewValue>;
  aObjs: PreviewObject[];
}

/** The definition itself: everything `initJSON` needs and nothing else. */
export interface PreviewDefinition {
  aClasses: PreviewClass[];
  obj: PreviewObject;
}

/** Something the model could not do, reported rather than silently dropped. */
export interface PreviewProblem {
  message: string;
  range: Range;
}

/**
 * Where an object was written.
 *
 * `file` is absent for the document being previewed and set for anything else, which is what a
 * class-declared subobject is: `Object oModuleIcon is a cWebImage` belongs to
 * `cDashboardTileWidget.wo`, not to the view that instantiates the widget. Absent rather than
 * always-present so the common case stays a range and the extension only has to open another
 * document when there is one to open.
 */
export interface PreviewRange {
  range: Range;
  file?: string;
}

export interface PreviewModel {
  definition: PreviewDefinition;
  /**
   * Name of the object to render, or `undefined` when the file has nothing renderable.
   *
   * A view is rendered on its own rather than through `displayApp`, so the webview needs to know
   * which child of the synthesised app to show.
   */
  view?: string;
  /**
   * Source range of each object, keyed by its dotted long name (`oCustomer.oMainPanel.oName`), so
   * clicking a control can reveal its source.
   *
   * The long name and not the bare name because that is the framework's own identity for an
   * object: `df.BaseApp#findObj` splits on `.` and walks the tree, and `getLongName()` produces the
   * same string. A bare name would also collide the moment two panels each have an `oName`.
   */
  ranges: Record<string, PreviewRange>;
  problems: PreviewProblem[];
}

/** The JavaScript class every definition is rooted at; `initJSON` treats it as the app itself. */
const APP_TYPE = 'df.WebApp';

/**
 * The wrapper a lone custom control is previewed inside.
 *
 * A `.pkg` declaring `Class cMyWidget is a cWebWidget` has nothing to render into: a control needs
 * a view and a panel above it before the framework will lay it out. These are looked up by
 * DataFlex name rather than hard-coded to `df.WebView` / `df.WebPanel` so that a workspace on a
 * different Web UI version gets whatever that version calls them.
 */
const HOST_VIEW_CLASS = 'cWebView';
const HOST_PANEL_CLASS = 'cWebPanel';
/** The wrapper objects' names. Not in anyone's source, so they cannot collide with one. */
const HOST_VIEW_NAME = 'oPreviewHostView';
const HOST_PANEL_NAME = 'oPreviewHostPanel';
const HOST_CONTROL_NAME = 'oPreviewControl';

/**
 * The widget container's three classes, again by DataFlex name rather than by JavaScript one.
 *
 * A `cWebWidgetContainer` does not hold its widgets. `RegisterChildWebObject` intercepts every
 * `cWebWidget` child, keeps it out of the client tree entirely and collects it into
 * `paDefaultWidgets`; `End_Construct_Object` then creates a `cWebWidgetContainerInternal` -- the
 * grid the widgets are actually laid out in, the wrapper itself being flow -- and
 * `LoadConfigurationEx` re-creates the widgets as dynamic children of that. So a definition built
 * from the source nesting draws widgets in the wrong parent, with no grid. See `docs/PREVIEW.md`.
 */
const WIDGET_CONTAINER_CLASS = 'cWebWidgetContainer';
const WIDGET_HOST_CLASS = 'cWebWidgetContainerInternal';
const WIDGET_CLASS = 'cWebWidget';
/** The synthesised internal container's name. Not in anyone's source. */
const WIDGET_HOST_NAME = 'oPreviewWidgetHost';
/**
 * What `LoadConfigurationEx` copies from the wrapper onto the internal container, verbatim.
 *
 * It has to be copied here rather than left to the framework: `initJSON` applies a parent's
 * properties before its children exist, so `df.WebWidgetContainer#set_piColumnCount`'s forward to
 * `this._oWidgetContainer` runs against a null and is lost.
 */
const WIDGET_GRID_PROPS = ['piRowCount', 'piColumnCount', 'psDefaultRowHeight', 'psDefaultColumnWidth'];

export interface PreviewOptions {
  /**
   * How to read a file the index points at, for tests that have no disk.
   *
   * Class defaults and enum constants live in packages the index knows the path of but not the
   * text of, so building a model means reading them.
   */
  readFile?: (path: string) => string | undefined;
  /**
   * The responsive mode to build for, as an `rm*` constant value (`rmTablet` is 20).
   *
   * Absent, or negative, means no `WebSetResponsive` rule is applied and the definition is the
   * base layout -- which is also what the framework does before its mode controller reports in
   * (`peMode` starts at -1, and `enforceRule` does nothing while it is below zero).
   */
  mode?: number;
}

/**
 * Builds the definition for one source file.
 *
 * `unit` is the parsed file; `index` supplies the class graph, which is what turns
 * `is a cWebForm` into `df.WebForm` and decides which properties are client-side.
 */
export function buildPreviewModel(
  unit: SourceUnit,
  index: SymbolIndex,
  options: PreviewOptions = {}
): PreviewModel {
  return new Builder(unit, index, options).build();
}

/** A path or `file:` uri reduced to something two spellings of the same file agree on. */
function normalizePath(pathOrUri: string): string {
  const withoutScheme = pathOrUri.replace(/^file:\/{2,3}/i, '');
  return decodeURIComponent(withoutScheme).replace(/\\/g, '/').toLowerCase();
}

class Builder {
  private readonly resolver: ValueResolver;
  private readonly classIds = new Map<string, number>();
  /** `membersOf` is cached in the index, but filtering it per object is not. */
  private readonly clientCache = new Map<string, Map<string, ClientProperty>>();
  private readonly classes: PreviewClass[] = [];
  private readonly ranges: Record<string, PreviewRange> = {};
  private readonly problems: PreviewProblem[] = [];
  /**
   * Classes whose body is being expanded right now, so a cycle terminates.
   *
   * `Class cPanel is a cWebPanel` whose body declares `Object oInner is a cPanel` is legal source
   * that never runs -- DataFlex would recurse in `Construct_Object` too -- but it must not hang the
   * language server on the way to saying so.
   */
  private readonly expanding = new Set<string>();
  private nextClassId = 1;

  constructor(
    private readonly unit: SourceUnit,
    private readonly index: SymbolIndex,
    private readonly options: PreviewOptions
  ) {
    this.resolver = new ValueResolver(index, options.readFile);
  }

  build(): PreviewModel {
    const app: PreviewObject = {
      sName: '',
      hClassId: this.classIdFor(APP_TYPE, APP_TYPE),
      props: {},
      advProps: {},
      aObjs: []
    };

    const view = this.rootObject() ?? this.controlHost();
    if (view !== undefined) {
      app.aObjs.push(view);
    }

    return {
      definition: { aClasses: this.classes, obj: app },
      view: view?.sName,
      ranges: this.ranges,
      problems: this.problems
    };
  }

  /** The outermost `Object ... is a <class>` in the file, which for a `.wo` is the view. */
  private rootObject(): PreviewObject | undefined {
    const top = (this.unit.root.children ?? []).find((node) => node.kind === 'object');
    return top === undefined ? undefined : this.objectFrom(top, this.unit, undefined);
  }

  /**
   * A scratch view wrapping the control class this file declares.
   *
   * Only used when the file declares no object, which is what a custom control package looks like.
   * The wrapper is not in anyone's source, so it gets a name that cannot collide with one.
   */
  private controlHost(): PreviewObject | undefined {
    const declared = (this.unit.root.children ?? []).find(
      (node) => node.kind === 'class' && node.name !== undefined
    );
    if (declared?.name === undefined) {
      return undefined;
    }

    const type = this.jsClassOf(declared.name);
    if (type === undefined) {
      this.problems.push({
        message: `${declared.name} is not a web control: no DesignerJSClass tag and no psJSClass, in it or anything it inherits from.`,
        range: declared.nameRange ?? declared.headerRange
      });
      return undefined;
    }

    const viewType = this.jsClassOf(HOST_VIEW_CLASS);
    const panelType = this.jsClassOf(HOST_PANEL_CLASS);
    if (viewType === undefined || panelType === undefined) {
      this.problems.push({
        message: `Cannot preview a control on its own: ${HOST_VIEW_CLASS} and ${HOST_PANEL_CLASS} are not in this workspace's index, so there is nothing to host it in.`,
        range: declared.nameRange ?? declared.headerRange
      });
      return undefined;
    }

    const path = [HOST_VIEW_NAME, HOST_PANEL_NAME, HOST_CONTROL_NAME].join('.');
    const instance: PreviewObject = {
      sName: HOST_CONTROL_NAME,
      hClassId: this.classIdFor(declared.name, type, this.classDefaults(declared.name)),
      props: {},
      advProps: {},
      // The class's own subobjects, the same as for an instance written in a view -- otherwise a
      // widget previewed on its own is the one place it draws as the empty box it never is.
      aObjs: this.childrenOf(undefined, declared.name, this.unit, undefined, path).map(
        (child) => child.object
      )
    };
    this.ranges[path] = {
      range: declared.range
    };

    return {
      sName: HOST_VIEW_NAME,
      hClassId: this.classIdFor(HOST_VIEW_CLASS, viewType),
      props: { psCaption: declared.name },
      advProps: {},
      aObjs: [
        {
          sName: HOST_PANEL_NAME,
          hClassId: this.classIdFor(HOST_PANEL_CLASS, panelType),
          props: {},
          advProps: {},
          aObjs: [instance]
        }
      ]
    };
  }

  /**
   * One `Object ... End_Object` and everything under it.
   *
   * `unit` is the file the object is written in and `file` its path, absent for the document being
   * previewed. The two travel with the node because an object is no longer necessarily from the
   * previewed file: a class's own subobjects are expanded into every instance of it, the way
   * `Construct_Object` creates them at runtime, and those are written wherever the class is.
   *
   * `parentPath` is the dotted long name of the enclosing object, empty at the top, which is how
   * `ranges` gets keyed the way the framework names things.
   */
  private objectFrom(
    node: DfNode,
    unit: SourceUnit,
    file: string | undefined,
    parentPath = ''
  ): PreviewObject | undefined {
    if (node.name === undefined || node.superClass === undefined) {
      return undefined;
    }
    const path = parentPath === '' ? node.name : `${parentPath}.${node.name}`;

    const type = this.jsClassOf(node.superClass);
    if (type === undefined) {
      this.problems.push({
        message: `${node.name} is a ${node.superClass}, which has no JavaScript class, so it cannot be drawn. Windows controls and non-visual objects have none.`,
        range: node.nameRange ?? node.headerRange
      });
      return undefined;
    }

    const object: PreviewObject = {
      sName: node.name,
      hClassId: this.classIdFor(node.superClass, type, this.classDefaults(node.superClass)),
      props: this.instanceProps(node, node.superClass, unit),
      advProps: {},
      aObjs: []
    };
    this.ranges[path] = file === undefined ? { range: node.range } : { range: node.range, file };

    const children = this.childrenOf(node, node.superClass, unit, file, path);
    if (this.descendsFrom(node.superClass, WIDGET_CONTAINER_CLASS)) {
      object.aObjs = this.hostWidgets(children, node, node.superClass, object, path);
    } else {
      object.aObjs = children.map((child) => child.object);
    }

    return object;
  }

  /**
   * The children of an object: what its class declares first, then what the object itself does.
   *
   * That order is `Construct_Object`'s. A class's subobjects are created while the class is
   * constructing, before the object body's own `Object ... End_Object`s are reached, and the
   * framework lays a container's children out in the order they were added.
   *
   * Each child carries which class expanded it (`from`), which is what lets a widget container tell
   * its widgets apart from the rest without looking at the tree twice.
   */
  private childrenOf(
    node: DfNode | undefined,
    className: string,
    unit: SourceUnit,
    file: string | undefined,
    path: string
  ): { object: PreviewObject; superClass: string }[] {
    const built: { object: PreviewObject; superClass: string }[] = [];
    const taken = new Set<string>();

    const add = (
      child: DfNode,
      childUnit: SourceUnit,
      childFile: string | undefined
    ): void => {
      if (child.name === undefined || child.superClass === undefined) {
        return;
      }
      // DataFlex would refuse the duplicate, and `initJSON` would silently overwrite
      // `oParent[sName]` with the second one, losing the first and everything under it.
      if (taken.has(child.name.toLowerCase())) {
        return;
      }
      const object = this.objectFrom(child, childUnit, childFile, path);
      if (object !== undefined) {
        taken.add(child.name.toLowerCase());
        built.push({ object, superClass: child.superClass });
      }
    };

    // The cycle guard is held for the whole expansion, not just for finding the objects: what
    // recurses is building them, and by the time the first one is built the class would otherwise
    // be off the stack again and free to expand itself once more.
    const key = className.toLowerCase();
    if (!this.expanding.has(key)) {
      this.expanding.add(key);
      try {
        for (const declared of this.classBodyObjects(className)) {
          add(declared.node, declared.unit, declared.file);
        }
      } finally {
        this.expanding.delete(key);
      }
    }

    for (const child of node?.children ?? []) {
      if (child.kind === 'object') {
        add(child, unit, file);
      }
    }

    return built;
  }

  /**
   * The objects a class and its ancestors declare, base-first.
   *
   * `Composite cDashboardTileWidget is a cWebWidget` writes them straight in the body;
   * `Class ... / Procedure Construct_Object / Object ...` nests them under the procedure. Both are
   * the same thing to the runtime and both are found here, because the test is not "a direct child
   * of the class node" but "the nearest enclosing class or object is this class" -- an object
   * inside another object belongs to that one and is reached by the recursion instead.
   *
   * Base-first because that is the order the constructors run in: `cDashboardProjectTileWidget`'s
   * own subobjects come after the ones it inherits from `cDashboardTileWidget`.
   */
  private classBodyObjects(
    className: string
  ): { node: DfNode; unit: SourceUnit; file: string | undefined }[] {
    const found: { node: DfNode; unit: SourceUnit; file: string | undefined }[] = [];
    for (const record of [...this.index.resolveChain(className)].reverse()) {
      const unit = this.unitForClass(record);
      if (unit === undefined) {
        continue;
      }
      const file = this.isCurrentFile(record.file) ? undefined : record.file;
      walk(unit.root, (node, parents) => {
        if (node.kind !== 'object') {
          return undefined;
        }
        if (!this.declaredDirectlyIn(record.name, parents)) {
          return undefined;
        }
        found.push({ node, unit, file });
        // Its own children are this object's, not the class's.
        return false;
      });
    }
    return found;
  }

  /**
   * Whether a node sitting under `parents` belongs to the body of `className` itself.
   *
   * The nearest enclosing class *or object* has to be the class: an object in between means the
   * node belongs to that object, which is what keeps `Set piHeight to 200` written inside a class's
   * `Object oModuleIcon is a cWebImage` from being read as a default of the class.
   */
  private declaredDirectlyIn(className: string, parents: readonly DfNode[]): boolean {
    const owner = [...parents].reverse().find((p) => p.kind === 'class' || p.kind === 'object');
    return owner?.kind === 'class' && owner.name?.toLowerCase() === className.toLowerCase();
  }

  /**
   * Puts a widget container's widgets where the runtime puts them.
   *
   * `RegisterChildWebObject` keeps every `cWebWidget` out of the wrapper's client tree, and
   * `LoadConfigurationEx` re-creates them under the internal container after copying the grid
   * across. Anything that is not a widget -- the context menu the container makes for itself, say
   * -- is forwarded to the normal registration and stays on the wrapper.
   */
  private hostWidgets(
    children: { object: PreviewObject; superClass: string }[],
    node: DfNode,
    className: string,
    wrapper: PreviewObject,
    path: string
  ): PreviewObject[] {
    const hostType = this.jsClassOf(WIDGET_HOST_CLASS);
    if (hostType === undefined) {
      this.problems.push({
        message:
          `${node.name} is a ${node.superClass}, but ${WIDGET_HOST_CLASS} is not in this ` +
          `workspace's index, so its widgets are drawn directly in it rather than in the grid the ` +
          `running application would lay them out in.`,
        range: node.nameRange ?? node.headerRange
      });
      return children.map((child) => child.object);
    }

    const host: PreviewObject = {
      sName: WIDGET_HOST_NAME,
      hClassId: this.classIdFor(
        WIDGET_HOST_CLASS,
        hostType,
        this.classDefaults(WIDGET_HOST_CLASS)
      ),
      props: {},
      advProps: {},
      aObjs: []
    };
    // The grid is the container's, so a click on an empty cell reveals the container.
    this.ranges[`${path}.${WIDGET_HOST_NAME}`] = this.ranges[path] ?? { range: node.range };

    // What the wrapper is actually running with: its class defaults, overlaid with what the object
    // sets, responsive rules already applied. `LoadConfigurationEx` reads the same four off it.
    const effective = { ...this.classDefaults(className), ...wrapper.props };
    for (const name of WIDGET_GRID_PROPS) {
      const value = effective[name];
      if (value !== undefined) {
        host.props[name] = value;
      }
    }

    const hostPath = `${path}.${WIDGET_HOST_NAME}`;
    const rest: PreviewObject[] = [];
    for (const child of children) {
      if (this.descendsFrom(child.superClass, WIDGET_CLASS)) {
        host.aObjs.push(child.object);
        this.rekey(`${path}.${child.object.sName}`, `${hostPath}.${child.object.sName}`);
      } else {
        rest.push(child.object);
      }
    }

    return [host, ...rest];
  }

  /**
   * Moves an object's `ranges` entries, and its subtree's, from one dotted long name to another.
   *
   * The keys are what `findObj` walks, so a widget that moved into the internal container has to be
   * keyed by where it ended up -- otherwise every click inside one reveals nothing.
   */
  private rekey(from: string, to: string): void {
    for (const key of Object.keys(this.ranges)) {
      if (key === from || key.startsWith(`${from}.`)) {
        this.ranges[to + key.slice(from.length)] = this.ranges[key]!;
        delete this.ranges[key];
      }
    }
  }

  /** Whether a class is, or inherits from, another -- `IsClassOfClass`, off the index. */
  private descendsFrom(className: string, ancestor: string): boolean {
    const wanted = ancestor.toLowerCase();
    return this.index
      .resolveChain(className)
      .some((record) => record.name.toLowerCase() === wanted);
  }

  /**
   * `Set <property> to <value>` written directly in the object body.
   *
   * Only client-side published properties are forwarded. That filter is not tidiness: it is what
   * keeps `Set Main_File to Customer.File_Number` and `Set psJSClass to "df.WebForm"` -- neither of
   * which means anything in the browser -- from being pushed onto a JavaScript control, where
   * `initJSON` would happily create a property nothing reads.
   */
  /**
   * Applies the `WebSetResponsive` rules that a given mode would activate.
   *
   * Responsive values never travel in `initJSON`. `cWebObject_mixin.PassPropertyRules` sends each
   * one to the client separately as a `propRule` client action, and the client applies them for
   * whichever mode it detects -- so a statically built definition is the desktop base layout and
   * nothing else. Rebuilding that here is what lets a tablet or phone layout be inspected without
   * a server.
   *
   * The selection rule is the framework's own, from `df.WebObject#enforceRule`: rules are held
   * sorted by mode descending, and the first whose mode is **less than or equal to** the active
   * one wins. So it is a threshold, not an exact match -- a rule written for `rmTablet` (20) is
   * still in force at `rmTabletPortrait` (22) unless a more specific rule outranks it. Reproduced
   * rather than tidied: a landscape rule leaking into portrait when no portrait rule exists is
   * what the running application does.
   */
  private applyResponsive(
    props: Record<string, PreviewValue>,
    node: DfNode,
    unit: SourceUnit,
    client: Map<string, ClientProperty>
  ): void {
    const mode = this.options.mode;
    if (mode === undefined || mode < 0) {
      return;
    }

    // property -> the winning rule so far
    const winner = new Map<string, { mode: number; value: PreviewValue }>();

    for (const child of node.children ?? []) {
      if (child.verb !== 'websetresponsive' || child.target === undefined) {
        continue;
      }
      if (child.ofObject !== undefined) {
        continue;
      }
      const declared = client.get(child.target.toLowerCase());
      if (declared === undefined) {
        continue;
      }

      // `WebSetResponsive <property> <mode> to <value>`: the mode is the last argument before `to`.
      const args = argumentTokensBeforeTo(unit, child);
      const modeToken = args[args.length - 1];
      const ruleMode =
        modeToken === undefined ? undefined : constantValue(this.index, modeToken.text);
      const value = this.resolver.resolve(valueTokensAfterTo(unit, child));

      if (typeof ruleMode !== 'number' || value === undefined) {
        this.problems.push({
          message:
            `${node.name}: could not work out the responsive rule for ${child.target}, so the ` +
            'base value is used.',
          range: child.headerRange
        });
        continue;
      }
      if (ruleMode > mode) {
        continue;
      }
      const standing = winner.get(declared.name);
      if (standing === undefined || ruleMode >= standing.mode) {
        winner.set(declared.name, { mode: ruleMode, value: coerce(value, declared.type) });
      }
    }

    for (const [name, rule] of winner) {
      props[name] = rule.value;
    }
  }

  private instanceProps(
    node: DfNode,
    className: string,
    unit: SourceUnit
  ): Record<string, PreviewValue> {
    const client = this.clientProperties(className);
    const props: Record<string, PreviewValue> = {};

    for (const child of node.children ?? []) {
      if (child.kind !== 'statement' || child.verb !== 'set' || child.target === undefined) {
        continue;
      }
      // `Set psLabel of oInner to "x"` belongs to oInner, which reaches this on its own turn.
      if (child.ofObject !== undefined) {
        continue;
      }
      const declared = client.get(child.target.toLowerCase());
      if (declared === undefined) {
        continue;
      }
      const value = this.resolver.resolve(valueTokensAfterTo(unit, child));
      if (value === undefined) {
        this.problems.push({
          message: `${node.name}: could not work out what ${child.target} is set to, so the class default is used.`,
          range: child.headerRange
        });
        continue;
      }
      props[declared.name] = coerce(value, declared.type);
    }

    this.applyResponsive(props, node, unit, client);
    return props;
  }

  /**
   * Defaults a class sets on itself, gathered up its inheritance chain.
   *
   * `cWebButton` does `Set pbShowLabel to False` in `Construct_Object`, and a button drawn without
   * that has a stray empty label beside it. Walking nearest-last means a subclass overwrites what
   * its parent set, which is the order the constructors actually run in.
   */
  private classDefaults(className: string): Record<string, PreviewValue> {
    const client = this.clientProperties(className);
    const props: Record<string, PreviewValue> = {};

    for (const record of [...this.index.resolveChain(className)].reverse()) {
      const unit = this.unitForClass(record);
      if (unit === undefined) {
        continue;
      }
      walk(unit.root, (node, parents) => {
        if (node.kind !== 'statement' || node.verb !== 'set' || node.target === undefined) {
          return;
        }
        if (node.ofObject !== undefined) {
          return;
        }
        // Only this class's own body -- a file may declare several -- and only the body itself.
        // A `Set` inside one of the class's own subobjects is that object's: reading
        // `Set piHeight to 200` from a widget's `Object oModuleIcon is a cWebImage` as a default of
        // the widget gave every instance of the class the icon's height.
        if (!this.declaredDirectlyIn(record.name, parents)) {
          return;
        }
        const declared = client.get(node.target.toLowerCase());
        if (declared === undefined) {
          return;
        }
        const value = this.resolver.resolve(valueTokensAfterTo(unit, node));
        if (value !== undefined) {
          props[declared.name] = coerce(value, declared.type);
        }
      });
    }

    return props;
  }

  /**
   * The parsed file a class is declared in.
   *
   * The class may be declared in the file being previewed. Reading that one back off disk would use
   * the last saved version, so a default changed in the editor would not show up until save -- and
   * the parsed buffer is right here.
   */
  private unitForClass(record: { file: string }): SourceUnit | undefined {
    return this.isCurrentFile(record.file) ? this.unit : this.resolver.unitOf(record.file);
  }

  /**
   * Whether an indexed file is the one being previewed.
   *
   * The index stores absolute paths and the parsed unit carries whatever the caller passed, which
   * from the language server is a `file:///c%3A/...` document uri. Comparing the decoded tails is
   * what makes the two meet; a false negative here costs a re-parse, never a wrong answer.
   */
  private isCurrentFile(file: string): boolean {
    const current = this.unit.uri;
    if (current === undefined) {
      return false;
    }
    return normalizePath(current) === normalizePath(file);
  }

  /**
   * Client-side published properties of a class, by lower-cased name.
   *
   * The declared type comes along because the value has to be forced to it before it is sent; see
   * `coerce`.
   */
  private clientProperties(className: string): Map<string, ClientProperty> {
    const cached = this.clientCache.get(className.toLowerCase());
    if (cached !== undefined) {
      return cached;
    }

    const properties = new Map<string, ClientProperty>();
    for (const member of this.index.membersOf(className)) {
      if (member.webProperty === 'Client') {
        properties.set(member.name.toLowerCase(), { name: member.name, type: member.type });
      }
    }
    this.clientCache.set(className.toLowerCase(), properties);
    return properties;
  }

  /**
   * The JavaScript class for a DataFlex class, or that of the nearest ancestor declaring one.
   *
   * Inheriting the answer is not a fallback but the normal case: an application's
   * `Class cCustomerForm is a cWebForm` names no JavaScript class of its own and is drawn by
   * `df.WebForm`, exactly as the runtime does it.
   */
  private jsClassOf(className: string): string | undefined {
    for (const record of this.index.resolveChain(className)) {
      if (record.jsClass !== undefined) {
        return record.jsClass;
      }
    }
    return undefined;
  }

  /**
   * The id for a DataFlex class, adding it to the table on first sight.
   *
   * Keyed on the DataFlex class, not the JavaScript one. Two classes routinely share a JavaScript
   * class -- an application's `cCustomerForm is a cWebForm` is drawn by `df.WebForm` just as
   * `cWebForm` is -- while setting entirely different defaults on themselves, and keying on the
   * JavaScript name would silently give the second one the first one's defaults. `initJSON` is
   * happy with two entries naming the same `sType`.
   */
  private classIdFor(
    dataflexClass: string,
    type: string,
    props: Record<string, PreviewValue> = {}
  ): number {
    const key = dataflexClass.toLowerCase();
    const existing = this.classIds.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const id = this.nextClassId++;
    this.classIds.set(key, id);
    this.classes.push({ hClassId: id, sType: type, props, advProps: {} });
    return id;
  }
}
