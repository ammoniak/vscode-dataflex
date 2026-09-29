/**
 * Responsive modes, by name.
 *
 * Shared rather than owned by whichever host asked first: the MCP tools take a mode by name, the
 * extension's preview offers the same list in a picker, and a second table would eventually
 * disagree with this one about what `tablet` means.
 *
 * The numbers are the framework's own `rm*` constants from `WebUIConstants.pkg`. They matter
 * beyond identity, because `df.WebObject#enforceRule` selects on `<=`: a rule written for
 * `rmTablet` (20) is still in force at `rmTabletPortrait` (22).
 *
 * Only the portrait and landscape variants are ever *detected* by a running client -- `detectMode`
 * reports 21/22 and 31/32 and never bare 20 or 30 -- so `tablet` and `mobile` map to the portrait
 * value rather than the bare one. Asking for bare `rmTablet` would apply the tablet rules while
 * ignoring every portrait-specific one, which is a layout no real device ever shows.
 */
export const MODES = {
  desktop: 10,
  tablet: 22,
  'tablet-portrait': 22,
  'tablet-landscape': 21,
  mobile: 32,
  'mobile-portrait': 32,
  'mobile-landscape': 31
} as const;

export type ModeName = keyof typeof MODES;

export const MODE_NAMES = Object.keys(MODES) as [ModeName, ...ModeName[]];

export const MODE_DESCRIPTION =
  'Responsive mode to lay out for. Applies the WebSetResponsive rules that mode would activate, ' +
  'the way the framework does -- the closest rule at or below the mode wins, so an rmTablet rule ' +
  'still applies on a tablet in portrait. Omit for the desktop base layout with no rules applied.';

export function modeValue(name: ModeName | undefined): number | undefined {
  return name === undefined ? undefined : MODES[name];
}

/** True for a string that names a mode, so an untrusted one can be taken as a `ModeName`. */
export function isModeName(value: unknown): value is ModeName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MODES, value);
}

/**
 * The modes worth putting in a picker, and what to call them.
 *
 * `tablet` and `mobile` are left out: they resolve to the same values as their portrait variants,
 * so offering both would be two names for one layout with nothing to choose between them.
 */
export const MODE_CHOICES: { readonly name: ModeName; readonly label: string }[] = [
  { name: 'desktop', label: 'Desktop' },
  { name: 'tablet-portrait', label: 'Tablet portrait' },
  { name: 'tablet-landscape', label: 'Tablet landscape' },
  { name: 'mobile-portrait', label: 'Mobile portrait' },
  { name: 'mobile-landscape', label: 'Mobile landscape' }
];

/**
 * A viewport that matches the mode, for the screenshot.
 *
 * The layout itself comes from the rules that were applied, not from the window -- the definition
 * already carries the tablet column spans by the time the page loads. But rendering a phone layout
 * into a 1280-wide window would still misrepresent it, so the window follows the mode unless the
 * caller pins one.
 */
export function viewportFor(name: ModeName | undefined): { width: number; height: number } {
  switch (name) {
    case 'mobile':
    case 'mobile-portrait':
      return { width: 390, height: 844 };
    case 'mobile-landscape':
      return { width: 844, height: 390 };
    case 'tablet':
    case 'tablet-portrait':
      return { width: 834, height: 1112 };
    case 'tablet-landscape':
      return { width: 1112, height: 834 };
    default:
      return { width: 1280, height: 900 };
  }
}
