import { DocumentSymbol, FoldingRange, FoldingRangeKind, SymbolKind } from 'vscode-languageserver';
import { DfNode, SourceUnit } from '@vscode-dataflex/parser';

/** Node kinds that earn a place in the outline. Statements and blocks would only add noise. */
export const SYMBOL_KINDS: ReadonlyMap<DfNode['kind'], SymbolKind> = new Map([
  ['object', SymbolKind.Object],
  ['class', SymbolKind.Class],
  ['procedure', SymbolKind.Method],
  ['function', SymbolKind.Function],
  ['struct', SymbolKind.Struct],
  ['enumList', SymbolKind.Enum],
  ['enumValue', SymbolKind.EnumMember],
  ['property', SymbolKind.Property],
  ['field', SymbolKind.Field],
  ['variable', SymbolKind.Variable],
  ['command', SymbolKind.Function],
  ['define', SymbolKind.Constant]
]);

/** Kinds that are structural containers and therefore worth folding. */
const FOLDABLE_KINDS: ReadonlySet<DfNode['kind']> = new Set([
  'object',
  'class',
  'procedure',
  'function',
  'struct',
  'enumList',
  'command',
  'block'
]);

export function describe(node: DfNode): string {
  switch (node.kind) {
    case 'object':
    case 'class':
      return node.superClass === undefined ? '' : `is a ${node.superClass}`;
    case 'procedure':
    case 'function': {
      const params = (node.params ?? [])
        .map((p) => `${p.byRef ? 'ByRef ' : ''}${p.type ?? ''} ${p.name}`.trim())
        .join(', ');
      const returns = node.type === undefined ? '' : ` -> ${node.type}`;
      const setter = node.isSetter === true ? 'set ' : '';
      return `${setter}(${params})${returns}`;
    }
    case 'property': {
      const web = node.metadata?.find((m) => m.name.toLowerCase() === 'webproperty');
      const suffix = web === undefined ? '' : ` - WebProperty=${web.value ?? 'Client'}`;
      return `${node.type ?? ''}${suffix}`;
    }
    case 'variable':
    case 'field':
      return node.type ?? '';
    default:
      return '';
  }
}

export function documentSymbols(unit: SourceUnit): DocumentSymbol[] {
  const convert = (node: DfNode): DocumentSymbol | undefined => {
    const kind = SYMBOL_KINDS.get(node.kind);
    if (kind === undefined || node.name === undefined) {
      return undefined;
    }
    return {
      name: node.name,
      detail: describe(node),
      kind,
      range: node.range,
      selectionRange: node.nameRange ?? node.headerRange,
      children: collect(node.children ?? [])
    };
  };

  const collect = (nodes: DfNode[]): DocumentSymbol[] => {
    const result: DocumentSymbol[] = [];
    for (const node of nodes) {
      const symbol = convert(node);
      if (symbol !== undefined) {
        result.push(symbol);
      } else if (node.children !== undefined) {
        // Flatten through non-symbol containers so a method nested inside a block is still
        // reachable from the outline.
        result.push(...collect(node.children));
      }
    }
    return result;
  };

  return collect(unit.root.children ?? []);
}

/**
 * Folding ranges for structural blocks, plus `#IFDEF` regions.
 *
 * The parser deliberately keeps conditional directives flat -- in real DataFlex they straddle
 * other constructs, so nesting them would corrupt the tree -- which means folding pairs them up
 * separately, here, where getting it wrong costs nothing.
 */
export function foldingRanges(unit: SourceUnit): FoldingRange[] {
  const ranges: FoldingRange[] = [];
  const directives: DfNode[] = [];

  const visit = (node: DfNode): void => {
    if (FOLDABLE_KINDS.has(node.kind) && node.range.end.line > node.range.start.line) {
      ranges.push({ startLine: node.range.start.line, endLine: node.range.end.line });
    }
    if (node.kind === 'directive') {
      directives.push(node);
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(unit.root);

  directives.sort((a, b) => a.range.start.line - b.range.start.line);
  const open: number[] = [];
  for (const directive of directives) {
    const name = (directive.name ?? '').toLowerCase();
    if (['#ifdef', '#ifndef', '#if', '#ifsame', '#ifnsame'].includes(name)) {
      open.push(directive.range.start.line);
    } else if (name === '#endif') {
      const start = open.pop();
      if (start !== undefined && directive.range.start.line > start) {
        ranges.push({
          startLine: start,
          endLine: directive.range.start.line,
          kind: FoldingRangeKind.Region
        });
      }
    }
  }

  return ranges;
}
