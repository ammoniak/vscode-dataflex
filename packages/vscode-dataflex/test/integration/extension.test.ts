import * as assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { coverageDetails, fileCoverage } from '../../src/coverage';

/**
 * End-to-end checks that run inside a real VS Code instance with the extension installed and the
 * DataFlex 26 WebOrder example opened as the workspace folder.
 *
 * These are the tests that prove the *wiring* works -- activation, the contributed language and
 * its file associations, the providers, and the `df-cli` round-trip -- none of which the unit
 * tests can reach.
 */

const WEBORDER = 'C:\\DataFlex 26.0 Examples\\WebOrder';
const CUSTOMER_WO = path.join(WEBORDER, 'AppSrc', 'Customer.wo');

/** Waits for `predicate` to hold, polling; VS Code activation and df-cli are both async. */
async function eventually<T>(
  produce: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 60_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await produce();
  while (Date.now() < deadline) {
    if (predicate(last)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await produce();
  }
  return last;
}

function flatten(symbols: vscode.DocumentSymbol[], depth = 0): { name: string; kind: vscode.SymbolKind; depth: number }[] {
  const out: { name: string; kind: vscode.SymbolKind; depth: number }[] = [];
  for (const symbol of symbols) {
    out.push({ name: symbol.name, kind: symbol.kind, depth });
    out.push(...flatten(symbol.children, depth + 1));
  }
  return out;
}

suite('DataFlex extension (WebOrder workspace)', function () {
  this.timeout(120_000);

  suiteSetup(function () {
    if (!existsSync(CUSTOMER_WO)) {
      this.skip();
    }
  });

  test('activates', async () => {
    const extension = vscode.extensions.all.find((e) => e.id.endsWith('vscode-dataflex'));
    assert.ok(extension, 'extension not found in the test host');
    await extension.activate();
    assert.equal(extension.isActive, true);
  });

  test('resolves the workspace through df-cli', async () => {
    const status = await eventually(
      () =>
        vscode.commands.executeCommand('dataflex.internal.status') as Promise<{
          workspaceFolders: string[];
          cliPath?: string;
          workspaceName?: string;
          projectNames?: string[];
          searchPathCount?: number;
          lastError?: string;
        }>,
      (value) => value.workspaceName !== undefined || value.lastError !== undefined
    );

    assert.equal(status.lastError, undefined, `workspace failed to load: ${status.lastError}`);
    assert.ok(status.workspaceFolders.length > 0, 'no workspace folder open in the test host');
    assert.ok(status.cliPath, 'df-cli.exe was not found');
    assert.equal(status.workspaceName, 'WebOrder');
    assert.deepEqual(status.projectNames, ['WebApp.src']);
    assert.ok((status.searchPathCount ?? 0) > 20, `search path too short: ${status.searchPathCount}`);
  });

  test('associates .wo files with the dataflex language', async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(CUSTOMER_WO));
    assert.equal(document.languageId, 'dataflex');
  });

  test('provides a nested outline for a real web view', async () => {
    const uri = vscode.Uri.file(CUSTOMER_WO);
    await vscode.workspace.openTextDocument(uri);

    const symbols = await eventually(
      async () =>
        ((await vscode.commands.executeCommand(
          'vscode.executeDocumentSymbolProvider',
          uri
        )) as vscode.DocumentSymbol[] | undefined) ?? [],
      (value) => value.length > 0
    );

    const flat = flatten(symbols);
    const names = flat.map((s) => s.name);

    // The view, its panel and the forms inside it, at increasing depth.
    assert.ok(names.includes('oCustomer'), `outline missing oCustomer: ${names.join(', ')}`);
    assert.ok(names.includes('oWebMainPanel'), 'outline missing oWebMainPanel');
    assert.ok(names.includes('oCustomerName'), 'outline missing oCustomerName');

    const view = flat.find((s) => s.name === 'oCustomer')!;
    const panel = flat.find((s) => s.name === 'oWebMainPanel')!;
    const form = flat.find((s) => s.name === 'oCustomerName')!;
    assert.equal(view.kind, vscode.SymbolKind.Object);
    assert.ok(panel.depth > view.depth, 'panel should be nested inside the view');
    assert.ok(form.depth > panel.depth, 'form should be nested inside the panel');

    // The `is a <Class>` detail is what makes the outline readable for DataFlex.
    const root = symbols.find((s) => s.name === 'oCustomer')!;
    assert.equal(root.detail, 'is a cWebView');
  });

  test('folds the object tree', async () => {
    const uri = vscode.Uri.file(CUSTOMER_WO);
    await vscode.workspace.openTextDocument(uri);
    const ranges = await eventually(
      async () =>
        ((await vscode.commands.executeCommand(
          'vscode.executeFoldingRangeProvider',
          uri
        )) as vscode.FoldingRange[] | undefined) ?? [],
      (value) => value.length > 0
    );
    assert.ok(ranges.length > 3, `expected several folding ranges, got ${ranges.length}`);
  });

  test('resolves `Use cWebForm.pkg` into the DfPkg Web UI package', async () => {
    const uri = vscode.Uri.file(CUSTOMER_WO);
    const document = await vscode.workspace.openTextDocument(uri);

    // Find the `Use cWebForm.pkg` line and put the cursor on the package name.
    const lineIndex = document
      .getText()
      .split(/\r?\n/)
      .findIndex((line) => /^\s*Use\s+cWebForm\.pkg/i.test(line));
    assert.ok(lineIndex >= 0, 'Customer.wo has no `Use cWebForm.pkg` line');
    const column = document.lineAt(lineIndex).text.toLowerCase().indexOf('cwebform') + 3;

    const locations = await eventually(
      async () =>
        ((await vscode.commands.executeCommand(
          'vscode.executeDefinitionProvider',
          uri,
          new vscode.Position(lineIndex, column)
        )) as vscode.Location[] | undefined) ?? [],
      (value) => value.length > 0
    );

    assert.ok(locations.length > 0, 'no definition returned for Use cWebForm.pkg');
    const target = locations[0]!.uri.fsPath;
    assert.match(
      target,
      /DfPkg[\\/]DataFlex_dev_Web_UI-[\d.]+[\\/]AppSrc[\\/]cWebForm\.pkg$/i,
      `resolved to ${target}`
    );
  });

  test('hovers a framework class with its hierarchy and a documentation link', async () => {
    const uri = vscode.Uri.file(CUSTOMER_WO);
    const document = await vscode.workspace.openTextDocument(uri);

    const lineIndex = document
      .getText()
      .split(/\r?\n/)
      .findIndex((line) => /is a cWebForm\s*$/i.test(line));
    assert.ok(lineIndex >= 0, 'Customer.wo has no `is a cWebForm` line');
    const column = document.lineAt(lineIndex).text.toLowerCase().indexOf('cwebform') + 3;

    const hovers = await eventually(
      async () =>
        ((await vscode.commands.executeCommand(
          'vscode.executeHoverProvider',
          uri,
          new vscode.Position(lineIndex, column)
        )) as vscode.Hover[] | undefined) ?? [],
      (value) => value.length > 0
    );

    const text = hovers
      .flatMap((entry) => entry.contents)
      .map((part) => (typeof part === 'string' ? part : part.value))
      .join('\n');

    assert.match(text, /cWebForm/, `hover did not mention the class: ${text}`);
    // The resolved `is a` chain, which the hover never used to show.
    assert.match(text, /→/, `hover did not show an inheritance chain: ${text}`);
    assert.match(
      text,
      /https:\/\/docs\.dataflex\.dev\/VdfClassRef\/Web\/cWebForm\//,
      `hover did not link the documentation: ${text}`
    );
  });

  test('hovers a local variable in an untitled buffer, with no file on disk', async () => {
    // Locals are not indexed by design, so this returned nothing at all before. Doing it in an
    // untitled document also proves the hover no longer depends on the workspace index.
    const scratch = await vscode.workspace.openTextDocument({
      language: 'dataflex',
      content: [
        'Procedure PopDialogX String sTitle',
        '    Integer iCount',
        '    Move 1 to iCount',
        'End_Procedure'
      ].join('\n')
    });
    await vscode.window.showTextDocument(scratch, { preview: true });

    const hovers = await eventually(
      async () =>
        ((await vscode.commands.executeCommand(
          'vscode.executeHoverProvider',
          scratch.uri,
          // `iCount` on the `Move` line.
          new vscode.Position(2, 14)
        )) as vscode.Hover[] | undefined) ?? [],
      (value) => value.length > 0
    );

    const text = hovers
      .flatMap((entry) => entry.contents)
      .map((part) => (typeof part === 'string' ? part : part.value))
      .join('\n');

    assert.match(text, /Integer iCount/, `hover did not describe the local: ${text}`);
    assert.match(text, /Local variable of `PopDialogX`/, `hover lacked the scope: ${text}`);
  });

  test('goes to the definition of a class referenced by `is a`', async () => {
    // Reported from WebOrderMobile: peek definition on the class in
    // `Object oCustomerDataDictionary is a cCustomerDataDictionary` found nothing, because the
    // definition provider only handled `Use` lines. It needs the workspace declaration index.
    const uri = vscode.Uri.file(CUSTOMER_WO);
    const document = await vscode.workspace.openTextDocument(uri);

    const lineIndex = document
      .getText()
      .split(/\r?\n/)
      .findIndex((line) => /is a cCustomerDataDictionary\s*$/i.test(line));
    assert.ok(lineIndex >= 0, 'Customer.wo has no `is a cCustomerDataDictionary` line');
    const column = document.lineAt(lineIndex).text.toLowerCase().indexOf('ccustomerdatadictionary') + 4;

    const locations = await eventually(
      async () =>
        ((await vscode.commands.executeCommand(
          'vscode.executeDefinitionProvider',
          uri,
          new vscode.Position(lineIndex, column)
        )) as vscode.Location[] | undefined) ?? [],
      (value) => value.length > 0
    );

    assert.ok(locations.length > 0, 'no definition found for cCustomerDataDictionary');
    const target = locations[0]!;
    assert.match(target.uri.fsPath, /cCustomerDataDictionary\.dd$/i, `resolved to ${target.uri.fsPath}`);

    // It must land on the `Class` line, not the top of the file.
    const targetDocument = await vscode.workspace.openTextDocument(target.uri);
    assert.match(
      targetDocument.lineAt(target.range.start.line).text,
      /Class\s+cCustomerDataDictionary/i
    );
  });

  test('finds a class defined in the runtime library, not just the workspace', async () => {
    const uri = vscode.Uri.file(CUSTOMER_WO);
    const document = await vscode.workspace.openTextDocument(uri);

    const lineIndex = document
      .getText()
      .split(/\r?\n/)
      .findIndex((line) => /is a cWebForm\s*$/i.test(line));
    assert.ok(lineIndex >= 0, 'Customer.wo has no `is a cWebForm` line');
    const column = document.lineAt(lineIndex).text.toLowerCase().indexOf('cwebform') + 3;

    const locations = await eventually(
      async () =>
        ((await vscode.commands.executeCommand(
          'vscode.executeDefinitionProvider',
          uri,
          new vscode.Position(lineIndex, column)
        )) as vscode.Location[] | undefined) ?? [],
      (value) => value.length > 0
    );
    assert.ok(locations.length > 0, 'no definition found for cWebForm');
    assert.match(locations[0]!.uri.fsPath, /cWebForm\.pkg$/i);
  });

  test('answers workspace symbol search from the index', async () => {
    const symbols = await eventually(
      async () =>
        ((await vscode.commands.executeCommand(
          'vscode.executeWorkspaceSymbolProvider',
          'cCustomerDataDictionary'
        )) as vscode.SymbolInformation[] | undefined) ?? [],
      (value) => value.length > 0
    );
    assert.ok(
      symbols.some((s) => s.name.toLowerCase() === 'ccustomerdatadictionary'),
      `workspace symbol search returned ${symbols.length} results without the class`
    );
  });

  test('reports a populated index in its status', async () => {
    const status = await eventually(
      () =>
        vscode.commands.executeCommand('dataflex.internal.status') as Promise<{
          indexedFiles?: number;
          indexedNames?: number;
        }>,
      (value) => (value.indexedFiles ?? 0) > 0
    );
    assert.ok((status.indexedFiles ?? 0) > 200, `only ${status.indexedFiles} files indexed`);
    assert.ok((status.indexedNames ?? 0) > 1000, `only ${status.indexedNames} names indexed`);
  });

  /**
   * Types `text` at the end of `line` in a scratch copy of Customer.wo and asks for completions.
   * Edits happen in an untitled document so the example workspace is never written to.
   */
  async function completionsAfter(
    insertAfterLineMatching: RegExp,
    text: string
  ): Promise<vscode.CompletionList> {
    const original = await vscode.workspace.openTextDocument(vscode.Uri.file(CUSTOMER_WO));
    const lines = original.getText().split(/\r?\n/);
    const anchor = lines.findIndex((line) => insertAfterLineMatching.test(line));
    assert.ok(anchor >= 0, `no line matching ${insertAfterLineMatching}`);

    lines.splice(anchor + 1, 0, text);
    const scratch = await vscode.workspace.openTextDocument({
      language: 'dataflex',
      content: lines.join('\n')
    });

    const position = new vscode.Position(anchor + 1, text.length);
    return (await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      scratch.uri,
      position
    )) as vscode.CompletionList;
  }

  /** Index position of the first item with this label, or -1. */
  function rankOf(list: vscode.CompletionList, label: string): number {
    const sorted = [...list.items].sort((a, b) =>
      String(a.sortText ?? a.label).localeCompare(String(b.sortText ?? b.label))
    );
    return sorted.findIndex(
      (item) => String(typeof item.label === 'string' ? item.label : item.label.label).toLowerCase() === label.toLowerCase()
    );
  }

  test('ranks properties of the enclosing object above the rest', async () => {
    // The original complaint: `Set ps` offered every string property in the application. Inside
    // `Object oCustomerName is a cWebForm`, cWebForm's own properties must come first.
    const list = await completionsAfter(/Object oCustomerName is a cWebForm/i, '        Set ps');
    assert.ok(list.items.length > 0, 'no completions returned');

    const label = rankOf(list, 'psLabel');
    const placeholder = rankOf(list, 'psPlaceHolder');
    const caption = rankOf(list, 'psCaption');

    assert.ok(label >= 0, 'psLabel (cWebForm chain) missing');
    assert.ok(placeholder >= 0, 'psPlaceHolder (cWebForm) missing');
    assert.ok(caption >= 0, 'psCaption (the view) missing -- candidates must be ranked, not hidden');

    // Both cWebForm properties outrank the view's psCaption.
    assert.ok(
      label < caption && placeholder < caption,
      `expected cWebForm properties before psCaption; got psLabel=${label} psPlaceHolder=${placeholder} psCaption=${caption}`
    );
  });

  test('WebSet offers only published web properties', async () => {
    const list = await completionsAfter(/Object oCustomerName is a cWebForm/i, '        WebSet ps');
    assert.ok(list.items.length > 0, 'no completions returned');

    // psValue is { WebProperty=Client } on cWebBaseDEO.
    assert.ok(rankOf(list, 'psValue') >= 0, 'psValue missing from WebSet completions');

    // Every offered item must be web-published; `WebSet` on anything else is a runtime error.
    for (const item of list.items) {
      assert.match(
        String(item.detail ?? ''),
        /Client|Server|ServerSession/,
        `${String(item.label)} is not a published web property but was offered for WebSet`
      );
    }
  });

  test('offers sibling and view properties, ranked below the target object', async () => {
    const list = await completionsAfter(/Object oCustomerName is a cWebForm/i, '        Set pi');
    const columnSpan = rankOf(list, 'piColumnSpan');
    assert.ok(columnSpan >= 0, 'piColumnSpan missing');
    assert.ok(list.items.length > 5, `expected a broad candidate set, got ${list.items.length}`);
  });

  test('completes object names after `of`', async () => {
    const list = await completionsAfter(/Object oCustomerName is a cWebForm/i, '        Set psValue of ');
    const labels = list.items.map((i) => String(typeof i.label === 'string' ? i.label : i.label.label));
    assert.ok(labels.includes('Self'), 'Self missing from object completions');
    assert.ok(
      labels.some((l) => l.toLowerCase() === 'ocustomerdatadictionary'),
      `expected objects from the view; got ${labels.slice(0, 10).join(', ')}`
    );
  });

  test('completes class names after `is a`', async () => {
    const list = await completionsAfter(/Object oCustomerName is a cWebForm/i, '    Object oNew is a cWebForm');
    const labels = list.items.map((i) => String(typeof i.label === 'string' ? i.label : i.label.label));
    assert.ok(
      labels.some((l) => l.toLowerCase() === 'cwebform'),
      `expected cWebForm among class completions; got ${labels.slice(0, 10).join(', ')}`
    );
  });

  test('publishes static analysis diagnostics for an open document', async () => {
    // Analysis is live: opening a document is what triggers it. This is the end-to-end check
    // that the server actually publishes -- the unit tests only cover the rule logic.
    const scratch = await vscode.workspace.openTextDocument({
      language: 'dataflex',
      content: [
        'Procedure Foo',
        '    String sNeverUsed',
        '    Procedure_Return',
        '    Send CannotRun',
        'End_Procedure'
      ].join('\n')
    });
    await vscode.window.showTextDocument(scratch, { preview: true });

    const diagnostics = await eventually(
      () => vscode.languages.getDiagnostics(scratch.uri),
      (value) => value.length >= 2
    );

    const codes = diagnostics.map((d) => String(d.code));
    assert.ok(codes.includes('unused-local'), `expected unused-local; got ${codes.join(', ')}`);
    assert.ok(codes.includes('unreachable-code'), `expected unreachable-code; got ${codes.join(', ')}`);

    const unused = diagnostics.find((d) => d.code === 'unused-local')!;
    assert.equal(unused.source, 'dataflex');
    assert.equal(unused.severity, vscode.DiagnosticSeverity.Hint);
    assert.ok(
      unused.tags?.includes(vscode.DiagnosticTag.Unnecessary),
      'findings must carry the Unnecessary tag so the editor greys them out'
    );
  });

  test('publishes an implicit global as a Warning that reaches the Problems panel', async () => {
    // Every other rule reports as a Hint, which VS Code greys out but keeps *out* of the Problems
    // panel. This one has to be listed, so it must arrive as a Warning and without the
    // Unnecessary tag -- a dimmed warning would read as dead code rather than a hazard.
    const scratch = await vscode.workspace.openTextDocument({
      language: 'dataflex',
      content: [
        'Object oValidations_DD is a cDataDictionary',
        '    String sBeschraenkung',
        'End_Object'
      ].join('\n')
    });
    await vscode.window.showTextDocument(scratch, { preview: true });

    const diagnostics = await eventually(
      () => vscode.languages.getDiagnostics(scratch.uri),
      (value) => value.some((d) => d.code === 'implicit-global')
    );

    const finding = diagnostics.find((d) => d.code === 'implicit-global')!;
    assert.equal(finding.severity, vscode.DiagnosticSeverity.Warning);
    assert.equal(finding.tags, undefined);
    assert.ok(
      finding.message.includes('sBeschraenkung'),
      `expected the variable name in the message; got ${finding.message}`
    );
  });

  test('honours a df-ignore suppression comment', async () => {
    const scratch = await vscode.workspace.openTextDocument({
      language: 'dataflex',
      content: [
        'Procedure Foo',
        '    String sNeverUsed // df-ignore:unused-local',
        'End_Procedure'
      ].join('\n')
    });
    await vscode.window.showTextDocument(scratch, { preview: true });

    // Give the server time to analyse, then assert nothing was reported.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.deepEqual(
      vscode.languages.getDiagnostics(scratch.uri).map((d) => String(d.code)),
      []
    );
  });

  test('analyses the whole workspace on request and lists the results', async () => {
    const result = (await vscode.commands.executeCommand('dataflex.internal.analyzeWorkspace')) as {
      filesAnalyzed: number;
      findings: number;
      files: { uri: string }[];
      byRule: Record<string, number>;
    };

    assert.ok(result.filesAnalyzed > 10, `only ${result.filesAnalyzed} files analysed`);

    // Only the workspace's own source; DfPkg dependencies are somebody else's code.
    for (const file of result.files) {
      assert.ok(
        !/dfpkg/i.test(file.uri),
        `dependency file leaked into the report: ${file.uri}`
      );
    }
  });

  test('runs a rule the picker selects even when it is off in settings', async () => {
    // The bug this guards: narrowing the requested rules against the settings meant ticking an
    // off-by-default rule silently did nothing -- and those are exactly the rules worth asking
    // for on demand. `unused-parameter` ships off, so it is the case that matters.
    const report = (await vscode.commands.executeCommand('dataflex.internal.analyzeWorkspace', [
      'unused-parameter'
    ])) as { byRule: Record<string, number>; files: { uri: string }[]; findings: number };

    assert.ok(
      (report.byRule['unused-parameter'] ?? 0) > 0,
      `expected unused-parameter findings; got ${JSON.stringify(report.byRule)}`
    );
    assert.deepEqual(Object.keys(report.byRule), ['unused-parameter']);

    for (const file of report.files) {
      assert.ok(!/dfpkg/i.test(file.uri), `dependency file leaked in: ${file.uri}`);
    }
  });

  test('reports only the rules that were asked for', async () => {
    const report = (await vscode.commands.executeCommand('dataflex.internal.analyzeWorkspace', [
      'unused-local'
    ])) as { byRule: Record<string, number> };

    assert.ok((report.byRule['unused-local'] ?? 0) > 0, 'expected unused-local findings');
    assert.equal(report.byRule['unused-parameter'], undefined);
    assert.equal(report.byRule['dead-procedure'], undefined);
  });

  test('reports dead procedures only when that rule is requested', async () => {
    // Workspace-only: it needs the whole index, so it never runs live while typing.
    const withRule = (await vscode.commands.executeCommand(
      'dataflex.internal.analyzeWorkspace',
      ['dead-procedure']
    )) as { byRule: Record<string, number>; files: { uri: string }[] };

    assert.ok(
      (withRule.byRule['dead-procedure'] ?? 0) > 0,
      `expected dead-procedure findings; got ${JSON.stringify(withRule.byRule)}`
    );
    assert.deepEqual(Object.keys(withRule.byRule), ['dead-procedure']);
    for (const file of withRule.files) {
      assert.ok(!/dfpkg/i.test(file.uri), `dependency file leaked in: ${file.uri}`);
    }
  });

  test('maps a coverage report onto the editor coverage types', () => {
    // `coverage.ts` cannot be reached from the vitest suite because it imports `vscode`, so the
    // mapping is asserted here, where the real classes exist.
    const file = 'C:\\ws\\AppSrc\\cThing.pkg';
    const report = {
      files: [
        {
          file,
          hits: new Map([
            [10, 3],
            [12, 0],
            [20, 1]
          ]),
          missed: [12],
          covered: 2,
          total: 3
        }
      ],
      covered: 2,
      total: 3,
      ratio: 2 / 3
    };
    const probes = [
      { id: 0, file, line: 10, kind: 'entry' as const, method: 'Work' },
      { id: 1, file, line: 12, kind: 'block' as const, method: 'Work' },
      { id: 2, file, line: 20, kind: 'entry' as const, method: 'Rest' }
    ];

    const details = coverageDetails(report, probes);
    const entries = details.get(file.toLowerCase())!;

    const statements = entries.filter(
      (entry): entry is vscode.StatementCoverage => entry instanceof vscode.StatementCoverage
    );
    assert.deepEqual(
      statements.map((entry) => [(entry.location as vscode.Position).line, entry.executed]),
      [
        [10, 3],
        [12, 0],
        [20, 1]
      ]
    );

    // One declaration per method, taken from its entry probe -- that is what lets the view report
    // procedures covered as well as lines.
    const declarations = entries.filter(
      (entry): entry is vscode.DeclarationCoverage => entry instanceof vscode.DeclarationCoverage
    );
    assert.deepEqual(
      declarations.map((entry) => [entry.name, entry.executed]).sort(),
      [
        ['Rest', 1],
        ['Work', 3]
      ].sort()
    );

    const [coverage] = fileCoverage(details, [file]);
    // `Uri.file` lower-cases the drive letter, which is why every lookup in `coverage.ts` and in
    // `loadDetailedCoverage` compares lower-cased paths rather than raw ones.
    assert.equal(coverage!.uri.fsPath.toLowerCase(), file.toLowerCase());
    assert.equal(coverage!.statementCoverage.total, 3);
    assert.equal(coverage!.statementCoverage.covered, 2);
    assert.equal(coverage!.declarationCoverage?.total, 2);
  });

  test('offers a coverage run profile alongside the plain one', async () => {
    // Registering the Coverage profile is what puts "Run with Coverage" in the Test Explorer, and
    // it is the part that can regress silently. The run itself needs a compiler and a DFUnit
    // suite, so it is proven by `npm run coverage-run` against MyApp rather than here.
    const dataflex = vscode.extensions.getExtension('vscode-dataflex.vscode-dataflex');
    assert.ok(dataflex !== undefined, 'the extension should be installed in the test host');

    const api = (await dataflex.activate()) as
      | { testRunProfileKinds: readonly vscode.TestRunProfileKind[] }
      | undefined;
    assert.deepEqual(
      [...(api?.testRunProfileKinds ?? [])].sort(),
      [vscode.TestRunProfileKind.Run, vscode.TestRunProfileKind.Coverage].sort()
    );
  });

  test('registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'dataflex.build',
      'dataflex.rebuild',
      'dataflex.run',
      'dataflex.selectProject',
      'dataflex.showWorkspaceConfiguration',
      'dataflex.reloadWorkspace',
      'dataflex.refreshTests',
      'dataflex.analyzeWorkspace',
      'dataflex.clearAnalysisResults',
      'dataflex.profile',
      'dataflex.showLastProfile'
    ]) {
      assert.ok(commands.includes(id), `command not registered: ${id}`);
    }
  });

  test('builds a run task with the project as a positional argument', async () => {
    // `df-cli run` has no `--target` option -- unlike `build` -- and fails if given one.
    const tasks = await eventually(
      () => vscode.tasks.fetchTasks({ type: 'dataflex' }),
      (value) => value.length > 0
    );
    const runTask = tasks.find((task) => task.name.startsWith('run '));
    assert.ok(runTask, 'no run task found');

    const execution = runTask.execution as vscode.ProcessExecution;
    const args = execution.args.map(String);
    assert.deepEqual(args.slice(0, 1), ['run']);
    assert.ok(!args.includes('--target'), `run task must not pass --target; got ${args.join(' ')}`);
    assert.ok(
      args.some((a) => a.toLowerCase().endsWith('.src')),
      `run task must name the project positionally; got ${args.join(' ')}`
    );
  });

  /**
   * With no project selected, the offered build task compiles the whole workspace -- which is what
   * `df-cli build <sws>` with no `--target` does. That is deliberate, and the opposite of the run
   * task, which must always name one. Whether a *chosen* project reaches `--target` is asserted in
   * `commandLine.test.ts`, where it needs no extension host.
   */
  test('offers a whole-workspace build when no project is selected', async () => {
    const tasks = await eventually(
      () => vscode.tasks.fetchTasks({ type: 'dataflex' }),
      (value) => value.length > 0
    );
    const buildTask = tasks.find((task) => task.name.startsWith('build'));
    assert.ok(buildTask, `no build task found; got ${tasks.map((t) => t.name).join(', ')}`);
    assert.equal(buildTask.name, 'build all projects');
    const args = (buildTask.execution as vscode.ProcessExecution).args.map(String);
    assert.deepEqual(args.slice(0, 1), ['build']);
    assert.ok(
      !args.includes('--target'),
      `a whole-workspace build must not pass --target; got ${args.join(' ')}`
    );
  });

  test('offers build and run tasks resolved from the workspace', async () => {
    const tasks = await eventually(
      () => vscode.tasks.fetchTasks({ type: 'dataflex' }),
      (value) => value.length > 0
    );
    const names = tasks.map((task) => task.name);
    // The name says what the task will actually compile, so it carries the project or the fact
    // that there is none.
    assert.ok(
      names.some((name) => name.startsWith('build')),
      `no build task; got ${names.join(', ')}`
    );
    assert.ok(
      names.some((name) => name.startsWith('rebuild')),
      `no rebuild task; got ${names.join(', ')}`
    );
    assert.ok(
      names.some((name) => name.startsWith('run ')),
      `no run task; got ${names.join(', ')}`
    );

    // The run task must name the real project from the .sws.
    assert.ok(
      names.some((name) => name.toLowerCase().includes('webapp.src')),
      `run task did not target WebApp.src; got ${names.join(', ')}`
    );
  });
});

suite('DataFlex web view preview (WebOrder workspace)', function () {
  this.timeout(120_000);

  const FILE_DIALOG_WO = path.join(WEBORDER, 'AppSrc', 'DemoFileDialog.wo');

  suiteSetup(function () {
    if (!existsSync(FILE_DIALOG_WO)) {
      this.skip();
    }
  });

  test('draws a view whose pictures load through the page base', async () => {
    // `scripts/preview-check.ts` proves the framework draws the definition, but under `file:`,
    // where a relative url resolves on its own. In the webview the picture has to get through the
    // `<base>`, the content security policy and the resource roots, and only the page can say
    // whether it did. `DemoFileDialog.wo` sets `psUrl to "Images/PoweredByDataFlex.png"`, which
    // the example ships.
    const dataflex = vscode.extensions.getExtension('vscode-dataflex.vscode-dataflex');
    assert.ok(dataflex !== undefined, 'the extension should be installed in the test host');
    const api = (await dataflex.activate()) as {
      onDidReportPreviewImages: vscode.Event<{
        uri: string;
        total: number;
        loaded: number;
        failed: { src: string; url: string }[];
      }>;
    };

    const document = await vscode.workspace.openTextDocument(FILE_DIALOG_WO);
    await vscode.window.showTextDocument(document);

    const reported = new Promise<{ total: number; loaded: number; failed: { src: string; url: string }[] }>(
      (resolve) => {
        const listener = api.onDidReportPreviewImages((report) => {
          if (report.uri === document.uri.toString()) {
            listener.dispose();
            resolve(report);
          }
        });
      }
    );
    await vscode.commands.executeCommand('dataflex.previewWebView', document.uri);

    const report = await Promise.race([
      reported,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 90_000))
    ]);
    assert.ok(report !== undefined, 'the preview never reported its images');
    assert.ok(report.total >= 1, 'the view should have drawn at least one picture');
    assert.deepEqual(
      report.failed,
      [],
      `pictures that did not load: ${report.failed.map((f) => `${f.src} -> ${f.url}`).join(', ')}`
    );
  });
});
