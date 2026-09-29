import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Declaration } from '@vscode-dataflex/workspace';
import { rank } from '../src/tools/symbols';

const ROOT = resolve('/ws/MyApp');
const OWN = join(ROOT, 'AppSrc');
const DEPENDENCY = join(ROOT, 'DfPkg', 'DataFlex_dev_Web_UI-1.0', 'AppSrc');

function declaration(name: string, options: Partial<Declaration> = {}): Declaration {
  const zero = { line: 0, character: 0 };
  return {
    name,
    kind: 'class',
    file: join(OWN, `${name}.pkg`),
    range: { start: zero, end: zero },
    nameRange: { start: zero, end: zero },
    ...options
  } as Declaration;
}

describe('rank', () => {
  it('puts an exact match first, then prefixes, then the rest', () => {
    const found = rank(
      [declaration('cWebFormExtra'), declaration('somecWebForm'), declaration('cWebForm')],
      { query: 'cWebForm', root: ROOT }
    );
    expect(found.map((d) => d.name)).toEqual(['cWebForm', 'cWebFormExtra', 'somecWebForm']);
  });

  it('matches case-insensitively, as the index does', () => {
    const found = rank([declaration('other'), declaration('CWEBFORM')], {
      query: 'cwebform',
      root: ROOT
    });
    expect(found[0]!.name).toBe('CWEBFORM');
  });

  it('prefers the workspace\'s own source over a dependency', () => {
    const found = rank(
      [
        declaration('cThing', { file: join(DEPENDENCY, 'cThing.pkg') }),
        declaration('cThing', { file: join(OWN, 'cThing.pkg') })
      ],
      { query: 'cThing', root: ROOT }
    );
    expect(found[0]!.file).toContain('AppSrc');
    expect(found[0]!.file).not.toContain('DfPkg');
  });

  it('breaks a tie on the shorter name, which is the likelier intent', () => {
    const found = rank([declaration('cWebFormXY'), declaration('cWebFormZ')], {
      query: 'cWebForm',
      root: ROOT
    });
    expect(found.map((d) => d.name)).toEqual(['cWebFormZ', 'cWebFormXY']);
  });

  it('filters to one kind when asked', () => {
    const found = rank(
      [declaration('Refresh', { kind: 'procedure' }), declaration('Refresh', { kind: 'class' })],
      { query: 'Refresh', root: ROOT, kind: 'procedure' }
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe('procedure');
  });

  it('drops dependencies entirely under ownOnly', () => {
    const found = rank(
      [
        declaration('cThing', { file: join(DEPENDENCY, 'cThing.pkg') }),
        declaration('cThing', { file: join(OWN, 'cThing.pkg') })
      ],
      { query: 'cThing', root: ROOT, ownOnly: true }
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.file).not.toContain('DfPkg');
  });

  it('returns nothing rather than throwing when everything is filtered away', () => {
    expect(rank([declaration('a')], { query: 'a', root: ROOT, kind: 'procedure' })).toEqual([]);
  });
});
