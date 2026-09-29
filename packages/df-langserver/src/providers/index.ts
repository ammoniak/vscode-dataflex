/**
 * The provider surface, for hosts that are not a language server.
 *
 * A subpath export rather than an addition to the root barrel: the extension is bundled from
 * `@vscode-dataflex/langserver`, and esbuild tree-shakes CommonJS re-export barrels poorly, so
 * widening the root one would grow `out/extension.js` for code the extension never calls.
 */
export { wordAt, definition, hover, factsFor, findLocal, localsInScope, workspaceSymbols } from './navigation';
export type { HoverOptions } from './navigation';
export { references, occurrencesIn, documentHighlights } from './references';
export type { ReferenceOptions } from './references';
export { declarationHover, localHover, tableHover, commandHover, callSyntax } from './hoverContent';
export type { DeclarationFacts, LocalFacts, TableFacts, CommandFacts } from './hoverContent';
export { documentSymbols, foldingRanges, describe } from './documentSymbols';
