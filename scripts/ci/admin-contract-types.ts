import ts from 'typescript';

/** Successful JSON values; unknown source payloads must not acquire invented fields. */
export const JSON_VALUE_DECLARATION = 'export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined };';

function location(node: ts.Node): string {
  const file = node.getSourceFile();
  return `${file.fileName}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
}

/** Expand compiler types into a portable closure, without repository import aliases. */
export function renderJsonType(
  checker: ts.TypeChecker,
  type: ts.Type,
  at: ts.Node,
  wire = true,
  nested = false,
  parents: ReadonlySet<ts.Type> = new Set(),
): string {
  const render = (value: ts.Type, child = true) => renderJsonType(checker, value, at, wire, child, new Set([...parents, type]));
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    if (!wire) return type.flags & ts.TypeFlags.Any ? 'unknown' : 'unknown';
    if (!nested) throw new Error(`${location(at)}: unresolved top-level unknown/any JSON body`);
    return 'JsonValue';
  }
  if (type.flags & ts.TypeFlags.Never) return 'never';
  if (type.flags & ts.TypeFlags.Null) return 'null';
  if (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return wire ? 'null' : 'undefined';
  if (type.flags & ts.TypeFlags.StringLiteral) return JSON.stringify((type as ts.StringLiteralType).value);
  if (type.flags & ts.TypeFlags.NumberLiteral) return String((type as ts.NumberLiteralType).value);
  if (type.flags & ts.TypeFlags.BooleanLiteral) return checker.typeToString(type);
  if (type.flags & ts.TypeFlags.String) return 'string';
  if (type.flags & ts.TypeFlags.Number) return wire ? 'number | null' : 'number';
  if (type.flags & ts.TypeFlags.Boolean) return 'boolean';
  if (type.flags & ts.TypeFlags.BigIntLike) {
    if (wire) throw new Error(`${location(at)}: bigint cannot serialize as JSON`);
    return 'bigint';
  }
  if (type.isUnion()) return [...new Set(type.types.map((part) => render(part, nested)))].sort().join(' | ');
  if (type.isIntersection()) {
    const primitive = type.types.find((part) => part.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike));
    if (primitive) return render(primitive, nested);
  }
  if (type.getSymbol()?.getName() === 'Date') return wire ? 'string | null' : 'Date';
  if (wire && type.getProperty('toJSON')) throw new Error(`${location(at)}: custom toJSON conversion is unsupported`);
  if (parents.has(type)) throw new Error(`${location(at)}: recursive named type needs explicit JSON-safe declaration: ${checker.typeToString(type)}`);
  if (checker.isTupleType(type)) {
    const tuple = (type as ts.TypeReference).target as ts.TupleType;
    if (tuple.elementFlags.some((flag) => flag !== ts.ElementFlags.Required)) throw new Error(`${location(at)}: optional or variadic tuple serialization is unsupported`);
    return `[${checker.getTypeArguments(type as ts.TypeReference).map((part) => render(part)).join(', ')}]`;
  }
  if (checker.isArrayType(type)) {
    const element = checker.getTypeArguments(type as ts.TypeReference)[0];
    if (!element) throw new Error(`${location(at)}: array element type unresolved`);
    return `Array<${render(element)}>`;
  }
  if (type.getCallSignatures().length > 0) {
    if (wire && nested) return 'null'; // JSON array slots retain omitted values as null.
    throw new Error(`${location(at)}: callable JSON body is unsupported`);
  }
  const fields: string[] = [];
  for (const property of checker.getPropertiesOfType(type)) {
    if (property.getName().startsWith('__@')) continue;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? at);
    if (wire && propertyType.getCallSignatures().length > 0) continue;
    const parts = propertyType.isUnion() ? propertyType.types : [propertyType];
    const omitted = wire && parts.some((part) => part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Any | ts.TypeFlags.Unknown) || part.getCallSignatures().length > 0);
    const present = wire ? parts.filter((part) => !(part.flags & ts.TypeFlags.Undefined) && part.getCallSignatures().length === 0) : parts;
    if (present.length === 0) continue;
    const rendered = [...new Set(present.map((part) => render(part)))].sort().join(' | ');
    const optional = omitted || Boolean(property.flags & ts.SymbolFlags.Optional);
    fields.push(`${JSON.stringify(property.getName())}${optional ? '?' : ''}: ${rendered};`);
  }
  for (const index of checker.getIndexInfosOfType(type)) {
    const key = index.keyType.flags & ts.TypeFlags.NumberLike ? 'number' : 'string';
    fields.push(`[key: ${key}]: ${render(index.type)}${wire ? ' | undefined' : ''};`);
  }
  if (fields.length === 0 && type.flags & (ts.TypeFlags.ESSymbolLike | ts.TypeFlags.TypeParameter)) {
    throw new Error(`${location(at)}: unsupported JSON type ${checker.typeToString(type)}`);
  }
  return `{ ${fields.sort().join(' ')} }`;
}

export interface ResponseShape {
  body: string;
  status: string;
  source: string;
}

interface Binding { node: ts.Node; env: Bindings }
type Bindings = ReadonlyMap<ts.Symbol, Binding>;

/** Bounded call-site analysis. It never evaluates application JavaScript. */
export function describeResponses(program: ts.Program, source: ts.SourceFile, method: string): ResponseShape[] {
  const checker = program.getTypeChecker();
  const responses: ResponseShape[] = [];
  const symbols = checker.getExportsOfModule(checker.getSymbolAtLocation(source)!);
  const handler = symbols.find((symbol) => symbol.name === method);
  if (!handler) throw new Error(`${source.fileName}: unresolved method ${method}`);
  const visited = new Set<string>();
  let steps = 0;

  function symbolAt(node: ts.Node): ts.Symbol | undefined {
    if (node.parent && ts.isShorthandPropertyAssignment(node.parent)) {
      return checker.getShorthandAssignmentValueSymbol(node.parent);
    }
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  }
  function resolveBinding(node: ts.Node, env: Bindings, seen = new Set<ts.Symbol>()): Binding {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isAwaitExpression(node) || ts.isNonNullExpression(node)) {
      return resolveBinding(node.expression, env, seen);
    }
    if (ts.isIdentifier(node)) {
      const symbol = symbolAt(node);
      if (symbol && !seen.has(symbol)) {
        const bound = env.get(symbol);
        if (bound) return resolveBinding(bound.node, bound.env, new Set([...seen, symbol]));
        const declaration = symbol.valueDeclaration;
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
          return resolveBinding(declaration.initializer, env, new Set([...seen, symbol]));
        }
        if (declaration && (ts.isFunctionDeclaration(declaration) || ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration))) return { node: declaration, env };
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const base = resolveBinding(node.expression, env, seen);
      if (ts.isObjectLiteralExpression(base.node)) {
        const member = base.node.properties.find((part) => part.name?.getText().replace(/['"]/g, '') === node.name.text);
        if (member && ts.isPropertyAssignment(member)) return resolveBinding(member.initializer, base.env, seen);
        if (member && ts.isShorthandPropertyAssignment(member)) return resolveBinding(member.name, base.env, seen);
      }
      const symbol = symbolAt(node.name);
      const declaration = symbol?.valueDeclaration;
      if (declaration && ts.isFunctionDeclaration(declaration)) return { node: declaration, env };
    }
    if (ts.isCallExpression(node)) {
      const callee = resolveBinding(node.expression, env, seen);
      const fn = callee.node;
      if ((ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.body) {
        const returned = ts.isBlock(fn.body)
          ? fn.body.statements.find((statement): statement is ts.ReturnStatement => ts.isReturnStatement(statement) && Boolean(statement.expression))?.expression
          : fn.body;
        if (returned && (ts.isArrowFunction(returned) || ts.isFunctionExpression(returned))) {
          const closure = new Map(callee.env);
          fn.parameters.forEach((parameter, index) => {
            const symbol = symbolAt(parameter.name);
            const argument = node.arguments[index] ?? parameter.initializer;
            if (symbol && argument) closure.set(symbol, { node: argument, env });
          });
          return { node: returned, env: closure };
        }
      }
    }
    return { node, env };
  }

  function renderExpression(node: ts.Node, env: Bindings): string {
    // Preserve the compiler's call-site flow type for locals (including mutations
    // and assertions); substitute only actual helper parameters, not initializers.
    let bound: Binding = { node, env };
    const seen = new Set<ts.Symbol>();
    while (ts.isIdentifier(bound.node)) {
      const symbol = symbolAt(bound.node);
      const argument = symbol && bound.env.get(symbol);
      if (!symbol || !argument || seen.has(symbol)) break;
      seen.add(symbol);
      bound = argument;
    }
    if (ts.isObjectLiteralExpression(bound.node)) {
      // The compiler owns spread/optional/intersection semantics; override only
      // direct fields whose values contain call-site parameter substitutions.
      const type = checker.getTypeAtLocation(bound.node);
      if (type.getProperty('toJSON')) throw new Error(`${location(bound.node)}: custom toJSON conversion is unsupported`);
      const properties = new Map(checker.getPropertiesOfType(type).map((property) => [property.name, property]));
      const entries: string[] = [];
      for (const [name, property] of properties) {
        const declaration = bound.node.properties.find((part) => part.name?.getText().replace(/['"]/g, '') === name);
        const expression = declaration && ts.isPropertyAssignment(declaration) ? declaration.initializer : undefined;
        const substituted = expression && ts.isIdentifier(expression) && bound.env.has(symbolAt(expression)!);
        const propertyType = checker.getTypeOfSymbolAtLocation(property, bound.node);
        const parts = propertyType.isUnion() ? propertyType.types : [propertyType];
        const optional = Boolean(property.flags & ts.SymbolFlags.Optional) || parts.some((part) => part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Unknown | ts.TypeFlags.Any) || part.getCallSignatures().length > 0);
        const present = parts.filter((part) => !(part.flags & ts.TypeFlags.Undefined) && part.getCallSignatures().length === 0);
        if (!present.length) continue;
        const value = substituted ? renderExpression(expression, bound.env) : [...new Set(present.map((part) => renderJsonType(checker, part, bound.node, true, true)))].sort().join(' | ');
        entries.push(`${JSON.stringify(name)}${optional ? '?' : ''}: ${value};`);
      }
      return `{ ${entries.sort().join(' ')} }`;
    }
    const typed = bound.node === node ? node : bound.node;
    return renderJsonType(checker, checker.getTypeAtLocation(typed), typed);
  }

  function statusText(node: ts.Node | undefined, env: Bindings): string {
    if (!node) return '200';
    const bound = resolveBinding(node, env);
    const type = checker.getTypeAtLocation(bound.node);
    if (ts.isNumericLiteral(bound.node)) return bound.node.text;
    const parts = type.isUnion() ? type.types : [type];
    if (parts.every((part) => Boolean(part.flags & ts.TypeFlags.NumberLiteral))) {
      return parts.map((part) => String((part as ts.NumberLiteralType).value)).sort().join(', ');
    }
    const finite = finiteStatuses(bound.node, bound.env);
    if (finite.length) return [...new Set(finite)].sort((a, b) => a - b).join(', ');
    throw new Error(`${source.fileName} ${method}: unresolved status ${location(bound.node)} (${bound.node.getText()})`);
  }

  // Numeric annotations often erase a finite domain-error vocabulary. Follow
  // actual constructor arguments and constant lookup values, never a hand list.
  function finiteStatuses(node: ts.Node, env: Bindings, depth = 0): number[] {
    if (depth > 24) throw new Error(`${location(node)}: status derivation exceeded bounded depth`);
    const bound = resolveBinding(node, env);
    node = bound.node; env = bound.env;
    if (ts.isNumericLiteral(node)) return [Number(node.text)];
    const type = checker.getTypeAtLocation(node);
    const types = type.isUnion() ? type.types : [type];
    if (types.every((part) => Boolean(part.flags & ts.TypeFlags.NumberLiteral))) return types.map((part) => (part as ts.NumberLiteralType).value);
    if (ts.isConditionalExpression(node)) return [...finiteStatuses(node.whenTrue, env, depth + 1), ...finiteStatuses(node.whenFalse, env, depth + 1)];
    if (ts.isPropertyAccessExpression(node)) {
      const values = propertyValues(node.expression, node.name.text, env, depth + 1);
      if (values.length) return values.flatMap((value) => finiteStatuses(value.node, value.env, depth + 1));
      const owner = checker.getTypeAtLocation(node.expression).getSymbol();
      const declaration = owner?.valueDeclaration;
      if (owner && declaration && ts.isClassDeclaration(declaration)) {
        const constructor = declaration.members.find(ts.isConstructorDeclaration);
        if (!constructor) throw new Error(`${location(node)}: unresolved status constructor`);
        let parameter = constructor.parameters.findIndex((item) => item.name.getText() === node.name.text && Boolean(ts.getModifiers(item)?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)));
        if (parameter < 0 && constructor.body) {
          for (const statement of constructor.body.statements) {
            if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue;
            const assignment = statement.expression;
            if (ts.isPropertyAccessExpression(assignment.left) && assignment.left.expression.kind === ts.SyntaxKind.ThisKeyword && assignment.left.name.text === node.name.text && ts.isIdentifier(assignment.right)) {
              parameter = constructor.parameters.findIndex((item) => item.name.getText() === assignment.right.getText());
            }
          }
        }
        if (parameter >= 0) {
          const values: number[] = [];
          for (const file of program.getSourceFiles()) {
            if (file.isDeclarationFile || /(?:node_modules|__tests__|\.test\.|\.spec\.)/.test(file.fileName)) continue;
            const walk = (child: ts.Node): void => {
              if (ts.isNewExpression(child) && symbolAt(child.expression) === owner) {
                const argument = child.arguments?.[parameter] ?? constructor.parameters[parameter]?.initializer;
                if (!argument) throw new Error(`${location(child)}: missing status constructor argument`);
                const derived = finiteStatuses(argument, new Map(), depth + 1);
                if (!derived.length) throw new Error(`${location(argument)}: unresolved status constructor argument`);
                values.push(...derived);
              }
              ts.forEachChild(child, walk);
            };
            walk(file);
          }
          return values;
        }
      }
    }
    if (ts.isElementAccessExpression(node)) {
      const base = resolveBinding(node.expression, env);
      if (ts.isObjectLiteralExpression(base.node)) {
        return base.node.properties.flatMap((property) => {
          if (ts.isPropertyAssignment(property)) return finiteStatuses(property.initializer, base.env, depth + 1);
          if (ts.isShorthandPropertyAssignment(property)) return finiteStatuses(property.name, base.env, depth + 1);
          throw new Error(`${location(property)}: unresolved status lookup member`);
        });
      }
    }
    throw new Error(`${location(node)}: unresolved status expression (${node.getText()})`);
  }

  function propertyValues(node: ts.Node, name: string, env: Bindings, depth: number): Binding[] {
    if (depth > 24) throw new Error(`${location(node)}: property derivation exceeded bounded depth`);
    const bound = resolveBinding(node, env);
    node = bound.node; env = bound.env;
    if (ts.isObjectLiteralExpression(node)) {
      const property = node.properties.find((item) => item.name?.getText().replace(/['"]/g, '') === name);
      if (property && ts.isPropertyAssignment(property)) return [{ node: property.initializer, env }];
    }
    if (ts.isElementAccessExpression(node)) {
      const base = resolveBinding(node.expression, env);
      if (ts.isObjectLiteralExpression(base.node)) return base.node.properties.flatMap((property) => ts.isPropertyAssignment(property) ? propertyValues(property.initializer, name, base.env, depth + 1) : []);
    }
    if (ts.isConditionalExpression(node)) {
      // Reading a property from null/undefined cannot produce an HTTP status.
      // Source control-flow commonly narrows these absent lookup results out.
      const present = [node.whenTrue, node.whenFalse].filter((branch) => !(checker.getTypeAtLocation(branch).flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never)));
      const branches = present.map((branch) => propertyValues(branch, name, env, depth + 1));
      if (branches.some((branch) => !branch.length)) throw new Error(`${location(node)}: unresolved status property branch`);
      return branches.flat();
    }
    if (ts.isCallExpression(node)) {
      const target = resolveBinding(node.expression, env).node;
      if ((ts.isFunctionDeclaration(target) || ts.isArrowFunction(target) || ts.isFunctionExpression(target)) && target.body) {
        const next = new Map(env);
        target.parameters.forEach((parameter, index) => { const symbol = symbolAt(parameter.name); const argument = node.arguments[index]; if (symbol && argument) next.set(symbol, { node: argument, env }); });
        const values: Binding[] = [];
        const walk = (child: ts.Node): void => {
          if (ts.isReturnStatement(child) && child.expression) {
            const returned = propertyValues(child.expression, name, next, depth + 1);
            if (!returned.length) throw new Error(`${location(child)}: unresolved status property return`);
            values.push(...returned);
          }
          else ts.forEachChild(child, walk);
        };
        if (ts.isBlock(target.body)) walk(target.body);
        else values.push(...propertyValues(target.body, name, next, depth + 1));
        return values;
      }
    }
    return [];
  }

  function responseBearing(type: ts.Type, seen = new Set<ts.Type>()): boolean {
    if (seen.has(type)) return false;
    seen.add(type);
    if (type.getSymbol()?.name === 'NextResponse' || type.getSymbol()?.name === 'Response') return true;
    if (type.isUnion()) return type.types.some((part) => responseBearing(part, seen));
    const promised = type.getSymbol()?.name === 'Promise' ? checker.getTypeArguments(type as ts.TypeReference)[0] : undefined;
    if (promised) return responseBearing(promised, seen);
    const response = type.getProperty('response');
    return Boolean(response && responseBearing(checker.getTypeOfSymbolAtLocation(response, response.valueDeclaration ?? source), seen));
  }

  function call(node: ts.CallExpression, env: Bindings): boolean {
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'json') {
      const receiver = checker.getTypeAtLocation(callee.expression);
      const receiverName = symbolAt(callee.expression)?.name ?? receiver.getSymbol()?.name;
      if (receiverName === 'NextResponse' || receiverName === 'Response') {
        const body = node.arguments[0];
        if (!body) throw new Error(`${location(node)}: JSON response without body`);
        const init = node.arguments[1] && resolveBinding(node.arguments[1], env);
        if (init && (!ts.isObjectLiteralExpression(init.node) || init.node.properties.some((part) => !ts.isPropertyAssignment(part) && !ts.isShorthandPropertyAssignment(part)))) {
          throw new Error(`${location(init.node)}: unresolved response init`);
        }
        const status = init && ts.isObjectLiteralExpression(init.node) ? init.node.properties.find((part) => part.name?.getText().replace(/['"]/g, '') === 'status') : undefined;
        const statusNode = status && ts.isPropertyAssignment(status) ? status.initializer : status && ts.isShorthandPropertyAssignment(status) ? status.name : undefined;
        responses.push({ body: renderExpression(body, env), status: statusText(statusNode, init?.env ?? env), source: location(node) });
        return true;
      }
    }
    const bound = resolveBinding(callee, env);
    let fn = bound.node;
    if (ts.isCallExpression(fn)) throw new Error(`${location(node)}: unresolved higher-order response producer`);
    if (ts.isIdentifier(fn) || ts.isPropertyAccessExpression(fn)) {
      const declaration = symbolAt(ts.isPropertyAccessExpression(fn) ? fn.name : fn)?.valueDeclaration;
      if (declaration) fn = declaration;
    }
    const signature = checker.getResolvedSignature(node);
    const returnsResponse = signature && responseBearing(checker.getReturnTypeOfSignature(signature));
    const factory = signature && checker.getReturnTypeOfSignature(signature).getCallSignatures().length > 0;
    if (!returnsResponse && !factory) return false;
    if (!(ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isArrowFunction(fn) || ts.isMethodDeclaration(fn)) || !fn.body || fn.getSourceFile().isDeclarationFile) {
      throw new Error(`${source.fileName} ${method}: unresolved response producer ${location(node)} (${callee.getText()})`);
    }
    const next = new Map(bound.env);
    fn.parameters.forEach((parameter, index) => {
      const symbol = checker.getSymbolAtLocation(parameter.name);
      const argument = node.arguments[index];
      if (symbol && argument) next.set(symbol, { node: argument, env });
      else if (symbol && parameter.initializer) next.set(symbol, { node: parameter.initializer, env: next });
    });
    const key = `${location(node)}:${location(fn)}:${[...next.values()].map((value) => location(value.node)).join('|')}`;
    if (!visited.has(key)) { visited.add(key); visit(fn.body, next, Boolean(factory)); }
    return true;
  }

  function visit(node: ts.Node, env: Bindings, returnedClosure = false): void {
    if (++steps > 20_000) throw new Error(`${source.fileName} ${method}: response analysis exceeded bounded work`);
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      if (returnedClosure && node.body) visit(node.body, env, true);
      return;
    }
    if (ts.isReturnStatement(node) && node.expression && returnedClosure) {
      visit(node.expression, env, true);
      return;
    }
    if (ts.isReturnStatement(node) && node.expression) {
      const type = checker.getTypeAtLocation(node.expression);
      if (type.getSymbol()?.name === 'NextResponse' || type.getSymbol()?.name === 'Response') {
        const returned = resolveBinding(node.expression, env);
        const producer = ts.isPropertyAccessExpression(returned.node) ? resolveBinding(returned.node.expression, returned.env) : returned;
        if (!ts.isCallExpression(producer.node)) throw new Error(`${location(node)}: unresolved response return (${node.expression.getText()})`);
      }
    }
    if (ts.isCallExpression(node) && call(node, env)) return;
    if (ts.isIdentifier(node) && env.has(symbolAt(node)!)) {
      const bound = resolveBinding(node, env);
      if (bound.node !== node && (ts.isArrowFunction(bound.node) || ts.isFunctionExpression(bound.node))) visit(bound.node.body, bound.env);
    }
    ts.forEachChild(node, (child) => visit(child, env, returnedClosure && ts.isBlock(node)));
  }
  const declaration = handler.valueDeclaration ?? handler.declarations?.[0];
  if (!declaration) throw new Error(`${source.fileName} ${method}: handler declaration unavailable`);
  if (ts.isFunctionDeclaration(declaration) && declaration.body) visit(declaration.body, new Map());
  else if (ts.isVariableDeclaration(declaration) && declaration.initializer) visit(declaration.initializer, new Map(), true);
  else throw new Error(`${source.fileName} ${method}: unsupported handler declaration`);
  if (!responses.length) throw new Error(`${source.fileName} ${method}: no JSON response expressions resolved`);
  return [...new Map(responses.map((item) => [`${item.status}:${item.body}:${item.source}`, item])).values()];
}
