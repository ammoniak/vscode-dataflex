import type { SymbolIndex } from '@vscode-dataflex/workspace';

/**
 * Where a method lives, for the purpose of deciding whether it overrides something.
 *
 * A method inside `Class cX is a cY` resolves against `cX`'s ancestors; one inside
 * `Object oX is a cWebForm` resolves against `cWebForm` and everything it inherits.
 */
export interface MethodOwner {
  /** The class whose ancestry decides the question, or `undefined` at file scope. */
  ownerClass?: string;
  /** True when the owner is an object instance rather than a class declaration. */
  ownerIsObject?: boolean;
}

/**
 * True when an ancestor of the owning class declares a member of the same name.
 *
 * This is the signal that separates a framework hook from ordinary code, and it is deliberately
 * *not* a naming convention. DataFlex events are conventionally `OnSomething`, but a base class
 * can declare any name it likes and the framework will call it -- so `Refresh_Data` is exactly as
 * much of a hook as `OnClick`, and a name rule would miss it. Asking the resolved class chain
 * answers the real question.
 *
 * Two rules depend on it:
 *  - `dead-procedure`, which must not report a hook nothing in the workspace calls by name;
 *  - `unused-parameter`, because overriding an event means accepting its parameters whether or
 *    not the override uses them.
 */
export function overridesAncestor(
  index: SymbolIndex,
  methodName: string,
  owner: MethodOwner
): boolean {
  return findOverridden(index, methodName, owner) !== undefined;
}

/** The ancestor member an override shadows. */
export interface OverriddenMember {
  /** Class that declares the member being overridden. */
  declaringClass: string;
  /** Name as that class spells it, which may differ in case. */
  name: string;
  file: string;
}

/**
 * Finds *which* ancestor declares the member of this name, not merely whether one does.
 *
 * Same walk as `overridesAncestor`, which delegates here -- the two must never disagree, since one
 * decides whether a diagnostic is reported and the other explains that decision in the hover.
 */
export function findOverridden(
  index: SymbolIndex,
  methodName: string,
  owner: MethodOwner
): OverriddenMember | undefined {
  const ownerClass = owner.ownerClass;
  if (ownerClass === undefined) {
    return undefined;
  }

  const key = methodName.toLowerCase();

  // For an object, every member of its class chain is inherited, so any match is an override.
  if (owner.ownerIsObject === true) {
    const found = index.membersOf(ownerClass).find((member) => member.name.toLowerCase() === key);
    return found === undefined
      ? undefined
      : { declaringClass: found.declaringClass, name: found.name, file: found.file };
  }

  // For a class, skip the class itself: its own members include the declaration being tested.
  for (const ancestor of index.resolveChain(ownerClass).slice(1)) {
    const own = ancestor.members.find((member) => member.name.toLowerCase() === key);
    if (own !== undefined) {
      return { declaringClass: ancestor.name, name: own.name, file: own.file };
    }
    // A mixin the ancestor imports counts too.
    for (const mixinName of ancestor.mixins) {
      const mixin = index.getClass(mixinName);
      const fromMixin = mixin?.members.find((member) => member.name.toLowerCase() === key);
      if (mixin !== undefined && fromMixin !== undefined) {
        return { declaringClass: mixin.name, name: fromMixin.name, file: fromMixin.file };
      }
    }
  }

  return undefined;
}
