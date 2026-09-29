import { describe, expect, it } from 'vitest';
import {
  MODES,
  MODE_CHOICES,
  MODE_NAMES,
  isModeName,
  modeValue,
  viewportFor
} from '../src/preview/modes';

describe('responsive modes', () => {
  it('uses the framework\'s own rm* constant values', () => {
    // From WebUIConstants.pkg. The numbers carry meaning: selection is `<=`, so the ordering
    // between them is what makes a tablet rule apply on a phone.
    expect(MODES.desktop).toBe(10);
    expect(MODES['tablet-landscape']).toBe(21);
    expect(MODES['tablet-portrait']).toBe(22);
    expect(MODES['mobile-landscape']).toBe(31);
    expect(MODES['mobile-portrait']).toBe(32);
  });

  it('maps the bare names to portrait, which is what a device actually reports', () => {
    // `detectMode` never reports bare rmTablet (20) or rmMobile (30). Asking for those would
    // apply the base rules while ignoring every portrait-specific one.
    expect(MODES.tablet).toBe(MODES['tablet-portrait']);
    expect(MODES.mobile).toBe(MODES['mobile-portrait']);
  });

  it('orders desktop below tablet below mobile, which the cascade depends on', () => {
    expect(MODES.desktop).toBeLessThan(MODES.tablet);
    expect(MODES.tablet).toBeLessThan(MODES.mobile);
  });

  it('is undefined for no mode, so the base layout is built', () => {
    expect(modeValue(undefined)).toBeUndefined();
  });

  it('offers every mode by name', () => {
    expect(MODE_NAMES).toContain('tablet');
    expect(MODE_NAMES).toContain('mobile-landscape');
    for (const name of MODE_NAMES) {
      expect(modeValue(name), name).toBeGreaterThan(0);
    }
  });
});

describe('viewportFor', () => {
  it('is portrait for the portrait modes and landscape for the landscape ones', () => {
    for (const name of ['tablet', 'tablet-portrait', 'mobile', 'mobile-portrait'] as const) {
      const { width, height } = viewportFor(name);
      expect(width, name).toBeLessThan(height);
    }
    for (const name of ['tablet-landscape', 'mobile-landscape', 'desktop'] as const) {
      const { width, height } = viewportFor(name);
      expect(width, name).toBeGreaterThan(height);
    }
  });

  it('gets narrower from desktop to tablet to phone', () => {
    expect(viewportFor('desktop').width).toBeGreaterThan(viewportFor('tablet').width);
    expect(viewportFor('tablet').width).toBeGreaterThan(viewportFor('mobile').width);
  });

  it('falls back to the desktop viewport when no mode is given', () => {
    expect(viewportFor(undefined)).toEqual(viewportFor('desktop'));
  });
});

/**
 * The picker's list, which is what the extension's preview offers.
 *
 * It is a view over the same table rather than a second one, so that adding a mode reaches the
 * dropdown and the MCP tools together.
 */
describe('MODE_CHOICES', () => {
  it('offers only modes the table knows', () => {
    for (const choice of MODE_CHOICES) {
      expect(MODES[choice.name], choice.name).toBeTypeOf('number');
      expect(choice.label.length).toBeGreaterThan(0);
    }
  });

  it('leaves out the bare tablet and mobile names, which are duplicates of portrait', () => {
    const names = MODE_CHOICES.map((choice) => choice.name);
    expect(names).not.toContain('tablet');
    expect(names).not.toContain('mobile');
    // One entry per distinct layout, so the picker never shows the same thing twice.
    expect(new Set(MODE_CHOICES.map((choice) => MODES[choice.name])).size).toBe(MODE_CHOICES.length);
  });

  it('reads from the largest device down, both orientations together', () => {
    // Grouped by device rather than sorted by width: a tablet in landscape (1112) is wider than
    // one in portrait (834), and splitting the pair apart to keep the numbers descending would
    // put the two tablet layouts either side of the phone.
    const names = MODE_CHOICES.map((choice) => choice.name);
    expect(names[0]).toBe('desktop');
    const lastTablet = names.findLastIndex((name) => name.startsWith('tablet'));
    const firstMobile = names.findIndex((name) => name.startsWith('mobile'));
    expect(lastTablet).toBeLessThan(firstMobile);
  });
});

describe('isModeName', () => {
  it('accepts every name the table has', () => {
    for (const name of MODE_NAMES) {
      expect(isModeName(name), name).toBe(true);
    }
  });

  it('rejects anything else, so a message from a webview cannot smuggle one in', () => {
    // The picker's value arrives as untrusted text; `toString` and friends are on every object.
    for (const value of ['', 'Desktop', 'phone', 'toString', 'constructor', 22, undefined, null]) {
      expect(isModeName(value), String(value)).toBe(false);
    }
  });
});
