/**
 * Decides what a half-typed DataFlex line is asking for.
 *
 * Kept free of any `vscode` import so the regexes -- the most failure-prone part of completion --
 * can be unit tested directly.
 */
export type Verb = 'set' | 'get' | 'webset' | 'webget';

export type Request =
  | { what: 'member'; verb: Verb; prefix: string }
  | { what: 'object'; prefix: string }
  | { what: 'class'; prefix: string }
  | { what: 'method'; prefix: string };

/**
 * Works out what the cursor is asking for from the text before it.
 *
 * The line prefix is used rather than the parse tree because a half-typed line (`WebSet ps`) is
 * not yet a statement the parser can classify, and completion has to work precisely then.
 */
export function classifyRequest(linePrefix: string): Request | undefined {
  // Inside a comment there is nothing completion can usefully offer.
  if (linePrefix.includes('//')) {
    return undefined;
  }

  // `Object oX is a <cursor>` -- most specific, so tested first.
  const isA = /\bis\s+an?\s+([A-Za-z_$][\w$#]*)?$/i.exec(linePrefix);
  if (isA !== null) {
    return { what: 'class', prefix: isA[1] ?? '' };
  }

  // `... of <cursor>` names a receiving object.
  const of = /\bof\s+([A-Za-z_$][\w$#]*)?$/i.exec(linePrefix);
  if (of !== null) {
    return { what: 'object', prefix: of[1] ?? '' };
  }

  const member = /(?:^|\s)(WebSet|WebGet|Set|Get)\s+([A-Za-z_$][\w$#]*)?$/i.exec(linePrefix);
  if (member !== null) {
    return {
      what: 'member',
      verb: member[1]!.toLowerCase() as Verb,
      prefix: member[2] ?? ''
    };
  }

  const send = /(?:^|\s)(?:Send|Broadcast|Delegate)\s+([A-Za-z_$][\w$#]*)?$/i.exec(linePrefix);
  if (send !== null) {
    return { what: 'method', prefix: send[1] ?? '' };
  }

  return undefined;
}
