import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { type DfNode, nodeChainAt, parseSource } from '@vscode-dataflex/parser';
import { type LocalFacts, localsInScope } from '@vscode-dataflex/langserver';

/**
 * What the debugger knows about a stack frame that the engine cannot tell it.
 *
 * The engine reports a frame as a file and a line and nothing else: there is no API for a frame's
 * name and none for its variables -- the Studio's locals window is an ActiveX grid whose whole
 * interface is column widths. So the name and the variable list come from parsing the source, which
 * this repository can already do. That is the one place where having written a parser pays for a
 * debugger feature outright.
 */
export interface FrameContext {
  /** Procedure, function or object at that line; the file name when it is none of those. */
  name: string;
  /** Parameters and locals visible there, innermost scope first. */
  locals: LocalFacts[];
}

interface CachedUnit {
  mtimeMs: number;
  root: DfNode;
  lines: string[];
}

/**
 * Parsed sources, keyed by path.
 *
 * A stack walk asks about every frame, and a stepping session asks again on every stop, so the
 * runtime library files in the middle of a stack would otherwise be reparsed continuously. Keyed on
 * mtime so editing a file during a session is picked up.
 */
const cache = new Map<string, CachedUnit>();

function unitFor(file: string): CachedUnit | undefined {
  try {
    const mtimeMs = statSync(file).mtimeMs;
    const cached = cache.get(file);
    if (cached !== undefined && cached.mtimeMs === mtimeMs) {
      return cached;
    }

    const text = readFileSync(file, 'utf8');
    const { root } = parseSource(text, { uri: file });
    // Split on the newline alone: only the leading whitespace of a line is read, so a trailing
    // carriage return on a CRLF file makes no difference to it.
    const entry = { mtimeMs, root, lines: text.split('\n') };
    cache.set(file, entry);
    return entry;
  } catch {
    // A frame in a file this machine cannot read is still a frame; it just has no name.
    return undefined;
  }
}

/** Clears the parse cache. Only the tests need this. */
export function clearScopeCache(): void {
  cache.clear();
}

/**
 * Describes the frame at a source position.
 *
 * @param line one-based, as both the debugger engine and the Debug Adapter Protocol count.
 */
export function frameContext(file: string, line: number): FrameContext {
  const unit = unitFor(file);
  if (unit === undefined) {
    return { name: basename(file), locals: [] };
  }

  const zeroBased = Math.max(0, line - 1);
  // Column 0 sits in the indent, which is outside the range of the thing declared on that line, so
  // resolving there answers with the enclosing block instead of the one the frame is actually in.
  const text = unit.lines[zeroBased] ?? '';
  const column = Math.max(0, text.length - text.trimStart().length);

  const chain = nodeChainAt(unit.root, zeroBased, column);
  return { name: frameName(chain, file), locals: localsInScope(chain) };
}

/**
 * The most specific thing that contains the line.
 *
 * A procedure or function if there is one, because that is what a call stack entry means everywhere
 * else. Failing that the object, which is the useful answer for the object-construction frames that
 * make up most of a DataFlex startup stack, and where a great deal of DataFlex code actually lives.
 */
function frameName(chain: readonly DfNode[], file: string): string {
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i]!;
    if ((node.kind === 'procedure' || node.kind === 'function') && node.name !== undefined) {
      return node.name;
    }
  }

  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i]!;
    if ((node.kind === 'object' || node.kind === 'class') && node.name !== undefined) {
      return node.name;
    }
  }

  return basename(file);
}
