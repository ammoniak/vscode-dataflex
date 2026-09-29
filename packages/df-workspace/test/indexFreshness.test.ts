import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { IncludeResolver } from '../src/includeResolver';
import { SymbolIndex } from '../src/symbolIndex';

/**
 * Whether the index notices a file that changed without an editor telling it.
 *
 * It matters most for `argument-count`, which compares a call against the declaration the index
 * holds. A stale declaration is not a missing answer but a wrong one: a method that has gained a
 * parameter goes on being compared against its old signature, and every call site is reported for
 * an argument it does in fact pass. That is what a real workspace hit -- three methods in one
 * package gained the same first parameter, and every call to all three was flagged.
 */
const scratch = mkdtempSync(join(tmpdir(), 'df-fresh-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const TWO_PARAMS = [
  'Class cFeed is a cObject',
  '    Function FeedToken String sLogin Integer iCompanyID Returns String',
  '        Function_Return ""',
  '    End_Function',
  'End_Class'
].join('\n');

const THREE_PARAMS = [
  'Class cFeed is a cObject',
  '    Function FeedToken String sFeedType String sLogin Integer iCompanyID Returns String',
  '        Function_Return ""',
  '    End_Function',
  'End_Class'
].join('\n');

/** Written with an mtime far enough back that the rewrite below is unambiguously newer. */
function write(path: string, text: string, secondsAgo = 0): void {
  writeFileSync(path, text, 'utf8');
  if (secondsAgo > 0) {
    const when = new Date(Date.now() - secondsAgo * 1000);
    utimesSync(path, when, when);
  }
}

function paramCountOf(index: SymbolIndex, name: string): number | undefined {
  return index.lookup(name)[0]?.paramCount;
}

describe('refreshStale', () => {
  it('re-reads a file that changed on disk after it was indexed', async () => {
    const root = mkdtempSync(join(scratch, 'ws-'));
    const file = join(root, 'cFeed.pkg');
    write(file, TWO_PARAMS, 60);

    const resolver = new IncludeResolver([root]);
    const index = new SymbolIndex();
    await index.build(resolver);
    expect(paramCountOf(index, 'FeedToken')).toBe(2);

    write(file, THREE_PARAMS);
    expect(index.refreshStale(resolver)).toEqual({ reindexed: 1, removed: 0 });
    expect(paramCountOf(index, 'FeedToken')).toBe(3);
  });

  it('leaves an unchanged workspace alone', async () => {
    const root = mkdtempSync(join(scratch, 'ws-'));
    write(join(root, 'cFeed.pkg'), TWO_PARAMS, 60);

    const resolver = new IncludeResolver([root]);
    const index = new SymbolIndex();
    await index.build(resolver);

    expect(index.refreshStale(resolver)).toEqual({ reindexed: 0, removed: 0 });
    // And again, so a file that stats but was never re-read is not reported every time.
    expect(index.refreshStale(resolver)).toEqual({ reindexed: 0, removed: 0 });
  });

  it('picks up a file that appeared after the build', async () => {
    const root = mkdtempSync(join(scratch, 'ws-'));
    write(join(root, 'cFeed.pkg'), TWO_PARAMS, 60);

    const resolver = new IncludeResolver([root]);
    const index = new SymbolIndex();
    await index.build(resolver);
    expect(index.lookup('Later')).toEqual([]);

    write(join(root, 'cLater.pkg'), 'Class cLater is a cObject\nEnd_Class');
    expect(index.refreshStale(resolver).reindexed).toBe(1);
    expect(index.lookup('cLater')).toHaveLength(1);
  });

  it('drops the declarations of a file that is gone', async () => {
    const root = mkdtempSync(join(scratch, 'ws-'));
    const file = join(root, 'cFeed.pkg');
    write(file, TWO_PARAMS, 60);
    write(join(root, 'cKeep.pkg'), 'Class cKeep is a cObject\nEnd_Class', 60);

    const resolver = new IncludeResolver([root]);
    const index = new SymbolIndex();
    await index.build(resolver);
    expect(index.lookup('FeedToken')).toHaveLength(1);

    rmSync(file);
    expect(index.refreshStale(resolver)).toEqual({ reindexed: 0, removed: 1 });
    expect(index.lookup('FeedToken')).toEqual([]);
    // The file that stayed is untouched, and a second sweep reports nothing further.
    expect(index.lookup('cKeep')).toHaveLength(1);
    expect(index.refreshStale(resolver)).toEqual({ reindexed: 0, removed: 0 });
  });

  it('does nothing on an index that was never built', () => {
    const root = mkdtempSync(join(scratch, 'ws-'));
    write(join(root, 'cFeed.pkg'), TWO_PARAMS);

    // No baseline to compare against; indexing the search path is `build`'s job.
    const index = new SymbolIndex();
    expect(index.refreshStale(new IncludeResolver([root]))).toEqual({ reindexed: 0, removed: 0 });
    expect(index.lookup('FeedToken')).toEqual([]);
  });
});
