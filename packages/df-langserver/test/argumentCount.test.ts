import { describe, expect, it } from 'vitest';
import { parseSource } from '@vscode-dataflex/parser';
import { findArgumentCountMismatches, makeArityResolver } from '../src/analysis/argumentCount';
import type { ArityIndex } from '../src/analysis/argumentCount';

const NL = '\n';

/** A stand-in index, so the rule's guards can be exercised without building a real one. */
function indexOf(
  declarations: Record<
    string,
    { kind?: string; file?: string; paramCount?: number; inspectsArgumentCount?: boolean }[]
  >
): ArityIndex {
  return {
    lookup: (name) =>
      (declarations[name.toLowerCase()] ?? []).map((entry) => ({
        kind: entry.kind ?? 'procedure',
        file: entry.file ?? 'C:\\ws\\AppSrc\\Own.pkg',
        paramCount: entry.paramCount,
        inspectsArgumentCount: entry.inspectsArgumentCount
      }))
  };
}

const OWNED = (file: string): boolean => file.toLowerCase().includes('\\ws\\appsrc\\');

function findings(source: string, index: ArityIndex) {
  const unit = parseSource(source, { uri: 'C:\\ws\\AppSrc\\Caller.pkg' });
  return findArgumentCountMismatches(unit, makeArityResolver(index, OWNED));
}

function call(body: string): string {
  return ['Procedure Caller', `    ${body}`, 'End_Procedure'].join(NL);
}

describe('argument-count', () => {
  it('reports a call that passes too few arguments', () => {
    const found = findings(
      call('Send PopDialogX'),
      indexOf({ popdialogx: [{ paramCount: 1 }] })
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("'PopDialogX' takes 1 argument but 0 are passed here");
    expect(found[0]!.message).toContain('num_arguments');
  });

  it('reports a call that passes too many', () => {
    const found = findings(
      call('Send PopDialogX Self "a" "b"'),
      indexOf({ popdialogx: [{ paramCount: 1 }] })
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('but 3 are passed here');
    expect(found[0]!.message).toContain('ignored');
  });

  it('says nothing when the count matches', () => {
    expect(
      findings(call('Send PopDialogX Self'), indexOf({ popdialogx: [{ paramCount: 1 }] }))
    ).toEqual([]);
  });

  it('stays silent when the callee reads num_arguments', () => {
    // DataFlex has no optional-parameter syntax; testing num_arguments is how a method accepts a
    // variable number, and callers passing fewer are correct.
    expect(
      findings(
        call('Send Log "x"'),
        indexOf({ log: [{ paramCount: 3, inspectsArgumentCount: true }] })
      )
    ).toEqual([]);
  });

  it('stays silent when declarations disagree on arity', () => {
    // Several classes may declare the same message and dispatch picks at runtime, so no single
    // answer is right.
    expect(
      findings(
        call('Send Refresh 1'),
        indexOf({ refresh: [{ paramCount: 0 }, { paramCount: 2 }] })
      )
    ).toEqual([]);
  });

  it('stays silent when only the runtime library declares the name', () => {
    // `Send DefineParam to hDispatchDriver` addresses an OLE object that handles the message
    // dynamically. The name happening to match a private framework method is not evidence.
    expect(
      findings(
        call('Send DefineParam to hDriver OLE_VT_I4 llDays'),
        indexOf({ defineparam: [{ paramCount: 7, file: 'C:\\Program Files\\DataFlex 26.0\\Pkg\\x.pkg' }] })
      )
    ).toEqual([]);
  });

  it('still lets a runtime declaration veto a workspace one', () => {
    expect(
      findings(
        call('Send Refresh 1'),
        indexOf({
          refresh: [
            { paramCount: 0 },
            { paramCount: 3, file: 'C:\\Program Files\\DataFlex 26.0\\Pkg\\x.pkg' }
          ]
        })
      )
    ).toEqual([]);
  });

  it('stays silent when nothing declares the name', () => {
    expect(findings(call('Send Whatever 1 2'), indexOf({}))).toEqual([]);
  });

  it('counts arguments after the receiver of a Send ... to', () => {
    // For `Send`, a bare `to` names the receiver and the arguments follow it.
    expect(
      findings(
        call('Send Apply to oTarget 1 2'),
        indexOf({ apply: [{ paramCount: 2 }] })
      )
    ).toEqual([]);
  });

  it('counts arguments before the destination of a Get ... to', () => {
    // For `Get`, the same word names the destination and the arguments precede it.
    expect(
      findings(call('Get Sum 1 2 to iTotal'), indexOf({ sum: [{ kind: 'function', paramCount: 2 }] }))
    ).toEqual([]);
  });

  it('counts a Get with both a receiver and a destination', () => {
    // `Get <Msg> of <object> <args...> to <dest>` is the ordinary shape for calling a function on
    // a global handle, and it puts the two meanings of the surrounding words on one line: `of`
    // introduces a receiver that is not an argument, `to` a destination that is not one either.
    // Reported once against a three-parameter function that was passed three arguments.
    expect(
      findings(
        call('Get FeedToken of ghoCalendarFeed C_FeedTypeTermine sLogin iCompanyID to sToken'),
        indexOf({ feedtoken: [{ kind: 'function', paramCount: 3 }] })
      )
    ).toEqual([]);
  });

  it('reports a Get with a receiver when the count really is wrong', () => {
    const found = findings(
      call('Get FeedToken of ghoCalendarFeed sLogin iCompanyID to sToken'),
      indexOf({ feedtoken: [{ kind: 'function', paramCount: 3 }] })
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("'FeedToken' takes 3 arguments but 2 are passed here");
  });

  it('ignores Set, whose value follows `to`', () => {
    // `Set psCaption to "x"` has an empty argument list before `to`, so checking it would report
    // every setter call in the workspace.
    expect(
      findings(call('Set psCaption to "x"'), indexOf({ pscaption: [{ paramCount: 1 }] }))
    ).toEqual([]);
  });

  it('ignores a call whose arguments did not fully parse', () => {
    const unit = parseSource(call('Send PopDialogX (a + '), { uri: 'C:\\ws\\AppSrc\\Caller.pkg' });
    const found = findArgumentCountMismatches(
      unit,
      makeArityResolver(indexOf({ popdialogx: [{ paramCount: 3 }] }), OWNED)
    );
    expect(found).toEqual([]);
  });

  it('points at the message name, not the whole line', () => {
    const found = findings(
      call('Send PopDialogX'),
      indexOf({ popdialogx: [{ paramCount: 2 }] })
    );
    expect(found[0]!.range.start.line).toBe(1);
    expect(found[0]!.range.start.character).toBeGreaterThan(4);
  });
});
