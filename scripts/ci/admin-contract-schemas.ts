import ts from 'typescript';
import { z } from 'zod';

type Bindings = Map<ts.Symbol, ts.Expression>;
type Location = 'body' | 'path' | 'query';
export interface RequestSchemaLimitation {
  kind: 'normalization' | 'refinement';
  path: string;
  operation: string;
  source: string;
}
export interface GeneratedRequestSchema {
  name: string;
  location: Location;
  schema: Record<string, unknown>;
  approximation: boolean;
  limitations: RequestSchemaLimitation[];
  source: string;
}
export interface RequestSchemasResult {
  body: 'none' | 'json-schema' | 'hand-parsed-json' | 'multipart';
  schemas: GeneratedRequestSchema[];
}

const ZOD = Symbol('source import from zod');
const FACTORIES = new Set(['object', 'strictObject', 'looseObject', 'string', 'number', 'boolean', 'uuid', 'email', 'url', 'literal', 'enum', 'array', 'union', 'discriminatedUnion', 'record', 'tuple', 'null', 'unknown', 'any', 'never']);
const METHODS = new Set(['min', 'max', 'length', 'int', 'positive', 'nonnegative', 'negative', 'nonpositive', 'finite', 'multipleOf', 'regex', 'email', 'url', 'uuid', 'optional', 'nullable', 'nullish', 'array', 'default', 'partial', 'required', 'strict', 'strip', 'passthrough', 'extend', 'pick', 'omit', 'or', 'and', 'describe']);
const NORMALIZATIONS = new Set(['trim', 'toLowerCase', 'toUpperCase', 'normalize', 'overwrite', 'transform']);

function at(node: ts.Node): string {
  const source = node.getSourceFile();
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart());
  // Stable relative source provenance also works for standalone fixture programs.
  return `${source.fileName.replace(`${process.cwd()}/`, '')}:${line + 1}:${character + 1}`;
}

function refuse(node: ts.Node, detail: string): never {
  throw new Error(`Unsupported request schema at ${at(node)}: ${detail}`);
}

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

function symbolAt(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function importedZod(node: ts.Expression, checker: ts.TypeChecker): boolean {
  const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
  if (!declaration || (!ts.isImportSpecifier(declaration) && !ts.isNamespaceImport(declaration))) return false;
  let parent: ts.Node = declaration;
  while (!ts.isImportDeclaration(parent) && parent.parent) parent = parent.parent;
  return ts.isImportDeclaration(parent) && ts.isStringLiteral(parent.moduleSpecifier) && parent.moduleSpecifier.text === 'zod'
    && (ts.isNamespaceImport(declaration) || (declaration.propertyName ?? declaration.name).text === 'z');
}

/** Interpret only whitelisted constructors/methods on locally created Zod objects.
 * Source modules, callback bodies and schema factory functions are never executed.
 */
function evaluateSchema(checker: ts.TypeChecker, expression: ts.Expression, bindings: Bindings) {
  const limitations: RequestSchemaLimitation[] = [];
  const active = new Set<ts.Node>();
  const callbackSource = (node: ts.Expression, depth = 0): string => {
    if (depth > 32) return refuse(node, 'callback dependency limit');
    const value = unwrap(node);
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value.getText();
    if (ts.isIdentifier(value)) {
      const declaration = symbolAt(checker, value)?.valueDeclaration;
      if (declaration && ts.isFunctionDeclaration(declaration) && declaration.body) return declaration.getText();
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && declaration.parent.flags & ts.NodeFlags.Const) return callbackSource(declaration.initializer, depth + 1);
    }
    return refuse(value, 'callback must be a source function, not a dynamic expression');
  };
  const evaluate = (input: ts.Expression, path: string): unknown => {
    const node = unwrap(input);
    if (active.size > 128) return refuse(node, 'schema dependency depth limit');
    if (active.has(node)) return refuse(node, 'cyclic dependency');
    active.add(node);
    try {
      if (ts.isStringLiteralLike(node)) return node.text;
      if (ts.isNumericLiteral(node)) return Number(node.text);
      if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
      if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
      if (node.kind === ts.SyntaxKind.NullKeyword) return null;
      if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
        const operand = evaluate(node.operand, path);
        if (typeof operand === 'number') return -operand;
      }
      if (ts.isRegularExpressionLiteral(node)) {
        const text = node.text;
        const end = text.lastIndexOf('/');
        return new RegExp(text.slice(1, end), text.slice(end + 1));
      }
      if (ts.isIdentifier(node)) {
        if (importedZod(node, checker)) return ZOD;
        const symbol = symbolAt(checker, node);
        const bound = symbol && bindings.get(symbol);
        const declaration = symbol?.valueDeclaration;
        if (declaration && ts.isParameter(declaration) && bound && bound !== node) return evaluate(bound, path);
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
          if (!(declaration.parent.flags & ts.NodeFlags.Const)) return refuse(node, 'mutable schema dependency');
          return evaluate(declaration.initializer, path);
        }
        return refuse(node, `unresolved dependency ${node.text}`);
      }
      if (ts.isArrayLiteralExpression(node)) return node.elements.map((item) => {
        if (ts.isSpreadElement(item)) return refuse(item, 'array spread');
        return evaluate(item, `${path}[]`);
      });
      if (ts.isObjectLiteralExpression(node)) {
        const result: Record<string, unknown> = Object.create(null);
        for (const property of node.properties) {
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return refuse(property, 'object getters, methods and spreads are not allowed');
          if (ts.isComputedPropertyName(property.name)) return refuse(property, 'computed property');
          const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name) ? property.name.text : refuse(property, 'property name');
          const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
          result[name] = evaluate(value, `${path}.${name}`);
        }
        return result;
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const operation = node.expression.name.text;
        const receiver = evaluate(node.expression.expression, path);
        if (receiver !== ZOD && !(receiver instanceof z.ZodType)) return refuse(node, 'call receiver is not a source-built Zod schema');
        if (receiver instanceof z.ZodType && (operation === 'refine' || operation === 'superRefine' || NORMALIZATIONS.has(operation))) {
          const callback = node.arguments[0];
          const source = ['refine', 'superRefine', 'overwrite', 'transform'].includes(operation)
            ? callbackSource(callback ?? refuse(node, 'missing callback')) : node.getText();
          limitations.push({ kind: NORMALIZATIONS.has(operation) ? 'normalization' : 'refinement', path, operation, source });
          // Callback options can contain dynamic dependencies too; validate them without invocation.
          for (const argument of node.arguments.slice(source === node.getText() ? 0 : 1)) evaluate(argument, path);
          return receiver;
        }
        if (receiver === ZOD && operation === 'preprocess') {
          const callback = node.arguments[0];
          const target = node.arguments[1];
          if (!callback || !target) return refuse(node, 'preprocess arguments');
          limitations.push({ kind: 'normalization', path, operation, source: callbackSource(callback) });
          evaluate(target, path); // Still refuse unsupported dependencies in the target.
          return z.unknown(); // Preprocessing can change input type; do not invent its input domain.
        }
        const allowed = receiver === ZOD ? FACTORIES : METHODS;
        if (!allowed.has(operation)) return refuse(node, `Zod operation ${operation}`);
        const args = node.arguments.map((argument, index) => {
          if ((operation === 'union' && index === 0) || (operation === 'discriminatedUnion' && index === 1)) {
            const alternatives = unwrap(argument);
            if (!ts.isArrayLiteralExpression(alternatives)) return refuse(argument, 'union alternatives must be a literal array');
            return alternatives.elements.map((item) => evaluate(item, path));
          }
          return evaluate(argument, operation === 'array' && index === 0 ? `${path}[]` : path);
        });
        const target: unknown = receiver === ZOD ? z : receiver;
        const method: unknown = (target as Record<string, unknown>)[operation];
        if (typeof method !== 'function') return refuse(node, `unavailable Zod operation ${operation}`);
        return Reflect.apply(method, target, args);
      }
      return refuse(node, ts.SyntaxKind[node.kind]);
    } finally { active.delete(node); }
  };
  const schema = evaluate(expression, '$');
  if (!(schema instanceof z.ZodType)) return refuse(expression, 'parse receiver is not a Zod schema');
  return { schema: z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>, limitations };
}

/** Source-only request discovery. Symbol bindings carry schemas through shared
 * request parsers. Reachable request-taking helpers are read, never imported.
 */
export function generateRequestSchemas(program: ts.Program, routeSource: ts.SourceFile, method: string): RequestSchemasResult {
  const checker = program.getTypeChecker();
  const schemas: GeneratedRequestSchema[] = [];
  const seenSchemas = new Set<string>();
  let json = false;
  let multipart = false;
  let visits = 0;
  const stack = new Set<ts.Node>();

  const boundExpression = (expression: ts.Expression, bindings: Bindings, seen = new Set<ts.Node>()): ts.Expression => {
    const node = unwrap(expression);
    if (seen.has(node)) return node;
    seen.add(node);
    const symbol = symbolAt(checker, node);
    const bound = symbol && bindings.get(symbol);
    if (bound && bound !== node) return boundExpression(bound, bindings, seen);
    if (ts.isIdentifier(node)) {
      const declaration = symbol?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) return boundExpression(declaration.initializer, bindings, seen);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const object = boundExpression(node.expression, bindings, seen);
      if (ts.isObjectLiteralExpression(object)) {
        const property = object.properties.find((entry) => entry.name && !ts.isComputedPropertyName(entry.name) && entry.name.getText() === node.name.text);
        if (property && ts.isPropertyAssignment(property)) return boundExpression(property.initializer, bindings, seen);
        if (property && ts.isShorthandPropertyAssignment(property)) return boundExpression(property.name, bindings, seen);
      }
    }
    return node;
  };
  const isRequest = (expression: ts.Expression, bindings: Bindings): boolean => {
    const node = boundExpression(expression, bindings);
    const declaration = symbolAt(checker, node)?.valueDeclaration;
    if (!declaration || !ts.isParameter(declaration)) return false;
    if (/\b(?:NextRequest|Request)\b/.test(declaration.type?.getText() ?? '')) return true;
    const type = checker.getTypeAtLocation(node);
    return ['json', 'formData', 'headers', 'url'].every((property) => !!type.getProperty(property));
  };
  const origin = (expression: ts.Expression, bindings: Bindings): Location | undefined => {
    const node = boundExpression(expression, bindings);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (node.expression.name.text === 'json' && isRequest(node.expression.expression, bindings)) return 'body';
      if (node.expression.name.text === 'catch') return origin(node.expression.expression, bindings);
    }
    if (ts.isIdentifier(node) && node.text === 'params') {
      const declaration = symbolAt(checker, node)?.valueDeclaration;
      if (declaration && (ts.isParameter(declaration) || ts.isBindingElement(declaration))) return 'path';
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'params') return 'path';
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'searchParams') return 'query';
    return undefined;
  };
  const requestDerived = (expression: ts.Expression, bindings: Bindings, seen = new Set<ts.Node>()): boolean => {
    const node = boundExpression(expression, bindings);
    if (seen.has(node)) return false;
    seen.add(node);
    if (origin(node, bindings) || isRequest(node, bindings)) return true;
    let found = false;
    ts.forEachChild(node, (child) => {
      if (ts.isExpression(child) && requestDerived(child, bindings, seen)) found = true;
    });
    return found;
  };
  const schemaName = (expression: ts.Expression, bindings: Bindings, depth = 0): string => {
    if (depth > 32) return refuse(expression, 'schema name dependency limit');
    const node = unwrap(expression);
    const symbol = symbolAt(checker, node);
    const bound = symbol && bindings.get(symbol);
    if (symbol?.valueDeclaration && ts.isParameter(symbol.valueDeclaration) && bound) return schemaName(bound, bindings, depth + 1);
    return ts.isIdentifier(node) ? node.text : 'request';
  };
  const visitFunction = (fn: ts.FunctionLikeDeclaration, args: readonly ts.Expression[], inherited: Bindings): void => {
    if (!fn.body || stack.has(fn)) return;
    if (++visits > 500) return refuse(fn, 'request helper traversal limit');
    const bindings = new Map(inherited);
    fn.parameters.forEach((parameter, index) => {
      const symbol = symbolAt(checker, parameter.name);
      const argument = args[index];
      if (symbol && argument) bindings.set(symbol, argument);
    });
    stack.add(fn);
    walk(fn.body, bindings);
    stack.delete(fn);
  };
  const walk = (node: ts.Node, bindings: Bindings): void => {
    if (ts.isFunctionDeclaration(node)) return;
    // Callback declarations are not request consumers until a reachable call binds them.
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return;
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const symbol = symbolAt(checker, node.name);
      if (symbol) bindings.set(symbol, boundExpression(node.initializer, bindings));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      const symbol = symbolAt(checker, node.left);
      if (symbol) bindings.set(symbol, boundExpression(node.right, bindings));
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const resolved = boundExpression(callee, bindings);
      const declaration = symbolAt(checker, resolved)?.valueDeclaration;
      const fn = ts.isArrowFunction(resolved) || ts.isFunctionExpression(resolved) ? resolved
        : declaration && ts.isFunctionDeclaration(declaration) ? declaration : undefined;
      if (ts.isPropertyAccessExpression(callee)) {
        const operation = callee.name.text;
        if (isRequest(callee.expression, bindings)) {
          if (operation === 'json') json = true;
          if (operation === 'formData') multipart = true;
          if (['text', 'arrayBuffer', 'blob', 'bytes'].includes(operation)) return refuse(node, `unmodeled request body reader ${operation}`);
        }
        if (!fn && ['parse', 'safeParse', 'parseAsync', 'safeParseAsync'].includes(operation) && node.arguments[0]) {
          const location = origin(node.arguments[0], bindings);
          if (location) {
            const receiver = boundExpression(callee.expression, bindings);
            const key = `${at(receiver)}:${location}`;
            if (!seenSchemas.has(key)) {
              const result = evaluateSchema(checker, callee.expression, bindings);
              schemas.push({ name: schemaName(callee.expression, bindings), location, ...result, approximation: result.limitations.length > 0, source: at(receiver) });
              seenSchemas.add(key);
            }
          } else if (requestDerived(node.arguments[0], bindings)) {
            return refuse(node.arguments[0], 'unmodeled request-derived parser input');
          }
        }
      }
      if (fn && !fn.getSourceFile().isDeclarationFile && !fn.getSourceFile().fileName.includes('/node_modules/')) {
        const local = fn.getSourceFile() === routeSource;
        if (local || node.arguments.some((argument) => requestDerived(argument, bindings))) visitFunction(fn, node.arguments, bindings);
      }
    }
    ts.forEachChild(node, (child) => walk(child, bindings));
  };

  const exportSymbol = checker.getSymbolAtLocation(routeSource);
  const handler = exportSymbol && checker.getExportsOfModule(exportSymbol).find((entry) => entry.name === method);
  const declaration = handler && (handler.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(handler) : handler).valueDeclaration;
  if (!declaration) return refuse(routeSource, `missing exported method ${method}`);
  if (ts.isFunctionDeclaration(declaration)) visitFunction(declaration, [], new Map());
  else if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const visitHandler = (expression: ts.Expression): void => {
      const node = boundExpression(expression, new Map());
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) visitFunction(node, [], new Map());
      else if (ts.isCallExpression(node)) node.arguments.forEach(visitHandler);
      else {
        const target = symbolAt(checker, node)?.valueDeclaration;
        if (target && ts.isFunctionDeclaration(target)) visitFunction(target, [], new Map());
        else return refuse(node, 'unresolved handler');
      }
    };
    visitHandler(declaration.initializer);
  } else return refuse(declaration, 'handler declaration');
  return { body: multipart ? 'multipart' : schemas.some((entry) => entry.location === 'body') ? 'json-schema' : json ? 'hand-parsed-json' : 'none', schemas };
}
