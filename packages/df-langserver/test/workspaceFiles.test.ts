import { describe, expect, it } from 'vitest';
import { isWorkspaceOwnedFile, ownedFiles } from '../src/analysis/workspaceFiles';

const SEP = String.fromCharCode(92);
const ROOT = ['C:', 'DataFlex 26.0 Examples', 'WebOrder'].join(SEP);

/** Joins path segments with a Windows separator without embedding escapes in the source. */
function win(...parts: string[]): string {
  return parts.join(SEP);
}

describe('isWorkspaceOwnedFile', () => {
  it('accepts source under the workspace root', () => {
    expect(isWorkspaceOwnedFile(win(ROOT, 'AppSrc', 'Customer.wo'), ROOT)).toBe(true);
    expect(isWorkspaceOwnedFile(win(ROOT, 'DDSrc', 'cCustomer.dd'), ROOT)).toBe(true);
  });

  it('rejects a materialised package dependency with Windows separators', () => {
    // The bug this guards: a character class written as [\/] matches only a forward slash, so
    // every DfPkg path with backslashes slipped through and dependency findings leaked in.
    expect(
      isWorkspaceOwnedFile(
        win(ROOT, 'DfPkg', 'DataFlex_dev_Web_UI-1.0.52', 'AppSrc', 'cWebForm.pkg'),
        ROOT
      )
    ).toBe(false);
  });

  it('rejects a dependency with forward separators too', () => {
    expect(
      isWorkspaceOwnedFile(
        'C:/DataFlex 26.0 Examples/WebOrder/DfPkg/DataFlex_dev_Web_UI-1.0.52/AppSrc/cWebForm.pkg',
        'C:/DataFlex 26.0 Examples/WebOrder'
      )
    ).toBe(false);
  });

  it('rejects anything outside the workspace root', () => {
    expect(
      isWorkspaceOwnedFile(win('C:', 'Program Files', 'DataFlex 26.0', 'Pkg', 'Windows.pkg'), ROOT)
    ).toBe(false);
  });

  it('is case-insensitive, as Windows paths are', () => {
    expect(isWorkspaceOwnedFile(win(ROOT, 'dfpkg', 'x', 'y.pkg'), ROOT)).toBe(false);
    expect(isWorkspaceOwnedFile(win(ROOT.toUpperCase(), 'AppSrc', 'a.wo'), ROOT)).toBe(true);
  });

  it('does not reject a directory merely containing "dfpkg" in its name', () => {
    expect(isWorkspaceOwnedFile(win(ROOT, 'AppSrc', 'MyDfPkgHelpers', 'a.pkg'), ROOT)).toBe(true);
  });
});

describe('ownedFiles', () => {
  it('keeps only the workspace source', () => {
    const own = win(ROOT, 'AppSrc', 'Customer.wo');
    const files = [
      own,
      win(ROOT, 'DfPkg', 'DataFlex_dev_Web_UI-1.0.52', 'AppSrc', 'cWebForm.pkg'),
      win('C:', 'Program Files', 'DataFlex 26.0', 'Pkg', 'Windows.pkg')
    ];
    expect(ownedFiles(files, ROOT)).toEqual([own]);
  });
});
