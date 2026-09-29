/**
 * Constants esbuild folds into a literal at build time.
 *
 * `INCLUDE_DEBUGGER` is the one build-time switch this extension has. It is `true` for
 * `npm run build` -- so the F5 development host has the debugger, which is the only way to work on
 * it -- and `false` for `npm run build:release`, which is what `npm run package` ships. Because
 * esbuild substitutes the literal before tree shaking, a `false` build drops `src/debug.ts`,
 * `@vscode-dataflex/debug` and the parser copy it pulls in, rather than bundling code that can
 * never run.
 *
 * `tsc` only ever sees the declaration, so both branches are type checked.
 */
declare const INCLUDE_DEBUGGER: boolean;
