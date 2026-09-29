import { DfNode, SourceUnit, buildCfg, reachableBlocks, walk } from '@vscode-dataflex/parser';

/** What a probe marks. */
export type ProbeKind = 'entry' | 'block';

export interface Probe {
  /** Stable within one instrumentation run; the runtime reports hits by this id. */
  id: number;
  /** Absolute path of the *original* file. */
  file: string;
  /** Zero-based line in the **original** source, so no remapping is needed afterwards. */
  line: number;
  kind: ProbeKind;
  /** Enclosing procedure or function, for reporting. */
  method?: string;
}

/** A line of source to splice in alongside the probes. */
export interface Injection {
  /** Zero-based line in the **original** source; the text goes immediately before it. */
  line: number;
  /** May span several lines. */
  text: string;
}

export interface InstrumentOptions {
  /** Absolute path of the file being instrumented, recorded on every probe. */
  file: string;
  /** Probe ids start here, so ids stay unique across a whole workspace. */
  firstId?: number;
  /**
   * Extra source to splice in, addressed by **original** line number.
   *
   * Coverage planning needs two such edits in a test program -- `Use DfCoverage.pkg` at the top
   * and the override that flushes the counters before DFUnit exits. Routing them through the
   * same bottom-up splice as the probes keeps one place responsible for line arithmetic; doing
   * it in a second pass would mean re-deriving where every probe had already moved things.
   */
  inject?: readonly Injection[];
  /**
   * How a probe is written. Receives the probe id.
   *
   * Defaults to a call to the global procedure the runtime declares: `Send DfCovHit <id>`.
   *
   * A *global* procedure rather than a method on an object: it needs no handle in scope, and the
   * runtime can then keep its counters in a `Global_Variable Integer[]`. An array **property**
   * would be far worse here -- DataFlex only gets and sets those whole, with copy-on-write, so
   * every single hit would copy the entire counter array.
   */
  emit?: (id: number) => string;
  /**
   * Probe whole methods instead of basic blocks, for profiling.
   *
   * One probe per procedure or function, entered once and left once, rather than one per block.
   * Timing every block is not an option: DataFlex's clock is millisecond-resolution
   * (`CurrentDateTime`), so a block that runs in microseconds would measure zero, and asking the
   * clock on every block would cost more than the code being measured.
   *
   * `exit` is spliced before `End_Procedure` **and** before every `Procedure_Return` /
   * `Function_Return`, because a method may leave from several places and an unmatched enter
   * would attribute the rest of the program to it.
   */
  method?: {
    enter: (id: number) => string;
    exit: (id: number) => string;
  };
}

export interface InstrumentResult {
  /** The instrumented source. */
  code: string;
  probes: Probe[];
  /**
   * Statements that could not be probed, with the reason.
   *
   * Reported rather than silently dropped: a coverage figure that quietly omits code is worse
   * than one that says what it could not measure.
   */
  skipped: { line: number; reason: string }[];
}

const DEFAULT_EMIT = (id: number): string => `Send DfCovHit ${id}`;

/** Node kinds that represent runnable code a probe can precede. */
function isExecutable(node: DfNode): boolean {
  return node.kind === 'statement' || node.kind === 'unknown';
}

/** Leading whitespace of a line, so an inserted probe matches the surrounding indentation. */
function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

/**
 * Inserts coverage probes into DataFlex source.
 *
 * Probes go at the entry of every reachable basic block, which the control-flow graph already
 * identifies -- so a branch that never runs is distinguishable from one that does, rather than
 * the whole procedure being counted as covered because its first line executed.
 *
 * Three DataFlex-specific constraints shape where a probe may go:
 *
 *  - **Local declarations must come first.** A procedure's entry probe goes after the last
 *    leading declaration, not at the top of the body.
 *  - **A single-line conditional cannot take one.** `If (x) Send Foo` puts the guarded statement
 *    on the same line, so a probe inserted before it would run unconditionally and report the
 *    branch as covered when it was not. Those are skipped and listed in `skipped`.
 *  - **Macro bodies are not code.** A `#COMMAND` body is template text; instrumenting it would
 *    corrupt every expansion.
 *
 * Probe line numbers refer to the **original** source, so a report needs no remapping even though
 * the instrumented copy has shifted lines.
 */
export function instrument(
  text: string,
  unit: SourceUnit,
  options: InstrumentOptions
): InstrumentResult {
  const emit = options.emit ?? DEFAULT_EMIT;
  const lines = text.split(/\r?\n/);
  const probes: Probe[] = [];
  const skipped: { line: number; reason: string }[] = [];
  let nextId = options.firstId ?? 0;

  // Statements written on the same line as the conditional guarding them, and anything inside a
  // macro body: neither can host a probe line of its own.
  const unprobeable = new Map<DfNode, string>();
  walk(unit.root, (node, parents) => {
    const inInline = parents.some(
      (parent) => parent.kind === 'block' && parent.inline === true
    );
    const inMacro = parents.some((parent) => parent.kind === 'command');
    if (isExecutable(node) && (inInline || inMacro)) {
      unprobeable.set(node, inInline ? 'inside a single-line conditional' : 'inside a macro body');
    }
  });

  /** Probe and injected insertions, collected before being applied bottom-up. */
  const insertions: { line: number; text: string; probe: boolean }[] = [];

  /**
   * One enter/exit pair for a whole method.
   *
   * A method whose exit cannot be probed is skipped entirely rather than probed half-way. An
   * inline `If (bDone) Procedure_Return` has nowhere to put an exit line -- the probe would sit
   * before the `If` and fire whether or not the return is taken -- and an enter without a matching
   * exit does not merely lose that method, it charges everything the caller does afterwards to it.
   * A method missing from the profile is obvious; a method with a plausible wrong number is not.
   */
  const probeMethod = (node: DfNode, emitters: NonNullable<InstrumentOptions['method']>): void => {
    const body = node.children ?? [];
    const anchor = body.find(isExecutable);
    if (anchor === undefined) {
      return;
    }

    const returns: DfNode[] = [];
    let blocked: string | undefined;
    walk(node, (inner) => {
      if (
        inner.kind === 'statement' &&
        (inner.verb === 'procedure_return' || inner.verb === 'function_return')
      ) {
        const reason = unprobeable.get(inner);
        if (reason !== undefined) {
          blocked ??= reason;
        }
        returns.push(inner);
      }
      return undefined;
    });

    if (unprobeable.get(anchor) !== undefined) {
      blocked ??= unprobeable.get(anchor);
    }
    if (blocked !== undefined) {
      skipped.push({ line: node.range.start.line, reason: `method not profiled: ${blocked}` });
      return;
    }

    const id = nextId++;
    probes.push({
      id,
      file: options.file,
      line: node.range.start.line,
      kind: 'entry',
      method: node.name
    });

    insertions.push({
      line: anchor.range.start.line,
      text: `${indentOf(lines[anchor.range.start.line] ?? '')}${emitters.enter(id)}`,
      probe: true
    });

    // Before every return, and before the closing keyword.
    for (const statement of returns) {
      const line = statement.range.start.line;
      insertions.push({
        line,
        text: `${indentOf(lines[line] ?? '')}${emitters.exit(id)}`,
        probe: true
      });
    }
    const closing = node.range.end.line;
    insertions.push({
      line: closing,
      text: `${indentOf(lines[closing] ?? '')}    ${emitters.exit(id)}`,
      probe: true
    });
  };

  walk(unit.root, (node) => {
    if (node.kind !== 'procedure' && node.kind !== 'function') {
      return;
    }

    if (options.method !== undefined) {
      probeMethod(node, options.method);
      return;
    }

    const cfg = buildCfg(node);
    const reachable = reachableBlocks(cfg);

    for (const block of cfg.blocks) {
      if (!reachable.has(block.id)) {
        continue;
      }

      // Skip the declarations a block may begin with: DataFlex requires them before any
      // executable statement, so a probe has to go after them.
      const anchor = block.statements.find(isExecutable);
      if (anchor === undefined) {
        continue;
      }

      const reason = unprobeable.get(anchor);
      if (reason !== undefined) {
        skipped.push({ line: anchor.range.start.line, reason });
        continue;
      }

      const line = anchor.range.start.line;
      const id = nextId++;
      probes.push({
        id,
        file: options.file,
        line,
        kind: block.id === cfg.entry || block.predecessors.includes(cfg.entry) ? 'entry' : 'block',
        method: node.name
      });
      insertions.push({ line, text: `${indentOf(lines[line] ?? '')}${emit(id)}`, probe: true });
    }
  });

  for (const injection of options.inject ?? []) {
    insertions.push({ line: injection.line, text: injection.text, probe: false });
  }

  // Apply bottom-up so earlier line numbers stay valid as lines are added. Where a probe and an
  // injection land on the same line the injection goes above: a probe belongs to the statement it
  // precedes, while an injection belongs before the whole construct on that line.
  insertions.sort((a, b) => b.line - a.line || Number(b.probe) - Number(a.probe));
  for (const insertion of insertions) {
    lines.splice(insertion.line, 0, ...insertion.text.split('\n'));
  }

  return { code: lines.join('\n'), probes, skipped };
}
