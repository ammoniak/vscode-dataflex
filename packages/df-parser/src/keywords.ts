/**
 * Keyword tables. Every lookup is case-insensitive; the sets below are stored lower-cased and
 * must only be probed with `.toLowerCase()`-ed input.
 */

/** Built-in scalar and reference types usable in a local variable or parameter declaration. */
export const BUILTIN_TYPES: ReadonlySet<string> = new Set([
  'string',
  'integer',
  'number',
  'real',
  'date',
  'datetime',
  'timespan',
  'boolean',
  'handle',
  'rowid',
  'uchar',
  'char',
  'short',
  'ushort',
  'bigint',
  'ubigint',
  'uinteger',
  'variant',
  'address',
  'pointer',
  'float',
  'double',
  'decimal',
  // Win32 / COM interop types used throughout the runtime library's API wrappers.
  'dword',
  'word',
  'byte',
  'wide',
  'uwide',
  'wstring',
  'longptr',
  'ole_handle',
  'ole_color'
]);

/**
 * Statement verbs, grouped by what they do.
 *
 * The grouping is data rather than a comment because two consumers need it: the parser only cares
 * that a word is a verb, but the TextMate grammar colours a database verb differently from a
 * control-flow one. `scripts/sync-grammar.ts` reads these categories and writes the grammar's
 * keyword alternations from them, which is what stops the two drifting -- `Save`, `Delete`,
 * `Clear` and `Find` were verbs here for a long time while the grammar left them unhighlighted.
 */

/** Property and message access -- the completion-relevant ones. */
export const MESSAGE_VERBS: readonly string[] = [
  'set',
  'get',
  'webset',
  'webget',
  'send',
  'move',
  'delegate',
  'broadcast',
  'forward',
  'object_set',
  'set_value',
  'indicate',
  'calc'
];

/** Control flow that does not open a block. */
export const CONTROL_VERBS: readonly string[] = [
  'if',
  'else',
  'case',
  'break',
  'procedure_return',
  'function_return',
  'goto',
  'error',
  'abort'
];

/** Record and data dictionary verbs. */
export const DATABASE_VERBS: readonly string[] = [
  'clear',
  'find',
  'save',
  'delete',
  'attach',
  'open',
  'close',
  'reread',
  'unlock',
  'lock',
  'begin_transaction',
  'end_transaction',
  'clearform',
  'entry_item',
  'field_map',
  'set_field_value',
  'get_field_value',
  'constrain',
  'relate',
  'request_save',
  'request_delete',
  'request_clear',
  // Classic record verbs. Grouped here rather than with the file built-ins because they act on a
  // record buffer, which is what decides their colour.
  'saverecord',
  'vfind'
];

/** Everything else: declarations, I/O, pragmas, and framework built-ins. */
export const OTHER_VERBS: readonly string[] = [
  // declarations that are not blocks
  'import_class_protocol',
  'register_object',
  'register_procedure',
  'register_function',
  'external_function',
  'external_procedure',
  'global_variable',
  'string_declaration',
  'showln',
  'show',
  'direct_input',
  'direct_output',
  'writeln',
  'write',
  'readln',
  'read',
  'append',
  'sysdate',
  'runprogram',
  'movestr',
  'moveint',
  // attribute and buffer access
  'get_attribute',
  'set_attribute',
  'put',
  'put_string',
  'getbuff',
  'setbuff',
  'getaddress',
  'call_driver',
  'zerotype',
  // event bindings and counters
  'on_key',
  'on_item',
  'increment',
  'decrement',
  // compiler and linkage pragmas that are statements rather than directives
  'compilerwarnings',
  'external_function32',
  'external_procedure32',
  'is_file_included',
  'warningex',
  'set_argument_size',
  'set_dynamic_argument_size',
  // Web framework statements. These are compiler built-ins, not macros: they are used all over
  // the Web UI package but declared by no `#COMMAND` anywhere in the runtime, the examples or
  // application libraries.
  'webpublishprocedure',
  'webpublishfunction',
  'webregisterpath',
  'valuetreeserializeparameter',
  'valuetreedeserializeparameter',
  'cvtlocalization',
  // Classic file / record built-ins.
  'add',
  'file_exist',
  'erasefile',
  'read_block',
  'close_input',
  'close_output',
  'void_type',
  'seq_new_channel',
  'seq_release_channel',
  'get_environment',
  'set_environment',
  'callstackdump',
  // Report writer / code-generator statements.
  'cd_end_object',
  'deferred_view',
  'activate_view',
  'report_index',
  'output_pagecheck',
  'print',
  'page_break'
];

/** The categories above, for consumers that colour verbs rather than just recognise them. */
export const VERB_CATEGORIES: ReadonlyMap<string, readonly string[]> = new Map([
  ['message', MESSAGE_VERBS],
  ['control', CONTROL_VERBS],
  ['database', DATABASE_VERBS],
  ['other', OTHER_VERBS]
]);

/**
 * Statement verbs the parser understands well enough to extract a target from.
 *
 * A line led by one of these becomes a `statement` node; anything else identifier-led becomes
 * `unknown`, which is what the corpus checker measures. Keeping this list honest is what makes
 * the "unknown rate" a meaningful quality signal rather than a vanity metric.
 */
export const STATEMENT_VERBS: ReadonlySet<string> = new Set([
  ...MESSAGE_VERBS,
  ...CONTROL_VERBS,
  ...DATABASE_VERBS,
  ...OTHER_VERBS
]);

/**
 * Words that open or close a block.
 *
 * Deliberately not in `STATEMENT_VERBS`: the parser recognises them positionally, by opening and
 * closing nodes, rather than as verbs leading a statement. They still need a scope in the grammar
 * and an answer in the hover, so they are a table rather than literals in two places.
 */
export const BLOCK_WORDS: readonly string[] = [
  'begin',
  'end',
  // `For_All <table> by <index>` iterates a table; it is closed by `End_For_All`.
  'for_all',
  'end_for_all',
  'for',
  'loop',
  'while',
  'repeat',
  'until',
  'gosub',
  'return'
];

/**
 * Keywords that introduce a declaration.
 *
 * Same reason as `BLOCK_WORDS`: the parser matches these positionally while opening a node, so
 * they are in no verb table, yet a reader hovering `Object` deserves the same answer as one
 * hovering `Move`.
 */
export const DECLARATION_WORDS: readonly string[] = [
  'object',
  'class',
  // `Composite <Name> is a <Class>` declares a class whose body is written like an object -- an
  // instantiable template. It opens a block, so it is not a statement verb.
  'composite',
  'end_composite',
  'procedure',
  'function',
  'property',
  'struct',
  'field',
  'define',
  'returns',
  'enum_list',
  'end_object',
  'end_class',
  'end_procedure',
  'end_function',
  'end_struct',
  'end_enum_list'
];

/**
 * Language constants.
 *
 * `Self` is the one that matters most: it appears in almost every method and is documented, but as
 * a guide page rather than a language-reference entry.
 */
export const CONSTANT_WORDS: readonly string[] = [
  'self',
  'true',
  'false',
  'desktop',
  'null',
  'nothing',
  'current_object',
  'this_object'
];

/**
 * Words that are part of a statement's syntax rather than leading it.
 *
 * `File_Field` introduces a table/field pair -- `Get File_Field_Current_Value of oDD File_Field
 * Customer.Name to sX` -- and is a documented keyword in its own right. The connectives are listed
 * so the hover recognises them as language rather than as an unknown name; most have no page, and
 * then the hover correctly says nothing.
 */
export const SYNTAX_WORDS: readonly string[] = [
  'file_field',
  'field',
  'to',
  'of',
  'from',
  'in',
  'as',
  'is'
];

/** Block-closing keywords mapped to the node kind they are expected to close. */
export const BLOCK_CLOSERS: ReadonlyMap<string, string> = new Map([
  ['end_object', 'object'],
  ['end_class', 'class'],
  ['end_procedure', 'procedure'],
  ['end_function', 'function'],
  ['end_struct', 'struct'],
  ['end_enum_list', 'enumList'],
  ['end', 'block'],
  ['loop', 'block'],
  ['until', 'block']
]);

/** Preprocessor directives that are conditional-compilation markers rather than declarations. */
export const CONDITIONAL_DIRECTIVES: ReadonlySet<string> = new Set([
  '#if',
  '#ifdef',
  '#ifndef',
  '#ifsame',
  '#ifnsame',
  '#else',
  '#elseif',
  '#endif'
]);
