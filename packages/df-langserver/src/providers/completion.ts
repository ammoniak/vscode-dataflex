import {
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  MarkupKind,
  Position
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DfNode, SourceUnit, nodeChainAt, walk } from '@vscode-dataflex/parser';
import type { ResolvedMember, SymbolIndex } from '@vscode-dataflex/workspace';
import { Verb, classifyRequest } from '../completionContext';

/**
 * How close a candidate is to the cursor. Encoded into `sortText`, so the ordering survives the
 * client's own filtering.
 */
const enum Tier {
  TargetObject = 0,
  ParentObject = 1,
  Sibling = 2,
  CurrentView = 3,
  Workspace = 4
}

const TIER_LABEL: Record<Tier, string> = {
  [Tier.TargetObject]: 'this object',
  [Tier.ParentObject]: 'parent object',
  [Tier.Sibling]: 'sibling object',
  [Tier.CurrentView]: 'this view',
  [Tier.Workspace]: 'elsewhere in the workspace'
};

function enclosingObjects(root: DfNode, position: Position): DfNode[] {
  return nodeChainAt(root, position.line, position.character).filter((n) => n.kind === 'object');
}

function objectChildren(node: DfNode): DfNode[] {
  return (node.children ?? []).filter((child) => child.kind === 'object');
}

function allObjects(root: DfNode): DfNode[] {
  const found: DfNode[] = [];
  walk(root, (node) => {
    if (node.kind === 'object') {
      found.push(node);
    }
  });
  return found;
}

/**
 * Scope-ranked completion for DataFlex property and message statements.
 *
 * Typing `WebSet ps` without this offers every string web property in the application, because
 * nothing models the object tree. DataFlex views nest their objects lexically, so the object
 * under the cursor -- and therefore its class, and therefore its properties -- is knowable
 * exactly.
 *
 * Candidates are *ranked, never hidden* (the one exception being `WebSet`/`WebGet`, where an
 * unpublished property is a runtime error rather than a worse match). An exact class-chain match
 * sorts first, but everything else stays reachable, so a mixin the indexer missed still cannot
 * make a property unreachable.
 */
export function completion(
  unit: SourceUnit,
  document: TextDocument,
  position: Position,
  index: SymbolIndex | undefined
): CompletionList | undefined {
  if (index === undefined) {
    return undefined;
  }

  const linePrefix = document.getText({
    start: { line: position.line, character: 0 },
    end: position
  });
  const request = classifyRequest(linePrefix);
  if (request === undefined) {
    return undefined;
  }

  const root = unit.root;
  switch (request.what) {
    case 'member':
      return completeMembers(root, position, index, request.verb, request.prefix, false);
    case 'method':
      return completeMembers(root, position, index, 'get', request.prefix, true);
    case 'object':
      return completeObjects(root, position, request.prefix);
    case 'class':
      return completeClasses(index, request.prefix);
  }
}

function completeMembers(
  root: DfNode,
  position: Position,
  index: SymbolIndex,
  verb: Verb,
  prefix: string,
  methodsOnly: boolean
): CompletionList {
  const chain = enclosingObjects(root, position);
  const target = chain[chain.length - 1];
  const parent = chain[chain.length - 2];

  const siblings = parent === undefined ? [] : objectChildren(parent).filter((o) => o !== target);
  const seen = new Set([target, parent, ...siblings].filter(Boolean) as DfNode[]);
  const rest = allObjects(root).filter((o) => !seen.has(o));

  const webOnly = verb === 'webset' || verb === 'webget';
  const setting = verb === 'set' || verb === 'webset';

  /**
   * Which members this verb can actually address.
   *
   * `Set` needs a setter, and only a `Property` or a `Procedure Set <Name>` provides one: the
   * documentation is explicit that a bare `Function psX Returns String` supports `Get psX` and not
   * `Set psX to ...`. Offering getters after `Set` filled the list with things that cannot be set
   * -- 71 of the 179 suggestions on `cWebForm`, including `GetColumnObject` and `LoadData`, which
   * are plainly functions.
   *
   * The reverse holds for `Get`: a name that exists only as `Procedure Set` has no getter.
   */
  const accept = (member: ResolvedMember): boolean => {
    if (methodsOnly) {
      return member.kind === 'method';
    }
    if (member.kind === 'method') {
      return false;
    }
    if (setting && member.kind === 'getter') {
      return false;
    }
    if (!setting && member.kind === 'setter') {
      return false;
    }
    return !webOnly || member.webProperty !== undefined;
  };

  const best = new Map<string, { member: ResolvedMember; tier: Tier; via?: string }>();
  const consider = (member: ResolvedMember, tier: Tier, via?: string): void => {
    if (!accept(member)) {
      return;
    }
    const key = member.name.toLowerCase();
    const existing = best.get(key);
    if (existing === undefined || tier < existing.tier) {
      best.set(key, { member, tier, via });
    }
  };

  const addObject = (object: DfNode | undefined, tier: Tier): void => {
    if (object?.superClass === undefined) {
      return;
    }
    for (const member of index.membersOf(object.superClass)) {
      consider(member, tier, object.name);
    }
  };

  addObject(target, Tier.TargetObject);
  addObject(parent, Tier.ParentObject);
  for (const sibling of siblings) {
    addObject(sibling, Tier.Sibling);
  }
  for (const other of rest) {
    addObject(other, Tier.CurrentView);
  }

  // The catch-all tier only helps once the user has typed enough to narrow it; sent unfiltered it
  // would bury the scoped results under thousands of names.
  if (prefix.length >= 2) {
    const needle = prefix.toLowerCase();
    for (const member of index.allMembers()) {
      if (member.name.toLowerCase().startsWith(needle)) {
        consider(member, Tier.Workspace);
      }
    }
  }

  const items = [...best.values()].map(({ member, tier, via }) =>
    toCompletionItem(member, tier, via, target?.superClass)
  );

  // `isIncomplete` because the workspace tier is filtered by the typed prefix: the client must
  // ask again as the user types rather than filtering a stale list.
  return { isIncomplete: true, items };
}

function completeObjects(root: DfNode, position: Position, prefix: string): CompletionList {
  const chain = enclosingObjects(root, position);
  const target = chain[chain.length - 1];
  const parent = chain[chain.length - 2];

  const ranked = new Map<string, { node: DfNode; tier: Tier }>();
  const add = (node: DfNode, tier: Tier): void => {
    if (node.name === undefined) {
      return;
    }
    const key = node.name.toLowerCase();
    const existing = ranked.get(key);
    if (existing === undefined || tier < existing.tier) {
      ranked.set(key, { node, tier });
    }
  };

  for (const child of target === undefined ? [] : objectChildren(target)) {
    add(child, Tier.TargetObject);
  }
  for (const sibling of parent === undefined ? [] : objectChildren(parent)) {
    add(sibling, Tier.Sibling);
  }
  for (const object of allObjects(root)) {
    add(object, Tier.CurrentView);
  }

  const items: CompletionItem[] = [...ranked.values()].map(({ node, tier }) => ({
    label: node.name!,
    kind: CompletionItemKind.Variable,
    detail: node.superClass === undefined ? TIER_LABEL[tier] : `is a ${node.superClass}`,
    sortText: `${tier}_${node.name!.toLowerCase()}`
  }));

  items.push({
    label: 'Self',
    kind: CompletionItemKind.Keyword,
    sortText: `${Tier.TargetObject}_`
  });

  return { isIncomplete: prefix.length > 0, items };
}

function completeClasses(index: SymbolIndex, prefix: string): CompletionList {
  const items: CompletionItem[] = [];
  for (const declaration of index.search(prefix.toLowerCase(), 2000)) {
    if (declaration.kind !== 'class') {
      continue;
    }
    items.push({
      label: declaration.name,
      kind: CompletionItemKind.Class,
      detail: declaration.superClass === undefined ? undefined : `is a ${declaration.superClass}`,
      documentation: declaration.doc
    });
  }
  return { isIncomplete: true, items };
}

function toCompletionItem(
  member: ResolvedMember,
  tier: Tier,
  via: string | undefined,
  targetClass: string | undefined
): CompletionItem {
  const parts = [member.declaringClass];
  if (member.type !== undefined && member.type.length > 0) {
    parts.push(member.type);
  }
  if (member.webProperty !== undefined) {
    parts.push(member.webProperty);
  }
  if (member.category !== undefined) {
    parts.push(member.category);
  }
  if (tier === Tier.Workspace) {
    parts.push(targetClass === undefined ? 'not in scope' : `not on ${targetClass}`);
  } else if (tier !== Tier.TargetObject && via !== undefined) {
    parts.push(via);
  }

  const signature = [
    member.kind === 'property' ? 'Property' : member.kind === 'setter' ? 'Procedure Set' : 'Function',
    member.type ?? '',
    member.name,
    member.defaultValue ?? ''
  ]
    .filter((part) => part !== '')
    .join(' ');

  const documentation = [
    member.doc ?? '',
    '```dataflex',
    signature,
    '```',
    `Declared on \`${member.declaringClass}\` - ${TIER_LABEL[tier]}.`
  ]
    .filter((line) => line !== '')
    .join('\n');

  return {
    label: member.name,
    kind: member.kind === 'method' ? CompletionItemKind.Method : CompletionItemKind.Property,
    detail: parts.join(' - '),
    documentation: { kind: MarkupKind.Markdown, value: documentation },
    // Tier first so scope beats alphabetical order, then the name so each tier is sorted.
    sortText: `${tier}_${member.name.toLowerCase()}`,
    // Keep the client filtering on the bare name, so typing narrows across every tier.
    filterText: member.name
  };
}
