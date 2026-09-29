import { describe, expect, it } from 'vitest';
import { classifyRequest } from '../src/completionContext';

/**
 * These regexes decide what completion offers, from a line that is mid-edit and therefore not
 * yet parseable. Getting one wrong silently degrades the headline feature into offering nothing
 * (or offering everything), so each shape gets a case.
 */
describe('classifyRequest', () => {
  it('recognises a property position after each verb', () => {
    expect(classifyRequest('    Set ps')).toEqual({ what: 'member', verb: 'set', prefix: 'ps' });
    expect(classifyRequest('    Get ps')).toEqual({ what: 'member', verb: 'get', prefix: 'ps' });
    expect(classifyRequest('    WebSet ps')).toEqual({
      what: 'member',
      verb: 'webset',
      prefix: 'ps'
    });
    expect(classifyRequest('    WebGet ps')).toEqual({
      what: 'member',
      verb: 'webget',
      prefix: 'ps'
    });
  });

  it('is case-insensitive, as the language is', () => {
    expect(classifyRequest('    WEBSET PS')).toEqual({
      what: 'member',
      verb: 'webset',
      prefix: 'PS'
    });
    expect(classifyRequest('    webset ps')?.verb).toBe('webset');
  });

  it('handles the verb with nothing typed yet', () => {
    expect(classifyRequest('    WebSet ')).toEqual({ what: 'member', verb: 'webset', prefix: '' });
  });

  it('does not mistake WebSet for Set', () => {
    // `(?:^|\s)` matters: without it, `WebSet` would match the `Set` alternative and the
    // published-property filter would be skipped.
    expect(classifyRequest('    WebSet ps')?.verb).toBe('webset');
    expect(classifyRequest('WebGet psValue')?.verb).toBe('webget');
  });

  it('recognises an object position after `of`', () => {
    expect(classifyRequest('    Set psValue of ')).toEqual({ what: 'object', prefix: '' });
    expect(classifyRequest('    Set psValue of oCust')).toEqual({
      what: 'object',
      prefix: 'oCust'
    });
    expect(classifyRequest('    WebGet psValue of oForm')).toEqual({
      what: 'object',
      prefix: 'oForm'
    });
  });

  it('recognises a class position after `is a`', () => {
    expect(classifyRequest('    Object oX is a ')).toEqual({ what: 'class', prefix: '' });
    expect(classifyRequest('    Object oX is a cWeb')).toEqual({ what: 'class', prefix: 'cWeb' });
    // A complete-looking class name is still a class position: the user may be part-way through
    // a longer name.
    expect(classifyRequest('    Object oX is a cWebForm')).toEqual({
      what: 'class',
      prefix: 'cWebForm'
    });
    expect(classifyRequest('Class cX is an ')).toEqual({ what: 'class', prefix: '' });
  });

  it('prefers the later clause when a line has several', () => {
    // `of` comes after the verb, so the cursor is choosing an object, not a property.
    expect(classifyRequest('    Set psValue of oCu')?.what).toBe('object');
  });

  it('recognises a message position after Send', () => {
    expect(classifyRequest('    Send Refresh')).toEqual({ what: 'method', prefix: 'Refresh' });
    expect(classifyRequest('    Broadcast ')).toEqual({ what: 'method', prefix: '' });
  });

  it('accepts $ and # in a typed prefix', () => {
    expect(classifyRequest('    Set Is$Web')?.prefix).toBe('Is$Web');
    expect(classifyRequest('    Send Row#')?.prefix).toBe('Row#');
  });

  it('returns nothing where completion does not apply', () => {
    expect(classifyRequest('')).toBeUndefined();
    expect(classifyRequest('    Procedure OnLoad')).toBeUndefined();
    expect(classifyRequest('    End_Object')).toBeUndefined();
  });

  it('stays quiet inside a comment', () => {
    expect(classifyRequest('    // Set ps')).toBeUndefined();
    expect(classifyRequest('    Set psLabel to "x" // Set ps')).toBeUndefined();
    expect(classifyRequest('    // Object oX is a cWeb')).toBeUndefined();
  });

  it('stops offering properties once the value position is reached', () => {
    // `Set psLabel to "x` is typing a value, not a property name.
    expect(classifyRequest('    Set psLabel to ')).toBeUndefined();
    expect(classifyRequest('    Set psLabel to "Name:"')).toBeUndefined();
  });
});
