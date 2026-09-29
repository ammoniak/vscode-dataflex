import { lex } from './lexer';
import { toLogicalLines, LogicalLine } from './logicalLines';
import { Token, TokenKind, Range, eqi } from './tokens';
import { BlockKind, DfMetadata, DfNode, DfParam, ParseDiagnostic, SourceUnit } from './ast';
import { BUILTIN_TYPES, CONDITIONAL_DIRECTIVES, STATEMENT_VERBS } from './keywords';

/**
 * Statement verbs that transfer control unconditionally.
 *
 * Recorded as a category on the node so control-flow analysis can ask directly instead of
 * matching verb strings at every call site.
 */
const TRANSFERS: ReadonlyMap<string, 'return' | 'break' | 'abort' | 'error'> = new Map([
  ['procedure_return', 'return'],
  ['function_return', 'return'],
  ['break', 'break'],
  ['abort', 'abort'],
  ['error', 'error']
]);

export interface ParseOptions {
  uri?: string;
  /**
   * Extra type names that may introduce a variable declaration -- normally the struct names
   * collected by the workspace index. Structs declared in the file being parsed are picked up
   * automatically and do not need to be listed here.
   */
  knownTypes?: ReadonlySet<string>;
  /**
   * Names of `#COMMAND` macros visible to this file, lower-cased.
   *
   * DataFlex statement syntax is largely macro-defined -- the runtime library alone declares
   * ~499 commands, and application libraries add their own (`WebPublishProcedure`,
   * `WebSetResponsive`, ...). Rather than hardcoding an ever-growing verb list, the workspace
   * linker collects the declared command names and passes them here. Commands declared in the
   * file being parsed are picked up automatically.
   */
  knownCommands?: ReadonlySet<string>;
}

const EMPTY_RANGE: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

function lower(token: Token | undefined): string {
  return token === undefined ? '' : token.text.toLowerCase();
}

function isIdent(token: Token | undefined): token is Token {
  return token !== undefined && token.kind === TokenKind.Identifier;
}

function stripQuotes(value: string): string {
  return value.replace(/^["'<]+/, '').replace(/[">']+$/, '');
}

/**
 * Parses one DataFlex source file into a tolerant structure tree.
 *
 * The parser is line-oriented because the language is: outside of `;` continuations, one
 * statement occupies one line, and block nesting is expressed with explicit keyword pairs
 * (`Object`/`End_Object`, `Begin`/`End`, ...). It never throws, and an unbalanced or
 * unrecognised construct degrades to a diagnostic plus an `unknown` node rather than aborting
 * the parse -- editors must keep working on a file that is mid-edit.
 *
 * Conditional-compilation directives (`#IFDEF` and friends) are deliberately *not* treated as
 * blocks: in real DataFlex source they routinely straddle other constructs (half an object body
 * inside an `#IFDEF`), so nesting them would corrupt the tree. Resolving them is the
 * preprocessor layer's job.
 */
export function parseSource(text: string, options: ParseOptions = {}): SourceUnit {
  const { tokens } = lex(text);
  const lines = toLogicalLines(tokens);

  const diagnostics: ParseDiagnostic[] = [];
  const uses: DfNode[] = [];
  const localStructTypes = new Set<string>();
  const localCommands = new Set<string>();

  const root: DfNode = {
    kind: 'sourceUnit',
    range: EMPTY_RANGE,
    headerRange: EMPTY_RANGE,
    children: []
  };

  const stack: DfNode[] = [root];
  let pendingMetadata: DfMetadata[] = [];
  let pendingComments: string[] = [];
  let unknownCount = 0;
  let logicalLineCount = 0;

  const top = (): DfNode => stack[stack.length - 1]!;

  const sliceOf = (line: LogicalLine): string => {
    const first = line.tokens[0];
    const last = line.tokens[line.tokens.length - 1];
    return first === undefined || last === undefined ? '' : text.slice(first.start, last.end);
  };

  const takeDoc = (line: LogicalLine): string | undefined => {
    const parts = [...pendingComments];
    for (const comment of line.comments) {
      const stripped = comment.text.replace(/^\/\/+/, '').trim();
      if (stripped.length > 0) {
        parts.push(stripped);
      }
    }
    pendingComments = [];
    return parts.length > 0 ? parts.join('\n') : undefined;
  };

  const takeMetadata = (): DfMetadata[] | undefined => {
    if (pendingMetadata.length === 0) {
      return undefined;
    }
    const taken = pendingMetadata;
    pendingMetadata = [];
    return taken;
  };

  const addChild = (node: DfNode): DfNode => {
    (top().children ??= []).push(node);
    return node;
  };

  const openBlock = (node: DfNode): DfNode => {
    node.children ??= [];
    addChild(node);
    stack.push(node);
    return node;
  };

  /**
   * Closes the innermost open node of `expectedKind`, popping anything left open inside it.
   * A closer with no matching opener is reported and otherwise ignored, which keeps the tree
   * stable while the user is typing.
   */
  const closeBlock = (expected: string | string[], line: LogicalLine, closedBy?: string): void => {
    const expectedKinds = typeof expected === 'string' ? [expected] : expected;
    for (let i = stack.length - 1; i >= 1; i--) {
      if (expectedKinds.includes(stack[i]!.kind)) {
        for (let j = stack.length - 1; j >= i; j--) {
          stack[j]!.range = { start: stack[j]!.range.start, end: line.range.end };
          stack[j]!.closedBy ??= closedBy ?? lower(line.tokens[0]);
          stack.pop();
        }
        return;
      }
    }
    diagnostics.push({
      message: `Unmatched '${sliceOf(line)}' -- no open ${expectedKinds.join(' or ')} to close.`,
      range: line.range,
      severity: 'warning'
    });
  };

  const parseMetadataLine = (line: LogicalLine): DfMetadata[] => {
    const result: DfMetadata[] = [];
    const toks = line.tokens;
    let i = 0;
    while (i < toks.length) {
      if (toks[i]!.text !== '{') {
        i++;
        continue;
      }
      const open = toks[i]!;
      i++;

      // One brace pair can carry several tags: `{ WebProperty=Server Visibility=Private }`.
      // A value therefore ends where the next `<Name> =` begins, not at the closing brace.
      while (i < toks.length && toks[i]!.text !== '}') {
        const nameToken = toks[i];
        if (!isIdent(nameToken)) {
          i++;
          continue;
        }
        i++;

        let value: string | undefined;
        if (toks[i]?.text === '=') {
          i++;
          const parts: string[] = [];
          while (i < toks.length && toks[i]!.text !== '}') {
            // Lookahead: `<Identifier> =` starts the next tag rather than continuing this value.
            if (isIdent(toks[i]) && toks[i + 1]?.text === '=') {
              break;
            }
            parts.push(toks[i]!.text);
            i++;
          }
          value = stripQuotes(parts.join(''));
        }

        result.push({
          name: nameToken.text,
          value,
          range: { start: open.range.start, end: (toks[i] ?? open).range.end }
        });
      }

      if (toks[i]?.text === '}') {
        i++;
      }
    }
    return result;
  };

  /** Reads a `<Type> <name>` parameter list, honouring `ByRef` and stopping at `Returns`. */
  const parseParams = (toks: Token[]): { params: DfParam[]; returnType?: string } => {
    const params: DfParam[] = [];
    let pendingType: Token | undefined;
    let byRef = false;
    let returnType: string | undefined;

    for (let i = 0; i < toks.length; i++) {
      const token = toks[i]!;
      if (eqi(token.text, 'returns')) {
        returnType = toks[i + 1]?.text;
        break;
      }
      if (!isIdent(token)) {
        continue;
      }
      if (eqi(token.text, 'byref')) {
        byRef = true;
        continue;
      }
      // `Function CreateDirectoryRecursive Global String sDir Returns Boolean` -- `Global` marks
      // the method, not a parameter. Reading it as a type pairs it with `String` and then leaves
      // `sDir` dangling, so every global method reported one parameter too many.
      if (eqi(token.text, 'global')) {
        continue;
      }
      if (pendingType === undefined) {
        pendingType = token;
        continue;
      }
      params.push({ type: pendingType.text, name: token.text, byRef, range: token.range });
      pendingType = undefined;
      byRef = false;
    }

    // A dangling token is an untyped parameter (legacy DataFlex allows it).
    if (pendingType !== undefined) {
      params.push({ name: pendingType.text, byRef, range: pendingType.range });
    }

    return { params, returnType };
  };

  /** Extracts the `is a <Class>` clause from an `Object`/`Class` header. */
  const parseIsA = (toks: Token[]): { superClass?: string; superClassRange?: Range } => {
    for (let i = 0; i < toks.length; i++) {
      if (eqi(toks[i]!.text, 'is')) {
        const candidate = eqi(toks[i + 1]?.text ?? '', 'a') ? toks[i + 2] : toks[i + 1];
        if (isIdent(candidate)) {
          return { superClass: candidate.text, superClassRange: candidate.range };
        }
      }
    }
    return {};
  };

  const knownType = (name: string): boolean => {
    const key = name.toLowerCase().replace(/\[\]$/, '');
    return (
      BUILTIN_TYPES.has(key) ||
      localStructTypes.has(key) ||
      options.knownTypes?.has(key) === true
    );
  };

  /** Span covering a run of tokens. */
  const spanOf = (toks: Token[]): Range => ({
    start: toks[0]!.range.start,
    end: toks[toks.length - 1]!.range.end
  });

  const textOf = (toks: Token[]): string =>
    toks.length === 0 ? '' : text.slice(toks[0]!.start, toks[toks.length - 1]!.end);

  /**
   * Builds a statement node from a span of tokens.
   *
   * Shared by whole lines and by the consequent of a single-line conditional, so both are modelled
   * identically.
   */
  const makeStatement = (toks: Token[], range: Range): DfNode => {
    const first = toks[0]!;
    const verb = lower(first);
    const recognized =
      isIdent(first) &&
      (STATEMENT_VERBS.has(verb) ||
        localCommands.has(verb) ||
        options.knownCommands?.has(verb) === true);

    const node: DfNode = {
      kind: recognized ? 'statement' : 'unknown',
      range,
      headerRange: range,
      text: textOf(toks),
      verb,
      transfer: TRANSFERS.get(verb)
    };
    if (!recognized) {
      unknownCount++;
    }

    const subject = toks[1];
    if (isIdent(subject)) {
      node.target = subject.text;
      node.targetRange = subject.range;
    }

    // `Set psLabel of oForm to "x"` -- the object is named by `of`. For message sends the
    // receiver follows `to` instead; for `Set`/`Move` a bare `to` introduces the *value*, so it
    // must not be mistaken for a receiver.
    const ofIndex = toks.findIndex((t) => isIdent(t) && eqi(t.text, 'of'));
    if (ofIndex > 0 && isIdent(toks[ofIndex + 1])) {
      node.ofObject = toks[ofIndex + 1]!.text;
      node.ofObjectRange = toks[ofIndex + 1]!.range;
    } else if (verb === 'send' || verb === 'broadcast' || verb === 'delegate') {
      const toIndex = toks.findIndex((t) => isIdent(t) && eqi(t.text, 'to'));
      if (toIndex > 0 && isIdent(toks[toIndex + 1])) {
        node.ofObject = toks[toIndex + 1]!.text;
        node.ofObjectRange = toks[toIndex + 1]!.range;
      }
    }

    return node;
  };

  /**
   * Splits `If (cond) <stmt>` into its condition and the statement it guards.
   *
   * The condition is usually parenthesised, but the runtime library also writes it bare
   * (`If iState Send Foo`), so an unparenthesised single token is accepted too.
   */
  const isStatementHead = (verb: string): boolean =>
    STATEMENT_VERBS.has(verb) ||
    localCommands.has(verb) ||
    options.knownCommands?.has(verb) === true;

  const splitCondition = (toks: Token[]): { condition?: string; rest: Token[] } => {
    if (eqi(toks[0]!.text, 'else')) {
      return { rest: toks.slice(1) };
    }

    let i = 1;
    if (toks[i]?.text === '(') {
      let depth = 0;
      for (; i < toks.length; i++) {
        if (toks[i]!.text === '(') {
          depth++;
        } else if (toks[i]!.text === ')') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
    } else {
      // Unparenthesised, and it can span several tokens: `If iRet Eq 0 Function_Return -1`.
      // The consequent starts at the first recognised statement verb.
      i = toks.length;
      for (let j = 1; j < toks.length; j++) {
        const token = toks[j]!;
        if (isIdent(token) && isStatementHead(lower(token))) {
          i = j;
          break;
        }
      }
    }

    const rest = toks.slice(i);
    // Only claim block structure when the consequent is recognisably a statement. Inventing it
    // for an unrecognised verb would report a shape that was never verified -- and would hide the
    // unrecognised verb behind the `if`, which is what the unknown-rate metric exists to expose.
    if (rest.length === 0 || !(isIdent(rest[0]) && isStatementHead(lower(rest[0])))) {
      return { condition: textOf(toks.slice(1, i)), rest: [] };
    }
    return { condition: textOf(toks.slice(1, i)), rest };
  };

  /**
   * Normalises a single-line conditional into the same shape as the `Begin`/`End` form.
   *
   * `If (bDone) Function_Return 0` becomes a conditional *block* holding the return, exactly as
   * `If (bDone) Begin ... End` would. Control-flow analysis then has one shape to handle rather
   * than a statement whose consequent is buried in raw text -- which is what previously forced
   * the unreachable-code rule to pattern-match on that text. `Else If (x) Send Foo` nests.
   */
  const makeInlineConditional = (toks: Token[], lineRange: Range): DfNode | undefined => {
    const head = lower(toks[0]);
    if (head !== 'if' && head !== 'else') {
      return undefined;
    }
    const { condition, rest } = splitCondition(toks);
    if (rest.length === 0) {
      return undefined;
    }

    const bodyRange = spanOf(rest);
    const nested = makeInlineConditional(rest, bodyRange);
    return {
      kind: 'block',
      blockKind: head,
      verb: head,
      inline: true,
      condition,
      range: lineRange,
      headerRange: spanOf(toks.slice(0, toks.length - rest.length)),
      text: textOf(toks),
      children: [nested ?? makeStatement(rest, bodyRange)]
    };
  };

  for (const line of lines) {
    if (line.tokens.length === 0) {
      if (line.comments.length > 0) {
        for (const comment of line.comments) {
          const stripped = comment.text.replace(/^\/\/+/, '').trim();
          if (stripped.length > 0) {
            pendingComments.push(stripped);
          }
        }
      } else {
        pendingComments = [];
        pendingMetadata = [];
      }
      continue;
    }

    const toks = line.tokens;
    const t0 = toks[0]!;

    // `{ Tag=Value }` annotation lines attach to the declaration that follows.
    if (t0.kind === TokenKind.Punct && t0.text === '{') {
      pendingMetadata.push(...parseMetadataLine(line));
      continue;
    }

    const head = lower(t0);
    const lastTok = toks[toks.length - 1]!;
    const base = (kind: DfNode['kind']): DfNode => ({
      kind,
      range: line.range,
      headerRange: line.range,
      text: sliceOf(line)
    });

    // --- inside a `#COMMAND` body ----------------------------------------
    // Macro bodies are template text, not code: they carry `!n` substitution markers and their
    // block keywords are frequently unbalanced on purpose (the runtime library closes a
    // `Function !1_Handle` with `End_Procedure`). Tracking block structure through them would
    // corrupt the surrounding tree, so nothing here opens or closes a block, and none of it
    // counts toward the logical-line total.
    if (top().kind === 'command') {
      if (head === '#endcommand') {
        closeBlock('command', line);
        continue;
      }
      const node = addChild(base('macroBody'));
      node.verb = head;
      takeDoc(line);
      continue;
    }

    logicalLineCount++;

    // --- preprocessor directives -----------------------------------------
    if (t0.kind === TokenKind.Directive) {
      if (head === '#include') {
        const node = addChild(base('include'));
        node.name = stripQuotes(toks.slice(1).map((t) => t.text).join(''));
        node.nameRange = toks[1]?.range;
        node.doc = takeDoc(line);
        uses.push(node);
      } else if (head === '#command') {
        const node = openBlock(base('command'));
        node.name = toks[1]?.text;
        node.nameRange = toks[1]?.range;
        if (node.name !== undefined) {
          localCommands.add(node.name.toLowerCase());
        }
        node.doc = takeDoc(line);
        node.metadata = takeMetadata();
      } else if (head === '#endcommand') {
        closeBlock('command', line);
      } else if (head === '#replace' || head === '#define') {
        const node = addChild(base('define'));
        node.name = toks[1]?.text;
        node.nameRange = toks[1]?.range;
        node.value = toks.length > 2 ? text.slice(toks[2]!.start, lastTok.end) : undefined;
        node.doc = takeDoc(line);
      } else {
        const node = addChild(base('directive'));
        node.name = t0.text;
        node.verb = CONDITIONAL_DIRECTIVES.has(head) ? 'conditional' : undefined;
        takeDoc(line);
      }
      continue;
    }

    // --- case arms ---------------------------------------------------------
    // `Case (cond)` written without `Begin` is a flat sibling of the statements it guards and of
    // the next arm. Grouping each arm into its own node is what lets reachability be computed
    // per arm instead of special-cased: an arm ending in `Function_Return` no longer makes the
    // next arm's label look like dead code.
    const enclosing = top();
    const inCaseBlock =
      enclosing.kind === 'caseArm' ||
      (enclosing.kind === 'block' && enclosing.blockKind === 'case');
    const second = lower(toks[1]);

    if (head === 'case' && inCaseBlock && second !== 'begin') {
      if (second === 'end') {
        if (top().kind === 'caseArm') {
          closeBlock('caseArm', line, 'case end');
        }
        closeBlock('block', line, 'case end');
        continue;
      }

      if (second === 'break') {
        const node = addChild(makeStatement(toks, line.range));
        node.transfer = 'break';
        node.doc = takeDoc(line);
        if (top().kind === 'caseArm') {
          closeBlock('caseArm', line, 'case break');
        }
        continue;
      }

      // `Case (cond)` or `Case Else` opens a new arm, closing the previous one.
      if (top().kind === 'caseArm') {
        closeBlock('caseArm', line, 'next arm');
      }
      const arm = openBlock(base('caseArm'));
      arm.blockKind = 'case';
      arm.verb = 'case';
      arm.condition = second === 'else' ? undefined : textOf(toks.slice(1));
      // Which form was used is recorded by `closedBy` when the arm closes -- `end` for the
      // `Case (cond) Begin ... End` form, `next arm` / `case break` / `case end` for the bare
      // one. Deliberately *not* `inline`, which means something else everywhere it appears: that
      // a block's body shares its header's line, and so cannot host a line of its own.
      arm.doc = takeDoc(line);
      continue;
    }

    // --- block closers ----------------------------------------------------
    if (head === 'end_object') {
      closeBlock('object', line);
      continue;
    }
    if (head === 'end_class' || head === 'end_composite') {
      closeBlock('class', line);
      continue;
    }
    // `End_Procedure` and `End_Function` are interchangeable: the DataFlex compiler accepts
    // either as a method terminator, and the runtime library relies on it (`cSQLExecutor.pkg`
    // closes `Procedure SQLPrepare` with `End_Function`, `Dfastbar.pkg` closes
    // `Function Status_Help_Value` with `End_Procedure`).
    if (head === 'end_procedure' || head === 'end_function') {
      closeBlock(['procedure', 'function'], line);
      continue;
    }
    if (head === 'end_struct' || head === 'end_type') {
      closeBlock('struct', line);
      continue;
    }
    if (head === 'end_enum_list' || head === 'end_enumeration_list') {
      closeBlock('enumList', line);
      continue;
    }
    if (head === 'end' && toks.length === 1) {
      closeBlock(['block', 'caseArm'], line, 'end');
      continue;
    }
    if (head === 'loop' || head === 'until') {
      closeBlock('block', line, head);
      continue;
    }
    if (head === 'end_for_all') {
      closeBlock('block', line, head);
      continue;
    }

    // --- block openers ----------------------------------------------------
    if (head === 'object') {
      const node = openBlock(base('object'));
      node.name = toks[1]?.text;
      node.nameRange = toks[1]?.range;
      Object.assign(node, parseIsA(toks.slice(2)));
      node.doc = takeDoc(line);
      node.metadata = takeMetadata();
      continue;
    }

    // `Composite <Name> is a <Class>` declares a class too: the documentation calls it an
    // instantiable template, "instantiated like a Class" with a body "written like an Object".
    // Treating it as a statement left everything inside it -- nested objects, and the event
    // overrides that are the point of a widget -- floating at file scope with no owning class,
    // so nothing could tell that `Procedure OnInitializeWidget` overrides anything.
    if (head === 'class' || head === 'composite') {
      const node = openBlock(base('class'));
      node.name = toks[1]?.text;
      node.nameRange = toks[1]?.range;
      Object.assign(node, parseIsA(toks.slice(2)));
      node.doc = takeDoc(line);
      node.metadata = takeMetadata();
      continue;
    }

    // `Procedure_Section <Name> as <Label>` is the report writer's spelling of a procedure; it is
    // closed by a plain `End_Procedure` like any other method.
    if (head === 'procedure_section') {
      const node = openBlock(base('procedure'));
      node.name = toks[1]?.text;
      node.nameRange = toks[1]?.range;
      node.params = [];
      node.doc = takeDoc(line);
      node.metadata = takeMetadata();
      continue;
    }

    if (head === 'procedure' || head === 'function') {
      const node = openBlock(base(head === 'procedure' ? 'procedure' : 'function'));
      let i = 1;
      // `Procedure Set <PropertyName> ...` declares a property setter, not a method named "Set".
      if (head === 'procedure' && eqi(toks[i]?.text ?? '', 'set')) {
        node.isSetter = true;
        i++;
      }
      const nameToken = toks[i];
      node.name = nameToken?.text;
      node.nameRange = nameToken?.range;
      i++;
      // Optional `for <Class>` graft clause.
      if (eqi(toks[i]?.text ?? '', 'for') && isIdent(toks[i + 1])) {
        node.forClass = toks[i + 1]!.text;
        i += 2;
      }
      const parsed = parseParams(toks.slice(i));
      node.params = parsed.params;
      node.type = parsed.returnType;
      node.doc = takeDoc(line);
      node.metadata = takeMetadata();
      continue;
    }

    // `Type X ... End_Type` is the legacy form of `Struct X ... End_Struct`; the runtime library
    // still uses it for Win32 API record layouts. Both produce a `struct` node.
    if (head === 'struct' || head === 'type') {
      const node = openBlock(base('struct'));
      node.name = toks[1]?.text;
      node.nameRange = toks[1]?.range;
      if (node.name !== undefined) {
        localStructTypes.add(node.name.toLowerCase());
      }
      node.doc = takeDoc(line);
      node.metadata = takeMetadata();
      continue;
    }

    if (head === 'enum_list' || head === 'enumeration_list') {
      const node = openBlock(base('enumList'));
      node.doc = takeDoc(line);
      node.metadata = takeMetadata();
      continue;
    }

    // A line whose last token is `Begin` opens a block closed by a bare `End`. This covers
    // `If (x) Begin`, `Else Begin`, `Case Begin`, `Case (x) Begin` and `While (x) Begin` alike.
    if (isIdent(lastTok) && eqi(lastTok.text, 'begin')) {
      const blockKind: BlockKind =
        head === 'if' || head === 'else' || head === 'case' || head === 'for' ||
        head === 'while' || head === 'repeat'
          ? (head as BlockKind)
          : 'begin';
      const node = openBlock(base('block'));
      node.blockKind = blockKind;
      node.verb = head;
      // Drop the trailing `Begin` before reading the condition, so an unparenthesised one
      // (`If iState Begin`) does not swallow the keyword.
      const conditionToks = toks.slice(0, -1);
      if (head === 'if' || head === 'while' || head === 'for' || head === 'repeat') {
        node.condition = splitCondition(conditionToks).condition;
      } else if (head === 'else' && eqi(toks[1]?.text ?? '', 'if')) {
        // `Else If (c) Begin` is a *conditional* else: when it does not match either, control
        // falls past the whole chain. Recording the condition is what tells the control-flow
        // graph that this arm is not the unconditional final one.
        node.condition = splitCondition(conditionToks.slice(1)).condition;
      }
      takeDoc(line);
      continue;
    }

    // `For_All <table> by <index> [as queue]` iterates a table, closed by `End_For_All`.
    if (head === 'for_all') {
      openBlock(base('block'));
      continue;
    }

    if (head === 'for' || head === 'while' || head === 'repeat') {
      const node = openBlock(base('block'));
      node.blockKind = head;
      node.verb = head;
      node.condition = splitCondition(toks).condition;
      takeDoc(line);
      continue;
    }

    // A conditional written on one line, normalised into the block shape above.
    if (head === 'if' || head === 'else') {
      const inline = makeInlineConditional(toks, line.range);
      if (inline !== undefined) {
        addChild(inline);
        takeDoc(line);
        continue;
      }
    }

    // --- context-sensitive declarations -----------------------------------
    const parent = top();

    // A struct member may be array-typed (`tHelpTopic[] aSubTopics`), which puts `[` where an
    // identifier would otherwise be. Without accepting that form the declaration falls through to
    // the local-variable branch below and is mislabelled a `variable` -- wrong in the outline, and
    // wrong for any analysis that treats a variable outside a method as an implicit global.
    const isArrayMember = toks[1]?.text === '[' && toks[2]?.text === ']';
    if (parent.kind === 'struct' && isIdent(t0) && (isIdent(toks[1]) || isArrayMember)) {
      const node = addChild(base('field'));
      if (head === 'field') {
        // Legacy form: `Field tPOINT.x As DWORD` -- the name is qualified by the struct.
        const qualified = toks[1]!.text;
        node.name = qualified.slice(qualified.lastIndexOf('.') + 1);
        node.nameRange = toks[1]!.range;
        const asIndex = toks.findIndex((t) => eqi(t.text, 'as'));
        node.type = asIndex > 0 ? toks[asIndex + 1]?.text : undefined;
      } else {
        // Modern form: `String sCaption`, or `String[] sValues`.
        const nameToken = isArrayMember ? toks[3] : toks[1];
        node.type = isArrayMember ? `${t0.text}[]` : t0.text;
        node.name = nameToken?.text;
        node.nameRange = nameToken?.range;
      }
      node.doc = takeDoc(line);
      node.metadata = takeMetadata();
      continue;
    }

    if (parent.kind === 'enumList' && head === 'define') {
      const node = addChild(base('enumValue'));
      node.name = toks[1]?.text;
      node.nameRange = toks[1]?.range;
      // A member's value is normally its position, but `Define lpTop for 4` restarts the count,
      // and whoever computes positions needs to see that.
      const forIndex = toks.findIndex((t) => eqi(t.text, 'for'));
      if (forIndex > 0 && forIndex + 1 < toks.length) {
        node.value = text.slice(toks[forIndex + 1]!.start, lastTok.end);
      }
      node.doc = takeDoc(line);
      continue;
    }

    // --- declarations -----------------------------------------------------
    if (head === 'property') {
      const node = addChild(base('property'));
      let i = 1;
      let type = toks[i]?.text ?? '';
      i++;
      if (toks[i]?.text === '[' && toks[i + 1]?.text === ']') {
        type += '[]';
        i += 2;
      }
      node.type = type;
      node.name = toks[i]?.text;
      node.nameRange = toks[i]?.range;
      i++;
      if (i < toks.length) {
        node.value = text.slice(toks[i]!.start, lastTok.end);
      }
      node.doc = takeDoc(line);
      node.metadata = takeMetadata();
      continue;
    }

    if (head === 'use') {
      const node = addChild(base('use'));
      node.name = stripQuotes(toks.slice(1).map((t) => t.text).join(''));
      node.nameRange = toks[1]?.range;
      node.doc = takeDoc(line);
      uses.push(node);
      continue;
    }

    if (head === 'define') {
      const node = addChild(base('define'));
      node.name = toks[1]?.text;
      node.nameRange = toks[1]?.range;
      const forIndex = toks.findIndex((t) => eqi(t.text, 'for'));
      if (forIndex > 0 && forIndex + 1 < toks.length) {
        node.value = text.slice(toks[forIndex + 1]!.start, lastTok.end);
      }
      node.doc = takeDoc(line);
      continue;
    }

    // `String sName sValue` / `Integer iCount` -- one node per declared name.
    //
    // `Global_Variable Handle ghoSql` is the same declaration one token further along, and is read
    // here rather than left as a statement so that globals are modelled like any other declaration:
    // the outline lists them, the index can carry them, and the hover has something to describe.
    // The type is not required to be a known one there -- `Global_Variable tMyStruct gRec` is
    // legal, and the struct may be declared in a file this one has not seen.
    const isGlobalDecl = head === 'global_variable';
    const typeAt = isGlobalDecl ? 1 : 0;
    const typeToken = toks[typeAt];
    const isArrayDecl = toks[typeAt + 1]?.text === '[' && toks[typeAt + 2]?.text === ']';
    if (
      isIdent(typeToken) &&
      (isGlobalDecl || knownType(typeToken.text)) &&
      (isIdent(toks[typeAt + 1]) || isArrayDecl)
    ) {
      let type = typeToken.text;
      let i = typeAt + 1;
      if (isArrayDecl) {
        type += '[]';
        i += 2;
      }
      const doc = takeDoc(line);
      const metadata = takeMetadata();
      for (; i < toks.length; i++) {
        const nameToken = toks[i]!;
        // A trailing length -- `Global_Variable String gsName 255` -- is a number, not a name.
        if (!isIdent(nameToken)) {
          continue;
        }
        const node = addChild(base('variable'));
        node.type = type;
        node.name = nameToken.text;
        node.nameRange = nameToken.range;
        node.doc = doc;
        node.metadata = metadata;
        if (isGlobalDecl) {
          node.isGlobal = true;
        }
      }
      continue;
    }

    // --- statements -------------------------------------------------------
    const node = addChild(makeStatement(toks, line.range));
    node.doc = takeDoc(line);
    node.metadata = takeMetadata();
  }

  // Close anything left open at end of file.
  const lastLine = lines[lines.length - 1];
  const eof: Range = lastLine?.range ?? EMPTY_RANGE;
  for (let i = stack.length - 1; i >= 1; i--) {
    const node = stack[i]!;
    node.range = { start: node.range.start, end: eof.end };
    diagnostics.push({
      message: `Unterminated ${node.kind}${node.name === undefined ? '' : ` '${node.name}'`}.`,
      range: node.headerRange,
      severity: 'warning'
    });
  }
  root.range = { start: { line: 0, character: 0 }, end: eof.end };

  return {
    uri: options.uri,
    root,
    tokens,
    diagnostics,
    uses,
    unknownCount,
    logicalLineCount
  };
}
