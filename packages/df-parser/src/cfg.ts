import { DfNode } from './ast';

/**
 * A control-flow graph over one procedure or function.
 *
 * Built from the statement tree rather than from text, which is only possible because the parser
 * normalises the awkward DataFlex shapes first: a single-line `If (x) Send Foo` has the same
 * block structure as the `Begin`/`End` form, and `Case` arms written without `Begin` are grouped
 * into `caseArm` nodes instead of being flat siblings.
 */

export type CfgBlockKind = 'entry' | 'exit' | 'basic';

export interface CfgBlock {
  id: number;
  kind: CfgBlockKind;
  /** Statements executed in this block, in order. Empty for entry, exit and join blocks. */
  statements: DfNode[];
  successors: number[];
  predecessors: number[];
}

export interface Cfg {
  /** The procedure or function this graph describes. */
  scope: DfNode;
  blocks: CfgBlock[];
  entry: number;
  exit: number;
  /**
   * True when something unmodellable was found -- an unstructured jump.
   *
   * Consumers must degrade rather than report confidently: an imprecise graph can claim code is
   * unreachable when a jump reaches it. DataFlex application code does not use `Goto`/`Gosub`
   * (zero occurrences across the corpora checked), but generated and legacy code might.
   */
  imprecise: boolean;
}

/** Statements that leave the procedure entirely. */
const EXITS_SCOPE = new Set(['return', 'abort']);

/** Verbs that transfer control in ways this graph does not model. */
const UNSTRUCTURED = new Set(['goto', 'gosub']);

interface LoopContext {
  /** Where `Break` goes. */
  breakTo?: number;
  /** Where a loop's back edge goes. */
  continueTo?: number;
}

/**
 * Builds a control-flow graph for a procedure or function body.
 *
 * Never throws: an unterminated or malformed body yields whatever graph could be derived, because
 * this runs against code that is mid-edit.
 */
export function buildCfg(scope: DfNode): Cfg {
  const blocks: CfgBlock[] = [];
  let imprecise = false;

  const create = (kind: CfgBlockKind = 'basic'): number => {
    blocks.push({ id: blocks.length, kind, statements: [], successors: [], predecessors: [] });
    return blocks.length - 1;
  };

  const link = (from: number, to: number): void => {
    const source = blocks[from]!;
    if (!source.successors.includes(to)) {
      source.successors.push(to);
      blocks[to]!.predecessors.push(from);
    }
  };

  const entry = create('entry');
  const exit = create('exit');

  /**
   * Emits `list` starting in `current`.
   *
   * Returns the block control reaches afterwards, or `undefined` when the list always leaves --
   * every path returned, broke or aborted -- which is what makes anything following it dead.
   */
  const emit = (list: DfNode[], current: number, loop: LoopContext): number | undefined => {
    let here: number | undefined = current;

    for (let i = 0; i < list.length; i++) {
      const node = list[i]!;

      if (here === undefined) {
        // Unreachable from here on; keep walking so nested scopes still get blocks, but attach
        // them to a fresh block with no predecessors.
        here = create();
      }

      // --- conditionals ---------------------------------------------------
      if (node.kind === 'block' && node.blockKind === 'if') {
        // `Else` is a *sibling* in DataFlex, not a child of the `If`, so pair them here.
        // A chain runs `If` / `Else If` / ... / `Else`, and only an *unconditional* `Else`
        // ends it -- with none, control can fall past the whole chain untouched.
        const alternatives: DfNode[] = [];
        let hasUnconditionalElse = false;
        let j = i + 1;
        while (j < list.length) {
          const next = list[j]!;
          if (next.kind !== 'block' || next.blockKind !== 'else') {
            break;
          }
          alternatives.push(next);
          j++;
          if (!isConditionalElse(next)) {
            hasUnconditionalElse = true;
            break;
          }
        }
        i = j - 1;

        const join = create();
        const thenEntry = create();
        link(here, thenEntry);
        const thenExit = emit(node.children ?? [], thenEntry, loop);
        if (thenExit !== undefined) {
          link(thenExit, join);
        }

        for (const alternative of alternatives) {
          const elseEntry = create();
          link(here, elseEntry);
          const elseExit = emit(alternative.children ?? [], elseEntry, loop);
          if (elseExit !== undefined) {
            link(elseExit, join);
          }
        }

        // Without an unconditional `Else`, every condition can be false and control falls
        // straight through to the join.
        if (!hasUnconditionalElse) {
          link(here, join);
        }

        here = blocks[join]!.predecessors.length > 0 ? join : undefined;
        continue;
      }

      // A standalone `Else` (its `If` already consumed, or malformed source).
      if (node.kind === 'block' && node.blockKind === 'else') {
        const body = create();
        link(here, body);
        here = emit(node.children ?? [], body, loop);
        continue;
      }

      // --- loops ------------------------------------------------------------
      if (
        node.kind === 'block' &&
        (node.blockKind === 'for' || node.blockKind === 'while' || node.blockKind === 'repeat')
      ) {
        const header = create();
        const body = create();
        const after = create();
        link(here, header);

        if (node.blockKind === 'repeat') {
          // `Repeat ... Until (c)` always runs the body once; the test is at the bottom.
          link(header, body);
          const bodyExit = emit(node.children ?? [], body, { breakTo: after, continueTo: header });
          if (bodyExit !== undefined) {
            link(bodyExit, header);
            link(bodyExit, after);
          }
        } else {
          // `For` / `While` test first, so the body may run zero times.
          link(header, body);
          link(header, after);
          const bodyExit = emit(node.children ?? [], body, { breakTo: after, continueTo: header });
          if (bodyExit !== undefined) {
            link(bodyExit, header);
          }
        }

        here = after;
        continue;
      }

      // --- case -------------------------------------------------------------
      if (node.kind === 'block' && node.blockKind === 'case') {
        const after = create();
        const arms = (node.children ?? []).filter((child) => child.kind === 'caseArm');
        let hasDefault = false;

        for (const arm of arms) {
          if (arm.condition === undefined) {
            hasDefault = true;
          }
          const armEntry = create();
          link(here, armEntry);
          const armExit = emit(arm.children ?? [], armEntry, { ...loop, breakTo: after });
          if (armExit !== undefined) {
            link(armExit, after);
          }
        }

        // Statements sitting directly in the case block rather than in an arm.
        for (const child of node.children ?? []) {
          if (child.kind !== 'caseArm') {
            blocks[here]!.statements.push(child);
          }
        }

        // With no `Case Else`, no arm may match.
        if (!hasDefault || arms.length === 0) {
          link(here, after);
        }

        here = blocks[after]!.predecessors.length > 0 ? after : undefined;
        continue;
      }

      // --- plain grouping block ---------------------------------------------
      if (node.kind === 'block' || node.kind === 'caseArm') {
        here = emit(node.children ?? [], here, loop);
        continue;
      }

      // --- statements --------------------------------------------------------
      blocks[here]!.statements.push(node);

      if (node.verb !== undefined && UNSTRUCTURED.has(node.verb)) {
        // Cannot model where this goes; say so rather than pretend the rest is unreachable.
        imprecise = true;
        link(here, exit);
        here = create();
        continue;
      }

      if (node.transfer !== undefined) {
        if (EXITS_SCOPE.has(node.transfer)) {
          link(here, exit);
          here = undefined;
        } else if (node.transfer === 'break') {
          link(here, loop.breakTo ?? exit);
          here = undefined;
        } else if (node.transfer === 'error') {
          // `Error` reports and continues; it is not a transfer out of the procedure.
          continue;
        }
      }
    }

    return here;
  };

  const tail = emit(scope.children ?? [], entry, {});
  if (tail !== undefined) {
    link(tail, exit);
  }

  return { scope, blocks, entry, exit, imprecise };
}

/**
 * True when an `else` arm carries its own condition (`Else If (x) …`).
 *
 * Written with `Begin` the parser records the condition on the `else` block itself; written
 * inline it nests an `if` block inside. Either way the arm can decline to run, so the chain does
 * not necessarily cover every case.
 */
function isConditionalElse(node: DfNode): boolean {
  if (node.condition !== undefined) {
    return true;
  }
  return (node.children ?? []).some((child) => child.kind === 'block' && child.blockKind === 'if');
}

/** Block ids reachable from the entry. */
export function reachableBlocks(cfg: Cfg): Set<number> {
  const seen = new Set<number>([cfg.entry]);
  const queue = [cfg.entry];

  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const next of cfg.blocks[id]!.successors) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }

  return seen;
}

/**
 * Statements that cannot execute.
 *
 * Empty when the graph is imprecise: an unmodelled jump could reach anything, and a wrong
 * "this is dead" is far more damaging than a missed one.
 */
export function unreachableStatements(cfg: Cfg): DfNode[] {
  if (cfg.imprecise) {
    return [];
  }

  const reachable = reachableBlocks(cfg);
  const dead: DfNode[] = [];
  for (const block of cfg.blocks) {
    if (!reachable.has(block.id)) {
      dead.push(...block.statements);
    }
  }
  return dead.sort((a, b) =>
    a.range.start.line === b.range.start.line
      ? a.range.start.character - b.range.start.character
      : a.range.start.line - b.range.start.line
  );
}
