/**
 * Parser for the JUnit XML that DFUnit's `cDFUnitXMLReporter` writes.
 *
 * The shape is fixed and small:
 *
 * ```xml
 * <?xml version="1.0" encoding="UTF-8"?>
 * <testsuites>
 *   <testsuite name="Probe" errors="0" failures="1">
 *     <testsuite name="OuterFixture" errors="0" failures="1">
 *       <testcase name="InnerFails" assertions="1" 0.001>
 *         <failure message="deliberate failure"></failure>
 *       </testcase>
 *     </testsuite>
 *     <testcase name="TopLevelPasses" assertions="1" 0.000></testcase>
 *   </testsuite>
 * </testsuites>
 * ```
 *
 * Suites nest to mirror fixture nesting, which is what lets results be matched back to the
 * discovered tree by fixture path.
 *
 * It is parsed by hand rather than with an XML library because the reporter builds the document
 * with `SFormat` and does not escape attribute values -- an assertion message containing a quote
 * or an angle bracket produces XML that a strict parser rejects outright. Being tolerant here
 * means a failing test still reports its failure instead of the whole run coming back empty.
 */

export interface JUnitTestCase {
  name: string;
  /** Fixture names from the outermost suite inwards. */
  suitePath: string[];
  status: 'passed' | 'failed' | 'errored';
  message?: string;
  assertions?: number;
  /** Seconds, when the reporter emitted a parseable time. */
  duration?: number;
}

export interface JUnitResults {
  cases: JUnitTestCase[];
  suiteNames: string[];
}

interface Tag {
  name: string;
  attributes: Record<string, string>;
  selfClosing: boolean;
  closing: boolean;
}

/** Pulls `key="value"` pairs out of a tag body, tolerating unescaped junk between them. */
function parseAttributes(body: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    attributes[match[1]!] = decodeEntities(match[2]!);
  }
  return attributes;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Scans tags in document order, skipping the XML declaration and any text between them. */
function* tags(xml: string): Generator<Tag> {
  const pattern = /<([/?]?)\s*([A-Za-z_][\w.:-]*)([^>]*)>/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(xml)) !== null) {
    const prefix = match[1]!;
    if (prefix === '?') {
      continue;
    }
    const body = match[3] ?? '';
    yield {
      name: match[2]!.toLowerCase(),
      attributes: parseAttributes(body),
      selfClosing: body.trimEnd().endsWith('/'),
      closing: prefix === '/'
    };
  }
}

/**
 * Parses a DFUnit JUnit report.
 *
 * Never throws: a truncated or malformed document yields whatever cases were readable, because a
 * partial result is more useful to the runner than an exception.
 */
export function parseJUnit(xml: string): JUnitResults {
  const cases: JUnitTestCase[] = [];
  const suiteNames: string[] = [];
  const suiteStack: string[] = [];

  let current: JUnitTestCase | undefined;

  for (const tag of tags(xml)) {
    if (tag.name === 'testsuite') {
      if (tag.closing) {
        suiteStack.pop();
      } else {
        const name = tag.attributes['name'] ?? '(unnamed)';
        suiteNames.push(name);
        if (!tag.selfClosing) {
          suiteStack.push(name);
        }
      }
      continue;
    }

    if (tag.name === 'testcase') {
      if (tag.closing) {
        if (current !== undefined) {
          cases.push(current);
          current = undefined;
        }
        continue;
      }

      const assertions = Number.parseInt(tag.attributes['assertions'] ?? '', 10);
      // The reporter emits the elapsed time as a bare token rather than a named attribute, so
      // pick up `time` when present and otherwise leave it undefined.
      const time = Number.parseFloat(tag.attributes['time'] ?? '');

      const testCase: JUnitTestCase = {
        name: tag.attributes['name'] ?? '(unnamed)',
        suitePath: [...suiteStack],
        status: 'passed',
        assertions: Number.isNaN(assertions) ? undefined : assertions,
        duration: Number.isNaN(time) ? undefined : time
      };

      if (tag.selfClosing) {
        cases.push(testCase);
      } else {
        current = testCase;
      }
      continue;
    }

    // A `<failure>` or `<error>` child marks the enclosing case.
    if ((tag.name === 'failure' || tag.name === 'error') && !tag.closing && current !== undefined) {
      current.status = tag.name === 'failure' ? 'failed' : 'errored';
      const message = tag.attributes['message'];
      if (message !== undefined && message.length > 0) {
        current.message = current.message === undefined ? message : `${current.message}\n${message}`;
      }
    }
  }

  // An unterminated final case still counts.
  if (current !== undefined) {
    cases.push(current);
  }

  return { cases, suiteNames };
}
