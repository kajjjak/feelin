import { NodeProp, Tree } from 'lezer';

import { builtins } from './builtins';

import {
  parseExpressions,
  parseUnaryTests
} from './parser';

class Interpreter {

  _buildExecutionTree(tree: Tree, input: string) {

    type StackEntry = { args: any[], nodeInput: string };

    const root = { args: [], nodeInput: input };

    const stack: StackEntry[] = [ root ];

    tree.iterate({
      enter(node, start, end) {

        if (node.prop(NodeProp.skipped)) {
          return false;
        }

        if (node.prop(NodeProp.error)) {
          throw new Error(`Statement unparseable at [${start}, ${end}]`);
        }

        const nodeInput = input.slice(start, end);

        stack.push({
          nodeInput,
          args: []
        });
      },

      leave(node, start, end) {

        if (node.prop(NodeProp.skipped)) {
          return;
        }

        const {
          nodeInput,
          args
        } = stack.pop() as StackEntry;

        const parent = stack[stack.length - 1];

        const expr = evalNode(node, nodeInput, args);

        parent.args.push(expr);
      }
    });

    return root.args[root.args.length - 1];
  }

  evaluate(expression: string, context={}) {

    const {
      tree: parseTree,
      parsedContext,
      parsedInput
    } = parseExpressions(expression, context);

    const root = this._buildExecutionTree(parseTree, expression);

    return {
      parseTree,
      parsedContext,
      parsedInput,
      root
    };
  }

  unaryTest(expression: string, context={}) {

    const {
      tree: parseTree,
      parsedContext,
      parsedInput
    } = parseUnaryTests(expression, context);

    const root = this._buildExecutionTree(parseTree, expression);

    return {
      parseTree,
      parsedContext,
      parsedInput,
      root
    };
  }

}

const interpreter = new Interpreter();

export function unaryTest(expression: string, context: Record<string, any> = {}) {
  const value = context['?'] || null;

  const {
    root,
    parsedContext
  } = interpreter.unaryTest(expression, context);

  // root = fn(ctx) => test(val)
  const test = root(parsedContext);

  return test(value);
}

export function evaluate(expression: string, context: Record<string, any> = {}) {

  const {
    root,
    parsedContext
  } = interpreter.evaluate(expression, context);

  // root = [ fn(ctx) ]

  const results = root(parsedContext);

  if (results.length === 1) {
    return results[0];
  } else {
    return results;
  }
}


function evalNode(node, input, args) {

  switch (node.name) {
  case 'ArithOp': return (context) => {

    const nullable = (op) => (a, b) => {

      const _a = a(context);
      const _b = b(context);

      return _a === null || _b === null ? null : op(_a, _b);
    };

    switch (input) {
    case '+': return nullable((a, b) => a + b);
    case '-': return nullable((a, b) => a - b);
    case '*': return nullable((a, b) => a * b);
    case '/': return nullable((a, b) => !b ? null : a / b);
    case '**':
    case '^': return nullable((a, b) => a ** b);
    }
  };

  case 'CompareOp': return tag((context) => {

    const compare = (fn) => {
      return (b) => (a) => {

        const _a = a(context);
        const _b = b(context);

        return fn(_a, _b) ? (context.__extractLeft ? _a : true) : false;
      };
    };

    switch (input) {
    case '>': return compare((a, b) => a > b);
    case '>=': return compare((a, b) => a >= b);
    case '<': return compare((a, b) => a < b);
    case '<=': return compare((a, b) => a <= b);
    case '=': return compare((a, b) => a == b);
    case '!=': return compare((a, b) => a != b);
    }

  }, Test('boolean'));

  case 'Wildcard': return (context) => true;

  case 'null': return (context) => {
    return null;
  };

  case 'Disjunction': return tag((context) => {

    const a = args[0](context);

    const b = args[2](context);

    const joined = a || b;

    return context.__extractLeft ? joined : !!joined;
  }, Test('boolean'));

  case 'Conjunction': return tag((context) => {

    const a = args[0](context);

    const b = args[2](context);

    const joined = a && b;

    return context.__extractLeft ? joined : !!joined;
  }, Test('boolean'));

  case 'Context': return (context) => {

    return args.slice(1, -1).map(entry => entry(context)).reduce((obj, [key, value]) => {
      obj[key] = value;

      return obj;
    }, {});
  };

  case 'ContextEntry': return (context) => {

    const key = typeof args[0] === 'function' ? args[0](context) : args[0];

    const value = args[1](context);

    return [ key, value ];
  };

  case 'Key': return args[0];

  case 'SpecialFunctionName': return (context) => getBuiltin(input, context);

  case 'QualifiedName': return (context) => getBuiltin(args.join('.'), context) || getFromContext(args.join('.'), context);

  case '?': return (context) => getFromContext('?', context);

  case 'Name': return input;

  // expression
  // expression ".." expression
  case 'IterationContext': return (context) => {

    const a = args[0](context);

    const b = args[1] && args[1](context);

    if (!b) {
      return a;
    }

    return createRange(a, b);
  };

  case 'Type': return args[0];

  case 'InExpressions': return (context) => {

    const iterationContexts = args.map(ctx => ctx(context));

    return cartesianProduct(iterationContexts).map(ctx => {
      if (!Array.isArray(ctx)) {
        ctx = [ctx];
      }

      return Object.assign({}, context, ...ctx);
    });
  };

  // Name kw<"in"> Expr
  case 'InExpression': return (context) => {
    return extractValue(context, args[0], args[2]);
  };

  case 'InstanceOf': return tag((context) => {

    const a = args[0](context);
    const b = args[3](context);

    return a instanceof b;
  }, Test('boolean'));

  case 'every': return tag((context) => {
    return (_contexts, _condition) => {
      const contexts = _contexts(context);
      return contexts.every(ctx => isTruthy(_condition(ctx)));
    };

  }, Test('boolean'));

  case 'some': return tag((context) => {
    return (_contexts, _condition) => {
      const contexts = _contexts(context);
      return contexts.some(ctx => isTruthy(_condition(ctx)));
    };
  }, Test('boolean'));

  case 'NumericLiteral': return tag((context) => input.includes('.') ? parseFloat(input) : parseInt(input), 'number');

  case 'BooleanLiteral': return tag((context) => input === 'true' ? true : false, 'boolean');

  case 'StringLiteral': return tag((context) => input.slice(1, -1), 'string');

  case 'PositionalParameters': return (context) => args;

  case 'DateTimeLiteral': return args[0];

  case 'DateTimeConstructor': return (context) => {

    const _name = args[0];

    const name = _name === 'DateAndTime' ? 'date and time' : _name;

    const fn = getBuiltin(name, context);

    const fnArgs = args[1](context).map(fn => fn(context));

    return fn(...fnArgs);
  };

  case 'FunctionInvocation': return (context) => {

    const fn = args[0](context);

    if (typeof fn !== 'function') {
      throw new Error(`Failed to evaluate ${input}: Target is not a function`);
    }

    const fnArgs = args[1](context).map(fn => fn(context));

    return fn(...fnArgs);
  };

  case 'IfExpression': return (function() {

    const ifCondition = args[1];

    const thenValue = args[3];
    const elseValue = args[5];

    const type = coalecenseTypes(thenValue, elseValue);

    return tag((context) => {

      if (isTruthy(ifCondition(context))) {
        return thenValue(context);
      } else {
        return elseValue ? elseValue(context) : null;
      }
    }, type);

  })();

  case 'Parameters': return args.length === 3 ? args[1] : (context) => [];

  case 'Comparison': return (context) => {

    const operator = args[1];

    // expression !compare kw<"in"> PositiveUnaryTest |
    // expression !compare kw<"in"> !unaryTest "(" PositiveUnaryTests ")"
    if (operator === 'in') {
      return compareIn(context, args[0], args[3] || args[2]);
    }

    // expression !compare kw<"between"> expression kw<"and"> expression
    if (operator === 'between') {
      return compareBetween(context, args[0], args[2], args[4]);
    }

    // expression !compare CompareOp<"=" | "!="> expression |
    // expression !compare CompareOp<Gt | Gte | Lt | Lte> expression |
    return operator(context)(args[2])(args[0]);
  };

  case 'QuantifiedExpression': return (context) => {

    const testFn = args[0](context);

    const contexts = args[1];

    const condition = args[3];

    return testFn(contexts, condition);
  };

  // DMN 1.2 - 10.3.2.14
  // kw<"for"> commaSep1<InExpression<IterationContext>> kw<"return"> expression
  case 'ForExpression': return (context) => {
    const extractor = args[args.length - 1];

    const iterationContexts = args[1](context);

    const partial = [];

    for (const ctx of iterationContexts) {

      partial.push(extractor({
        ...ctx,
        partial
      }));
    }

    return partial;
  };

  case 'ArithmeticExpression': return (function() {

    // binary expression (a + b)
    if (args.length === 3) {
      const [ a, op, b ] = args;

      return tag((context) => {
        return op(context)(a, b);
      }, coalecenseTypes(a, b));
    }

    // unary expression (-b)
    if (args.length === 2) {
      const [ op, value ] = args;

      return tag((context) => {

        return op(context)(() => 0, value);
      }, value.type);
    }
  })();

  case 'PositiveUnaryTest': return args[0];

  case 'ParenthesizedExpression': return args[1];

  case 'PathExpression': return (context) => {

    const pathTarget = args[0](context);
    const pathProp = args[1];

    if (Array.isArray(pathTarget)) {
      return pathTarget.map(el => el[pathProp]);
    } else {
      return pathTarget[pathProp];
    }
  };

  // expression !filter "[" expression "]"
  case 'FilterExpression': return (context) => {

    const target = args[0](context);

    const filterFn = args[2];

    const filterTarget = Array.isArray(target) ? target : [ target ];

    // null[..]
    if (target === null) {
      return null;
    }

    // a[1]
    if (filterFn.type === 'number') {
      const idx = filterFn(context);

      const value = filterTarget[idx < 0 ? filterTarget.length + idx : idx -1];

      if (typeof value === 'undefined') {
        return null;
      } else {
        return value;
      }
    }

    // a[true]
    if (filterFn.type === 'boolean') {
      if (filterFn(context)) {
        return filterTarget;
      } else {
        return Array.isArray(target) ? [] : null;
      }
    }

    if (filterFn.type === 'string') {

      const value = filterFn(context);

      return filterTarget.filter(el => el === value);
    }

    // a[test]
    return filterTarget.map(el => {

      const iterationContext = {
        ...context,
        item: el,
        ...Object.entries(el).reduce(function(itemScope, [key, value]) {
          itemScope[ 'item.' + key ] = value;

          return itemScope;
        }, {}),
        ...el
      };

      let result = filterFn(iterationContext);

      // test is fn(val) => boolean SimpleUnaryTest
      if (typeof result === 'function') {
        result = result(() => el);
      }

      if (result === true) {
        return el;
      }

      return result;
    }).filter(isTruthy);
  };

  case 'SimplePositiveUnaryTest': return tag((context) => {

    if (args.length === 1) {
      return args[0](context);
    }

    return args[0](context)(args[1]);
  }, 'test');

  case 'List': return (context) => {
    return args.slice(1, -1).map(arg => arg(context));
  };

  case 'Interval': return (context) => {

    const interval = createInterval(args[0], args[1](context), args[2](context), args[3]);

    return (a) => {
      const left = a(context);

      const includes = interval.includes(left);

      return includes && context.__extractLeft ? left : includes;
    };
  };

  case 'PositiveUnaryTests':
  case 'Expressions': return (context) => {
    return args.map(a => a(context));
  };

  case 'UnaryTests': return (context) => {

    return (value={}) => {

      const negate = args[0] === 'not';

      const tests = negate ? args.slice(2, -1) : args;

      const matches = tests.map(test => test(context)).map(r => {

        if (Array.isArray(r)) {
          return r.map(r => {

            if (Array.isArray(r)) {
              return r.includes(value);
            }

            if (r === null) {
              return null;
            }

            if (typeof r === 'boolean') {
              return r;
            }

            if (typeof r === 'function') {
              return r(() => value);
            }

            if (typeof r === typeof value) {
              return r === value;
            }

            return null;
          }).reduce(combineResult, undefined);
        }

        if (r === null) {
          return null;
        }

        if (typeof r === 'boolean') {
          return r;
        }

        if (typeof r === 'function') {
          return r(value);
        }

        if (typeof r === typeof value) {
          return r === value;
        }

        return null;
      }).reduce(combineResult, undefined);

      return matches === null ? null : (negate ? !matches : matches);
    };
  };

  default: return node.name;
  }
}

function getBuiltin(name, context) {
  return builtins[name];
}

function getFromContext(variable, context) {

  if (variable in context) {
    return context[variable];
  }

  return null;
}

function extractValue(context, prop, _target) {

  const target = _target(context);

  if (!Array.isArray(target)) {
    throw new Error(`Cannot extract ${ prop } from ${ target }`);
  }

  return target.map(t => (
    { [prop]: t }
  ));
}

function compareBetween(context, _left, _start, _end) {

  const left = _left(context);

  const start = _start(context);
  const end = _end(context);

  return Math.min(start, end) <= left && left <= Math.max(start, end) ? (context.__extractLeft ? left : true) : false;
}

function compareIn(context, _left, _tests) {

  const left = _left(context);

  const tests = _tests(context);

  return (Array.isArray(tests) ? tests : [ tests ]).some(
    test => compareValOrFn(test, left)
  ) ? (context.__extractLeft ? left : true) : false;
}

function compareValOrFn(valOrFn, expr) {

  if (typeof valOrFn === 'function') {
    return valOrFn(() => expr);
  }

  return valOrFn === expr;
}

interface RangeArray<T> extends Array<T> {
  __isRange: boolean
};

function range(size: number, startAt = 0, direction = 1) {

  const r = Array.from(Array(size).keys()).map(i => i * direction + startAt) as RangeArray<number>;

  r.__isRange = true;

  return r;
}

function createRange(start, end) {

  if (typeof start === 'number' && typeof end === 'number') {

    const steps = Math.max(start, end) - Math.min(start, end);

    return range(steps + 1, start, end < start ? -1 : 1);
  }

  throw new Error('unsupported range');
}

function cartesianProduct(arrays: number[][]) {

  const f = (a, b) => [].concat(...a.map(d => b.map(e => [].concat(d, e))));
  const cartesian = (a?, b?, ...c) => (b ? cartesian(f(a, b), ...c) : a);

  return cartesian(...arrays);
}


function coalecenseTypes(a, b) {

  if (!b) {
    return a.type;
  }

  if (a.type === b.type) {
    return a.type;
  }

  return 'any';
}

function tag(fn, type) {

  fn.type = type;

  fn.toString = function() {
    return `TaggedFunction[${type}] ${Function.prototype.toString.call(fn)}`;
  };

  return fn;
}

function combineResult(result, match) {

  if (!result) {
    return match;
  }

  return result;
}

function isTruthy(obj) {
  return obj !== false && obj !== null;
}

function Test(type) {
  return `Test<${type}>`;
}

function createInterval(start, startValue, endValue, end) {

  const inclusiveStart = start === '[';
  const inclusiveEnd = end === ']';

  return new Interval(startValue, endValue, inclusiveStart, inclusiveEnd);
}

function Interval(startValue, endValue, inclusiveStart, inclusiveEnd) {

  const direction = Math.sign(endValue - startValue);

  const rangeStart = (inclusiveStart ? 0 : direction * 0.000001) + startValue;
  const rangeEnd = (inclusiveEnd ? 0 : -direction * 0.000001) + endValue;

  const realStart = Math.min(rangeStart, rangeEnd);
  const realEnd = Math.max(rangeStart, rangeEnd);

  this.includes = (value) => {
    return realStart <= value && value <= realEnd;
  };
}