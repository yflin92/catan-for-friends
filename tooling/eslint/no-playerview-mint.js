// Type-aware rule: only packages/engine/src/view.ts may create a PlayerView (design §3.7, AC25; HARD-1). The syntactic
// selectors in eslint.config.js reject casts; this rule closes the cast-free bypasses:
//   1. an `any`-typed value flowing into a PlayerView slot (variable initialiser, return, argument, assignment,
//      property), e.g. `const v: PlayerView = JSON.parse(s)`;
//   2. a call to a generic helper whose declared return type is a bare type parameter, instantiated as PlayerView,
//      when no argument already is a PlayerView, e.g. `brand<PlayerView>(data)`.
// A PlayerView is recognised by its brand property (`[ViewBrand]`), so aliases and namespaces do not hide it.
import ts from 'typescript';

const BRAND_PREFIX = '__@ViewBrand';

/** @param {ts.Type} type @param {ts.TypeChecker} checker */
function isPlayerView(type, checker) {
  if (type.isUnion()) return type.types.some((t) => isPlayerView(t, checker));
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return checker.getTypeArguments(/** @type {ts.TypeReference} */ (type)).some((t) => isPlayerView(t, checker));
  }
  return type.getProperties().some((p) => String(p.escapedName).startsWith(BRAND_PREFIX));
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

    /** Reports `node` when it is any-typed and its contextual type is a PlayerView. */
    function checkAnyInto(node) {
      if (!node) return;
      const tn = tsNode(node);
      if (!tn || !isAny(checker.getTypeAtLocation(tn))) return;
      const contextual = checker.getContextualType(/** @type {ts.Expression} */ (tn));
      if (contextual && isPlayerView(contextual, checker)) context.report({ node, messageId: 'anyIntoView' });
    }

    function checkCall(node) {
      for (const arg of node.arguments) checkAnyInto(arg);
      const tn = tsNode(node);
      const signature = tn && checker.getResolvedSignature(tn);
      const declaration = signature?.getDeclaration();
      if (!signature || !declaration?.type) return;
      const declared = checker.getTypeAtLocation(declaration.type);
      if ((declared.flags & ts.TypeFlags.TypeParameter) === 0) return;
      if (!isPlayerView(checker.getReturnTypeOfSignature(signature), checker)) return;
      const viewIn = node.arguments.some((arg) => isPlayerView(checker.getTypeAtLocation(tsNode(arg)), checker));
      if (!viewIn) context.report({ node, messageId: 'genericMint' });
    }

    return {
      VariableDeclarator: (node) => checkAnyInto(node.init),
      ReturnStatement: (node) => checkAnyInto(node.argument),
      'ArrowFunctionExpression[expression=true]': (node) => checkAnyInto(node.body),
      AssignmentExpression: (node) => checkAnyInto(node.right),
      Property: (node) => checkAnyInto(node.value),
      CallExpression: checkCall,
      NewExpression: (node) => {
        for (const arg of node.arguments) checkAnyInto(arg);
      },
    };
  },
};
