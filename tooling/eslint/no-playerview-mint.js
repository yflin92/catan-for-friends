// Type-aware rule: only packages/engine/src/view.ts may create a PlayerView (design §3.7, AC25; HARD-1). The syntactic
// selectors in eslint.config.js reject casts; this rule closes the cast-free bypasses:
//   1. an `any`-typed value flowing into a slot whose type holds a PlayerView (variable initialiser, parameter default,
//      class field, return, argument, assignment, property), e.g. `const v: PlayerView = JSON.parse(s)` or
//      `const box: { v: PlayerView } = JSON.parse(s)`;
//   2. a call to a generic helper whose declared return type places one of its own type parameters (bare, or inside a
//      union, array, tuple or Promise) where the call's return has a PlayerView, when no argument or receiver already
//      holds one, e.g. `brand<PlayerView>(data)` or `await brandAsync<PlayerView>(data)`. Other generic wrappers (such
//      as vitest's `expectTypeOf<PlayerView>()`) carry no value and are not followed;
//   3. a type predicate or assertion signature naming a PlayerView (`x is PlayerView`, `asserts x is PlayerView`).
// A PlayerView is recognised by its brand property (`[ViewBrand]`), so aliases and namespaces do not hide it.
import ts from 'typescript';

const BRAND_PREFIX = '__@ViewBrand';
// How far holdsView looks into type arguments and object properties.
const MAX_DEPTH = 4;

/** @param {ts.Type} type */
const isBranded = (type) => type.getProperties().some((p) => String(p.escapedName).startsWith(BRAND_PREFIX));

/** A PlayerView itself, or a union with a PlayerView member. @param {ts.Type} type */
function isPlayerView(type) {
  if (type.isUnion()) return type.types.some(isPlayerView);
  return isBranded(type);
}

/** @param {ts.Type} type */
const typeArguments = (type, checker) =>
  (ts.getObjectFlags(type) & ts.ObjectFlags.Reference) !== 0 ? checker.getTypeArguments(/** @type {ts.TypeReference} */ (type)) : [];

/**
 * Whether a PlayerView is reachable in `type`: itself, a union or intersection member, a type argument (arrays, tuples,
 * Promise, Map, …) or a data property's type. Methods are not followed.
 * @param {ts.Type} type @param {ts.TypeChecker} checker @param {ts.Node} at
 */
function holdsView(type, checker, at, depth = 0, seen = new Set()) {
  if (depth > MAX_DEPTH || seen.has(type)) return false;
  seen.add(type);
  if (type.flags & (ts.TypeFlags.Primitive | ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
  if (isBranded(type)) return true;
  const next = (t) => holdsView(t, checker, at, depth + 1, seen);
  if (type.isUnionOrIntersection()) return type.types.some(next);
  if (typeArguments(type, checker).some(next)) return true;
  if (type.getCallSignatures().length > 0) return false;
  return type.getProperties().some((p) => {
    if (p.flags & ts.SymbolFlags.Method) return false;
    return next(checker.getTypeOfSymbolAtLocation(p, at));
  });
}

const PROMISES = new Set(['Promise', 'PromiseLike']);

/** Arrays, tuples and promises: the generic containers a minted value can be returned in. */
const isContainer = (type, checker) =>
  checker.isArrayType(type) || checker.isTupleType(type) || PROMISES.has(type.getSymbol()?.getName() ?? '');

/**
 * Whether `declared` (a signature's declared return type) places one of `own` type parameters where `actual` (the
 * instantiated return type) has a PlayerView. Unions are matched member-wise against the whole of `actual`; arrays,
 * tuples and promises are matched argument by argument against an `actual` reference with the same target.
 * @param {ts.Type} declared @param {ts.Type} actual @param {Set<ts.Type>} own @param {ts.TypeChecker} checker
 */
function mintsView(declared, actual, own, checker, depth = 0) {
  if (depth > MAX_DEPTH) return false;
  if (declared.flags & ts.TypeFlags.TypeParameter) return own.has(declared) && isPlayerView(actual);
  if (declared.isUnionOrIntersection()) return declared.types.some((d) => mintsView(d, actual, own, checker, depth + 1));
  if (!isContainer(declared, checker)) return false;
  const declaredArgs = typeArguments(declared, checker);
  const target = /** @type {ts.TypeReference} */ (declared).target;
  const candidates = actual.isUnion() ? actual.types : [actual];
  return candidates.some((a) => {
    if (/** @type {ts.TypeReference} */ (a).target !== target) return false;
    const actualArgs = typeArguments(a, checker);
    return declaredArgs.some((d, i) => actualArgs[i] !== undefined && mintsView(d, actualArgs[i], own, checker, depth + 1));
  });
}

const isAny = (type) => (type.flags & ts.TypeFlags.Any) !== 0;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Only view(state, seat) in packages/engine/src/view.ts may create a PlayerView.' },
    messages: {
      anyIntoView: 'An any-typed value flows into a PlayerView; build views with view(state, seat) (design §3.7).',
      genericMint: 'A generic helper is instantiated as PlayerView; only view(state, seat) may create one (design §3.7).',
      viewPredicate: 'A type predicate or assertion narrows to PlayerView; only view(state, seat) may create one (design §3.7).',
    },
    schema: [],
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program || !services.esTreeNodeToTSNodeMap) {
      throw new Error('hexlands/no-playerview-mint needs type information (parserOptions.projectService)');
    }
    const checker = services.program.getTypeChecker();
    const tsNode = (node) => services.esTreeNodeToTSNodeMap.get(node);

    /** Reports `node` when it is any-typed and its contextual type holds a PlayerView. */
    function checkAnyInto(node) {
      if (!node) return;
      const tn = tsNode(node);
      if (!tn || !isAny(checker.getTypeAtLocation(tn))) return;
      const contextual = checker.getContextualType(/** @type {ts.Expression} */ (tn));
      if (contextual && holdsView(contextual, checker, tn)) context.report({ node, messageId: 'anyIntoView' });
    }

    function checkCall(node) {
      for (const arg of node.arguments) checkAnyInto(arg);
      const tn = tsNode(node);
      const signature = tn && checker.getResolvedSignature(tn);
      const declaration = signature?.getDeclaration();
      if (!signature || !declaration?.type || !declaration.typeParameters?.length) return;
      const own = new Set(declaration.typeParameters.map((p) => checker.getTypeAtLocation(p)));
      const declared = checker.getTypeAtLocation(declaration.type);
      if (!mintsView(declared, checker.getReturnTypeOfSignature(signature), own, checker)) return;
      const sources = [...node.arguments];
      if (node.callee.type === 'MemberExpression') sources.push(node.callee.object);
      const viewIn = sources.some((n) => holdsView(checker.getTypeAtLocation(tsNode(n)), checker, tsNode(n)));
      if (!viewIn) context.report({ node, messageId: 'genericMint' });
    }

    return {
      VariableDeclarator: (node) => checkAnyInto(node.init),
      AssignmentPattern: (node) => checkAnyInto(node.right),
      PropertyDefinition: (node) => checkAnyInto(node.value),
      ReturnStatement: (node) => checkAnyInto(node.argument),
      'ArrowFunctionExpression[expression=true]': (node) => checkAnyInto(node.body),
      AssignmentExpression: (node) => checkAnyInto(node.right),
      Property: (node) => checkAnyInto(node.value),
      CallExpression: checkCall,
      NewExpression: (node) => {
        for (const arg of node.arguments) checkAnyInto(arg);
      },
      TSTypePredicate: (node) => {
        const annotation = node.typeAnnotation?.typeAnnotation;
        if (annotation && holdsView(checker.getTypeAtLocation(tsNode(annotation)), checker, tsNode(annotation))) {
          context.report({ node, messageId: 'viewPredicate' });
        }
      },
    };
  },
};
