/**
 * The preview model, for hosts that are not a language server.
 *
 * A subpath export rather than an addition to the root barrel, for the reason given in
 * `providers/index.ts`. The model itself is pure and JSON-serializable: no webview, no browser
 * and no DataFlex process is involved in producing it.
 */
export { buildPreviewModel } from './model';
export type {
  PreviewClass,
  PreviewDefinition,
  PreviewModel,
  PreviewObject,
  PreviewOptions,
  PreviewProblem,
  PreviewRange
} from './model';
export {
  MODES,
  MODE_CHOICES,
  MODE_DESCRIPTION,
  MODE_NAMES,
  isModeName,
  modeValue,
  viewportFor
} from './modes';
export type { ModeName } from './modes';
export { coerce, ValueResolver } from './values';
export type { PreviewValue } from './values';
export {
  BROWSERS,
  DEFAULT_THEME,
  between,
  countObjects,
  failures,
  findBrowser,
  renderOnce,
  renderPage
} from './headless';
export type { RenderOptions, RenderResult } from './headless';
