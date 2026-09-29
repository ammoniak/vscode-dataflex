import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Finds the executable a project builds to.
 *
 * DataFlex appends `64` to the name for 64-bit projects unless the suffix is turned off, so both
 * spellings exist in the wild and a workspace that has been built both ways holds both. The newest
 * wins, because that is the one the last build produced and so the one a run or a debug session is
 * about to be talking about.
 */
export function findProgram(directory: string, stem: string): string | undefined {
  const candidates = [join(directory, `${stem}.exe`), join(directory, `${stem}64.exe`)].filter((path) =>
    existsSync(path)
  );

  if (candidates.length <= 1) {
    return candidates[0];
  }

  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}
