/**
 * A restricted deterministic expression language for server-authored
 * evaluations, parsed and **interpreted** here — never `eval`'d, never handed
 * to `node:vm`.
 *
 * ## Why an interpreter and not `vm`
 *
 * The Python SDK validates an AST against an allowlist and then calls `eval`
 * with empty builtins. The same shape in JavaScript is not safe, because
 * JavaScript has a reachable path from any value to arbitrary code:
 *
 *     (() => {}).constructor("return process")()
 *     x["constructor"]["constructor"]("…")()
 *
 * A STATIC allowlist cannot close the second one: `x[k]` is a property read
 * whose key is only known at runtime, so `x["constructor"]` passes any check
 * made over the source text. `node:vm` does not close it either — a vm context
 * has its own `Function`, and reaching it from inside is a well-known escape.
 *
 * Interpreting removes the question. Every property read goes through
 * `readProperty` below, which is an allowlist evaluated against the ACTUAL key
 * at the moment of the read, and there is no path from a value to a function
 * constructor because the interpreter never constructs one. The
 * `worker_threads` sandbox around this (see `source.ts`) is then a RESOURCE
 * bound — CPU, heap, wall-clock — rather than the only thing standing between
 * tenant source and the worker's credentials.
 *
 * ## The grammar
 *
 * One expression. Literals, arrays, objects, template strings, member access,
 * calls, arrow functions (the analogue of Python's comprehensions — `.map` /
 * `.filter` need them), the arithmetic, comparison and logical operators, and
 * the conditional operator. No statements, no assignment, no `new`, no
 * `function`, no `async`, no `await`, no regular-expression literals, no
 * optional chaining into calls.
 *
 * DEFAULT-DENY throughout: anything the parser does not explicitly understand
 * is a rejection, not a pass-through. A grammar gap is therefore a definition
 * that will not run, never a definition that runs unchecked.
 */

export class UnsafeEvaluatorSource extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeEvaluatorSource";
  }
}

/** A sandboxed evaluation exceeded its step, depth or value budget. */
export class EvaluationBudgetExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationBudgetExceeded";
  }
}

export const MAX_AST_NODES = 5_000;
export const MAX_POW_EXPONENT = 64;
/**
 * Interpreter step ceiling. There are no loop statements in this grammar, but
 * `.map` over a large array and self-application (`(f => f(f))(f => f(f))`, the
 * Y-combinator — reachable with nothing but arrow functions) both run forever.
 * The worker's wall-clock kill is the outer bound; this one fails the
 * evaluation with a message that says what happened instead of a silent
 * timeout.
 */
export const MAX_STEPS = 2_000_000;
export const MAX_CALL_DEPTH = 64;
/** Cap on a single constructed string, so concatenation cannot build a bomb. */
export const MAX_STRING_LENGTH = 1_000_000;
/** Cap on a single constructed array, for the same reason. */
export const MAX_ARRAY_LENGTH = 100_000;

// ---------------------------------------------------------------------------
// Allowlists
// ---------------------------------------------------------------------------

/**
 * Pure data methods. Allowed only at a CALL SITE — `_parse` requires each of
 * these names to be the callee of a call, so a bare `payload.get` reference
 * cannot be smuggled into a result field.
 *
 * Conspicuously absent: `constructor`, `apply`, `call`, `bind`, `toString`,
 * `valueOf`, `__proto__`, `prototype`. Not as a denylist — they are absent
 * because this is an allowlist, which is the whole point: a method added to
 * `Array.prototype` by a future runtime is denied by default rather than
 * needing to be discovered and listed.
 */
const METHOD_ATTRS = new Set([
  // Transcript methods.
  "eventsOfType",
  "count",
  // Array data methods.
  "map",
  "filter",
  "some",
  "every",
  "find",
  "findIndex",
  "includes",
  "indexOf",
  "lastIndexOf",
  "slice",
  "concat",
  "join",
  "flat",
  "flatMap",
  "reduce",
  "at",
  "reverse",
  // String data methods.
  "toLowerCase",
  "toUpperCase",
  "trim",
  "trimStart",
  "trimEnd",
  "split",
  "startsWith",
  "endsWith",
  "replace",
  "replaceAll",
  "padStart",
  "padEnd",
  "repeat",
  "charAt",
  "codePointAt",
  "normalize",
  "localeCompare",
  // Number data methods.
  "toFixed",
]);

/**
 * Property names that must never be readable, whatever the allowlist says and
 * however the key is computed. `readProperty` checks this on the RUNTIME key,
 * which is what closes `x[someExpressionThatYields("constructor")]`.
 */
const FORBIDDEN_KEYS = new Set([
  "constructor",
  "prototype",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "apply",
  "call",
  "bind",
  "arguments",
  "caller",
  "toString",
  "valueOf",
  "toJSON",
  "then",
]);

/** Namespace globals, each with its own fixed member set. */
const NAMESPACE_MEMBERS: Record<string, ReadonlySet<string>> = {
  Math: new Set([
    "abs",
    "min",
    "max",
    "round",
    "floor",
    "ceil",
    "trunc",
    "sign",
    "sqrt",
    "log",
    "log2",
    "log10",
    "exp",
    "hypot",
    "PI",
    "E",
  ]),
  Object: new Set(["keys", "values", "entries", "fromEntries"]),
  Array: new Set(["isArray", "from", "of"]),
  Number: new Set(["isFinite", "isInteger", "isNaN", "parseFloat", "parseInt", "MAX_SAFE_INTEGER"]),
  JSON: new Set(["stringify"]),
};

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType = "num" | "str" | "template" | "name" | "punct" | "eof";

interface TemplatePart {
  readonly cooked: string;
  readonly expression: string | null;
}

interface Token {
  readonly type: TokenType;
  readonly value: string;
  readonly start: number;
  readonly numeric?: number;
  readonly parts?: readonly TemplatePart[];
}

const PUNCTUATORS = [
  "===",
  "!==",
  "**",
  "&&",
  "||",
  "??",
  "==",
  "!=",
  "<=",
  ">=",
  "=>",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ".",
  ":",
  "?",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "!",
].sort((a, b) => b.length - a.length);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

function fail(fieldName: string, detail: string): never {
  throw new UnsafeEvaluatorSource(`${fieldName} ${detail}`);
}

class Tokenizer {
  private index = 0;
  constructor(
    private readonly text: string,
    private readonly fieldName: string,
  ) {}

  tokenize(): Token[] {
    const tokens: Token[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.index >= this.text.length) {
        tokens.push({ type: "eof", value: "", start: this.index });
        return tokens;
      }
      tokens.push(this.next());
    }
  }

  /**
   * Whitespace only. Comments are NOT skipped — they are rejected by the
   * punctuator table, because a language that accepts `//` and `/*` has to get
   * their interaction with division exactly right to stay unambiguous, and an
   * expression that needs a comment is one that should be simpler.
   */
  private skipTrivia(): void {
    while (this.index < this.text.length && /\s/.test(this.text[this.index]!)) this.index += 1;
  }

  private next(): Token {
    const start = this.index;
    const char = this.text[start]!;

    if (char >= "0" && char <= "9") return this.number(start);
    if (char === "." && /[0-9]/.test(this.text[start + 1] ?? "")) return this.number(start);
    if (char === '"' || char === "'") return this.string(start, char);
    if (char === "`") return this.template(start);
    if (IDENT_START.test(char)) return this.name(start);

    for (const punctuator of PUNCTUATORS) {
      if (this.text.startsWith(punctuator, start)) {
        this.index = start + punctuator.length;
        return { type: "punct", value: punctuator, start };
      }
    }
    fail(this.fieldName, `contains an unexpected character ${JSON.stringify(char)}`);
  }

  private number(start: number): Token {
    let end = start;
    while (end < this.text.length && /[0-9]/.test(this.text[end]!)) end += 1;
    if (this.text[end] === ".") {
      end += 1;
      while (end < this.text.length && /[0-9]/.test(this.text[end]!)) end += 1;
    }
    if (this.text[end] === "e" || this.text[end] === "E") {
      let cursor = end + 1;
      if (this.text[cursor] === "+" || this.text[cursor] === "-") cursor += 1;
      if (/[0-9]/.test(this.text[cursor] ?? "")) {
        cursor += 1;
        while (cursor < this.text.length && /[0-9]/.test(this.text[cursor]!)) cursor += 1;
        end = cursor;
      }
    }
    // A trailing identifier character means `1n` (BigInt) or `0x…`; both are
    // outside this grammar and must be rejected rather than silently truncated
    // to the numeric prefix.
    if (IDENT_PART.test(this.text[end] ?? "")) {
      fail(this.fieldName, "contains an unsupported numeric literal");
    }
    const raw = this.text.slice(start, end);
    this.index = end;
    return { type: "num", value: raw, start, numeric: Number(raw) };
  }

  private readEscape(): string {
    // `this.index` points at the backslash.
    this.index += 1;
    const char = this.text[this.index];
    if (char === undefined) fail(this.fieldName, "ends inside a string escape");
    this.index += 1;
    switch (char) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "v":
        return "\v";
      case "0":
        return "\0";
      case "u": {
        if (this.text[this.index] === "{") {
          const close = this.text.indexOf("}", this.index);
          if (close === -1) fail(this.fieldName, "has an unterminated unicode escape");
          const hex = this.text.slice(this.index + 1, close);
          if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) fail(this.fieldName, "has a malformed unicode escape");
          this.index = close + 1;
          return String.fromCodePoint(Number.parseInt(hex, 16));
        }
        const hex = this.text.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail(this.fieldName, "has a malformed unicode escape");
        this.index += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      case "x": {
        const hex = this.text.slice(this.index, this.index + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) fail(this.fieldName, "has a malformed hex escape");
        this.index += 2;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        return char;
    }
  }

  private string(start: number, quote: string): Token {
    this.index = start + 1;
    let out = "";
    while (this.index < this.text.length) {
      const char = this.text[this.index]!;
      if (char === quote) {
        this.index += 1;
        return { type: "str", value: out, start };
      }
      if (char === "\\") {
        out += this.readEscape();
        continue;
      }
      if (char === "\n") fail(this.fieldName, "has an unterminated string literal");
      out += char;
      this.index += 1;
    }
    fail(this.fieldName, "has an unterminated string literal");
  }

  private template(start: number): Token {
    this.index = start + 1;
    const parts: TemplatePart[] = [];
    let cooked = "";
    while (this.index < this.text.length) {
      const char = this.text[this.index]!;
      if (char === "`") {
        this.index += 1;
        parts.push({ cooked, expression: null });
        return { type: "template", value: "", start, parts };
      }
      if (char === "\\") {
        cooked += this.readEscape();
        continue;
      }
      if (char === "$" && this.text[this.index + 1] === "{") {
        const expression = this.readInterpolation();
        parts.push({ cooked, expression });
        cooked = "";
        continue;
      }
      cooked += char;
      this.index += 1;
    }
    fail(this.fieldName, "has an unterminated template literal");
  }

  /** The source between `${` and its matching `}`, tracking nesting and strings. */
  private readInterpolation(): string {
    this.index += 2;
    const begin = this.index;
    let depth = 1;
    while (this.index < this.text.length) {
      const char = this.text[this.index]!;
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const source = this.text.slice(begin, this.index);
          this.index += 1;
          return source;
        }
      } else if (char === '"' || char === "'" || char === "`") {
        this.string(this.index, char);
        continue;
      }
      this.index += 1;
    }
    fail(this.fieldName, "has an unterminated template interpolation");
  }

  private name(start: number): Token {
    let end = start;
    while (end < this.text.length && IDENT_PART.test(this.text[end]!)) end += 1;
    this.index = end;
    return { type: "name", value: this.text.slice(start, end), start };
  }
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type Node =
  | { kind: "literal"; value: unknown }
  | { kind: "template"; parts: ReadonlyArray<{ cooked: string; expression: Node | null }> }
  | { kind: "name"; name: string }
  | { kind: "array"; elements: readonly Node[] }
  | { kind: "object"; properties: ReadonlyArray<{ key: Node; value: Node }> }
  | { kind: "member"; object: Node; property: Node; computed: boolean; optional: boolean }
  | { kind: "call"; callee: Node; args: readonly Node[]; optional: boolean }
  | { kind: "unary"; operator: string; argument: Node }
  | { kind: "binary"; operator: string; left: Node; right: Node }
  | { kind: "logical"; operator: string; left: Node; right: Node }
  | { kind: "conditional"; test: Node; consequent: Node; alternate: Node }
  | { kind: "arrow"; params: readonly string[]; body: Node };

const RESERVED_NAMES = new Set([
  "new",
  "function",
  "class",
  "await",
  "yield",
  "delete",
  "typeof",
  "instanceof",
  "void",
  "this",
  "super",
  "import",
  "export",
  "var",
  "let",
  "const",
  "return",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "try",
  "catch",
  "finally",
  "throw",
  "in",
  "of",
  "with",
  "debugger",
]);

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private position = 0;
  private nodes = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly fieldName: string,
    private readonly globals: ReadonlySet<string>,
    private scopes: readonly (readonly string[])[] = [],
  ) {}

  static parse(
    source: string,
    fieldName: string,
    globals: ReadonlySet<string>,
    scopes: readonly (readonly string[])[] = [],
  ): Node {
    const parser = new Parser(new Tokenizer(source, fieldName).tokenize(), fieldName, globals, scopes);
    const node = parser.expression();
    parser.expect("eof");
    return node;
  }

  private count(): void {
    this.nodes += 1;
    if (this.nodes > MAX_AST_NODES) {
      fail(this.fieldName, `is too large (${MAX_AST_NODES}-node ceiling)`);
    }
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.position + offset, this.tokens.length - 1)]!;
  }

  private at(value: string): boolean {
    const token = this.peek();
    return token.type === "punct" && token.value === value;
  }

  private eat(value: string): boolean {
    if (!this.at(value)) return false;
    this.position += 1;
    return true;
  }

  private expect(type: TokenType, value?: string): Token {
    const token = this.peek();
    if (token.type !== type || (value !== undefined && token.value !== value)) {
      fail(
        this.fieldName,
        `is not one valid expression (unexpected ${
          token.type === "eof" ? "end of input" : JSON.stringify(token.value)
        })`,
      );
    }
    this.position += 1;
    return token;
  }

  private bound(name: string): boolean {
    return this.scopes.some((scope) => scope.includes(name));
  }

  private withScope<T>(params: readonly string[], body: () => T): T {
    const previous = this.scopes;
    this.scopes = [...previous, params];
    try {
      return body();
    } finally {
      this.scopes = previous;
    }
  }

  expression(): Node {
    return this.conditional();
  }

  private conditional(): Node {
    const test = this.nullish();
    if (!this.eat("?")) return test;
    this.count();
    const consequent = this.expression();
    this.expect("punct", ":");
    const alternate = this.expression();
    return { kind: "conditional", test, consequent, alternate };
  }

  private nullish(): Node {
    let left = this.logicalOr();
    while (this.at("??")) {
      this.position += 1;
      this.count();
      left = { kind: "logical", operator: "??", left, right: this.logicalOr() };
    }
    return left;
  }

  private logicalOr(): Node {
    let left = this.logicalAnd();
    while (this.at("||")) {
      this.position += 1;
      this.count();
      left = { kind: "logical", operator: "||", left, right: this.logicalAnd() };
    }
    return left;
  }

  private logicalAnd(): Node {
    let left = this.equality();
    while (this.at("&&")) {
      this.position += 1;
      this.count();
      left = { kind: "logical", operator: "&&", left, right: this.equality() };
    }
    return left;
  }

  private equality(): Node {
    let left = this.relational();
    for (;;) {
      const operator = ["===", "!==", "==", "!="].find((op) => this.at(op));
      if (operator === undefined) return left;
      this.position += 1;
      this.count();
      left = { kind: "binary", operator, left, right: this.relational() };
    }
  }

  private relational(): Node {
    let left = this.additive();
    for (;;) {
      const operator = ["<=", ">=", "<", ">"].find((op) => this.at(op));
      if (operator === undefined) return left;
      this.position += 1;
      this.count();
      left = { kind: "binary", operator, left, right: this.additive() };
    }
  }

  private additive(): Node {
    let left = this.multiplicative();
    for (;;) {
      const operator = ["+", "-"].find((op) => this.at(op));
      if (operator === undefined) return left;
      this.position += 1;
      this.count();
      left = { kind: "binary", operator, left, right: this.multiplicative() };
    }
  }

  private multiplicative(): Node {
    let left = this.exponent();
    for (;;) {
      const operator = ["*", "/", "%"].find((op) => this.at(op));
      if (operator === undefined) return left;
      this.position += 1;
      this.count();
      left = { kind: "binary", operator, left, right: this.exponent() };
    }
  }

  private exponent(): Node {
    const left = this.unary();
    if (!this.at("**")) return left;
    this.position += 1;
    this.count();
    const right = this.exponent();
    // Defence in depth: a literal `10 ** 20` (or `2 ** (10 ** 8)`) builds a
    // number — or, with strings, a memory bomb — at compile-time-visible size.
    // Require the exponent to be a small non-negative integer literal.
    // Runtime-sized bombs still exist and are caught by the step budget and the
    // worker's limits, not here.
    if (
      right.kind !== "literal" ||
      typeof right.value !== "number" ||
      !Number.isInteger(right.value) ||
      right.value < 0 ||
      right.value > MAX_POW_EXPONENT
    ) {
      fail(this.fieldName, `exponent must be an integer constant in 0..${MAX_POW_EXPONENT}`);
    }
    return { kind: "binary", operator: "**", left, right };
  }

  private unary(): Node {
    const operator = ["!", "-", "+"].find((op) => this.at(op));
    if (operator === undefined) return this.postfix();
    this.position += 1;
    this.count();
    return { kind: "unary", operator, argument: this.unary() };
  }

  private postfix(): Node {
    let node = this.primary();
    for (;;) {
      if (this.eat(".")) {
        this.count();
        const name = this.expect("name");
        this.checkAttribute(name.value);
        node = {
          kind: "member",
          object: node,
          property: { kind: "literal", value: name.value },
          computed: false,
          optional: false,
        };
        // A method name must be the callee of a call. A bare reference is only
        // ever useful for getting a function object somewhere it can be
        // re-entered, and nothing a real evaluation does needs one.
        if (METHOD_ATTRS.has(name.value) && !this.at("(")) {
          fail(
            this.fieldName,
            `may reference method '${name.value}' only to call it`,
          );
        }
        continue;
      }
      if (this.eat("[")) {
        this.count();
        const property = this.expression();
        this.expect("punct", "]");
        // A computed key that is a literal can be checked now, so
        // `x["constructor"]` fails when the definition is published rather than
        // on the first session it runs against. A computed key that is not a
        // literal cannot be, which is why `readProperty` checks every key again
        // at the moment of the read.
        if (property.kind === "literal" && typeof property.value === "string") {
          this.checkAttribute(property.value);
        }
        node = { kind: "member", object: node, property, computed: true, optional: false };
        continue;
      }
      if (this.at("(")) {
        this.count();
        node = { kind: "call", callee: node, args: this.arguments(), optional: false };
        continue;
      }
      return node;
    }
  }

  /**
   * What the PARSER can rule out, which is less than it looks.
   *
   * An event payload's keys are whatever the agent put in it — `error`,
   * `tool_name`, `latency_ms`, anything — so a static allowlist of attribute
   * names cannot be the boundary here without making the language unable to
   * read the data it exists to read. And it would not be the boundary anyway:
   * `x[k]` is a property read whose key is only known at runtime, so anything
   * a static check rejects can be spelled computed.
   *
   * So `readProperty` is the boundary, checked against the ACTUAL key at the
   * moment of the read, and this check rejects only the names that can never be
   * legitimate — private/dunder, and the introspection surface — plus the rule
   * that a method may be referenced only to call it.
   */
  private checkAttribute(name: string): void {
    if (name.startsWith("_")) {
      fail(this.fieldName, "may not access private or dunder attributes");
    }
    if (FORBIDDEN_KEYS.has(name)) {
      fail(this.fieldName, `may not access attribute '${name}'`);
    }
  }

  private arguments(): Node[] {
    this.expect("punct", "(");
    const args: Node[] = [];
    if (this.eat(")")) return args;
    for (;;) {
      args.push(this.expression());
      if (this.eat(",")) {
        if (this.eat(")")) return args; // trailing comma
        continue;
      }
      this.expect("punct", ")");
      return args;
    }
  }

  private primary(): Node {
    this.count();
    const token = this.peek();

    if (token.type === "num") {
      this.position += 1;
      return { kind: "literal", value: token.numeric };
    }
    if (token.type === "str") {
      this.position += 1;
      return { kind: "literal", value: token.value };
    }
    if (token.type === "template") {
      this.position += 1;
      return {
        kind: "template",
        parts: (token.parts ?? []).map((part) => ({
          cooked: part.cooked,
          expression:
            part.expression === null
              ? null
              : Parser.parse(part.expression, this.fieldName, this.globals, this.scopes),
        })),
      };
    }
    if (token.type === "name") {
      if (token.value === "true" || token.value === "false") {
        this.position += 1;
        return { kind: "literal", value: token.value === "true" };
      }
      if (token.value === "null" || token.value === "undefined") {
        this.position += 1;
        return { kind: "literal", value: token.value === "null" ? null : undefined };
      }
      // `x => …`
      if (this.peek(1).type === "punct" && this.peek(1).value === "=>") {
        return this.arrow([this.parameterName(token.value)]);
      }
      this.position += 1;
      if (RESERVED_NAMES.has(token.value)) {
        fail(this.fieldName, `may not use the reserved word '${token.value}'`);
      }
      if (token.value.startsWith("_")) fail(this.fieldName, "may not access private names");
      if (!this.bound(token.value) && !this.globals.has(token.value)) {
        fail(this.fieldName, `may not reference '${token.value}'`);
      }
      return { kind: "name", name: token.value };
    }
    if (this.at("[")) {
      this.position += 1;
      const elements: Node[] = [];
      if (this.eat("]")) return { kind: "array", elements };
      for (;;) {
        elements.push(this.expression());
        if (this.eat(",")) {
          if (this.eat("]")) return { kind: "array", elements };
          continue;
        }
        this.expect("punct", "]");
        return { kind: "array", elements };
      }
    }
    if (this.at("{")) return this.objectLiteral();
    if (this.at("(")) {
      const arrowParams = this.tryParenArrowParams();
      if (arrowParams !== null) return this.arrow(arrowParams);
      this.position += 1;
      const inner = this.expression();
      this.expect("punct", ")");
      return inner;
    }
    fail(
      this.fieldName,
      `is not one valid expression (unexpected ${
        token.type === "eof" ? "end of input" : JSON.stringify(token.value)
      })`,
    );
  }

  private parameterName(name: string): string {
    if (RESERVED_NAMES.has(name)) fail(this.fieldName, `may not use '${name}' as a parameter`);
    if (name.startsWith("_")) fail(this.fieldName, "may not declare private names");
    return name;
  }

  /**
   * `(a, b) =>` — decided by lookahead rather than by backtracking a parse.
   *
   * Returns the parameter names when the parenthesised group is a bare
   * identifier list followed by `=>`, and null otherwise (in which case it is a
   * parenthesised expression). Destructuring, defaults and rest are not part of
   * the grammar, so anything else in the group means "not an arrow".
   */
  private tryParenArrowParams(): string[] | null {
    let offset = 1;
    const params: string[] = [];
    if (this.peek(offset).type === "punct" && this.peek(offset).value === ")") {
      offset += 1;
    } else {
      for (;;) {
        const token = this.peek(offset);
        if (token.type !== "name") return null;
        params.push(token.value);
        offset += 1;
        const next = this.peek(offset);
        if (next.type !== "punct") return null;
        if (next.value === ",") {
          offset += 1;
          continue;
        }
        if (next.value === ")") {
          offset += 1;
          break;
        }
        return null;
      }
    }
    const arrow = this.peek(offset);
    if (arrow.type !== "punct" || arrow.value !== "=>") return null;
    this.position += offset;
    return params.map((name) => this.parameterName(name));
  }

  private arrow(params: readonly string[]): Node {
    // The caller has consumed everything up to but not including `=>` for the
    // single-identifier form, and up to and including `)` for the parenthesised
    // one; normalise by consuming the arrow here.
    if (!this.at("=>")) {
      this.position += 1; // the lone identifier
    }
    this.expect("punct", "=>");
    this.count();
    if (new Set(params).size !== params.length) {
      fail(this.fieldName, "may not declare a parameter twice");
    }
    if (this.at("{")) {
      fail(this.fieldName, "arrow functions must have an expression body, not a block");
    }
    const body = this.withScope(params, () => this.expression());
    return { kind: "arrow", params, body };
  }

  private objectLiteral(): Node {
    this.expect("punct", "{");
    const properties: Array<{ key: Node; value: Node }> = [];
    if (this.eat("}")) return { kind: "object", properties };
    for (;;) {
      this.count();
      let key: Node;
      const token = this.peek();
      if (token.type === "name") {
        this.position += 1;
        key = { kind: "literal", value: token.value };
      } else if (token.type === "str") {
        this.position += 1;
        key = { kind: "literal", value: token.value };
      } else if (token.type === "num") {
        this.position += 1;
        key = { kind: "literal", value: String(token.numeric) };
      } else if (this.eat("[")) {
        key = this.expression();
        this.expect("punct", "]");
      } else {
        fail(this.fieldName, "has an unsupported object key");
      }
      this.expect("punct", ":");
      properties.push({ key, value: this.expression() });
      if (this.eat(",")) {
        if (this.eat("}")) return { kind: "object", properties };
        continue;
      }
      this.expect("punct", "}");
      return { kind: "object", properties };
    }
  }
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

class Budget {
  steps = 0;
  depth = 0;

  step(): void {
    this.steps += 1;
    if (this.steps > MAX_STEPS) {
      throw new EvaluationBudgetExceeded(
        `evaluation exceeded ${MAX_STEPS} steps; it is looping or iterating unboundedly`,
      );
    }
  }
}

type Scope = Map<string, unknown>;

/**
 * Every property read in the language, checked against the RUNTIME key.
 *
 * This is the security boundary, not the parser: `x[k]` cannot be checked
 * statically, and `x["constructor"]` is the whole escape. Own properties only,
 * so nothing reaches a prototype; allowlisted names only, so nothing reaches an
 * inherited method the allowlist has not vetted.
 */
function readProperty(target: unknown, key: unknown): unknown {
  if (target === null || target === undefined) {
    throw new TypeError(`cannot read property ${String(key)} of ${String(target)}`);
  }

  const name = typeof key === "number" ? String(key) : String(key);
  // Checked FIRST, on the runtime key, and before anything else looks at the
  // receiver. This one test is what closes `x["constructor"]["constructor"]`
  // and every spelling of it — including keys assembled at runtime, which no
  // amount of source inspection can see.
  if (name.startsWith("_") || FORBIDDEN_KEYS.has(name)) {
    throw new UnsafeEvaluatorSource(`property '${name}' is not readable in an evaluator expression`);
  }

  // A namespace global gets its own member set: `Math.abs` yes, `Math` beyond
  // that no.
  for (const [namespaceName, members] of Object.entries(NAMESPACE_MEMBERS)) {
    if (target === NAMESPACES[namespaceName]) {
      if (!members.has(name)) {
        throw new UnsafeEvaluatorSource(`${namespaceName}.${name} is not available`);
      }
      return (NAMESPACES[namespaceName] as Record<string, unknown>)[name];
    }
  }

  // Built-in receivers expose their ALLOWLISTED methods and nothing else: their
  // prototypes are shared, mutable and full of things that are not data.
  if (typeof target === "string" || Array.isArray(target)) {
    if (/^\d+$/.test(name)) return (target as unknown as Record<string, unknown>)[name];
    if (name === "length") return (target as { length: number }).length;
    if (!METHOD_ATTRS.has(name)) {
      throw new UnsafeEvaluatorSource(
        `'${name}' is not available on ${Array.isArray(target) ? "an array" : "a string"}`,
      );
    }
    const method = (target as unknown as Record<string, unknown>)[name];
    if (typeof method !== "function") throw new TypeError(`'${name}' is not a method of this value`);
    // Bound, so a call site cannot re-target it — `.call` is denied anyway, and
    // this costs nothing to make structurally impossible as well.
    return (method as (...args: unknown[]) => unknown).bind(target);
  }
  if (typeof target === "number" || typeof target === "boolean") {
    if (!METHOD_ATTRS.has(name)) {
      throw new UnsafeEvaluatorSource(`'${name}' is not available on a ${typeof target}`);
    }
    const method = (target as unknown as Record<string, unknown>)[name];
    if (typeof method !== "function") throw new TypeError(`'${name}' is not a method of a number`);
    return (method as (...args: unknown[]) => unknown).bind(target);
  }
  if (typeof target !== "object") {
    throw new TypeError(`cannot read property '${name}' of a ${typeof target}`);
  }

  // A plain data object — an event payload, or one the expression built. Its
  // keys are the agent's own and cannot be enumerated in advance, so ANY key is
  // readable here except the ones refused above. OWN properties only, so
  // nothing reaches a prototype and an absent key reads as `undefined` rather
  // than as whatever `Object.prototype` happens to carry.
  if (!Object.prototype.hasOwnProperty.call(target, name)) return undefined;
  const value = (target as Record<string, unknown>)[name];
  if (typeof value === "function") {
    // Only the transcript's own data methods are functions on this path — a
    // JSON payload cannot contain one — but the allowlist still applies, so a
    // future surface cannot expose something callable by accident.
    if (!METHOD_ATTRS.has(name)) {
      throw new UnsafeEvaluatorSource(`'${name}' is not callable in an evaluator expression`);
    }
    return (value as (...args: unknown[]) => unknown).bind(target);
  }
  return value;
}

/**
 * `==` / `!=` without ever running the operands' own code.
 *
 * JavaScript's loose equality calls `valueOf` and `toString` on an object
 * operand, which is a call into arbitrary code — the one door this interpreter
 * would otherwise leave open. Mapping `==` to `===` instead was worse in
 * practice: `payload.error != null` is THE idiom for "this optional field is
 * present", and under strict equality it silently stops matching `undefined`,
 * so an evaluation over a payload that simply omits the key reports the
 * opposite of the truth.
 *
 * So: nullish operands compare as JavaScript does, primitives coerce the way
 * the specification says, and an object compared against a primitive is
 * `false` rather than an invitation to run `valueOf`.
 */
function looselyEqual(left: unknown, right: unknown): boolean {
  const leftNullish = left === null || left === undefined;
  const rightNullish = right === null || right === undefined;
  if (leftNullish || rightNullish) return leftNullish && rightNullish;
  if (typeof left === typeof right) return left === right;
  const leftPrimitive = typeof left !== "object" && typeof left !== "function";
  const rightPrimitive = typeof right !== "object" && typeof right !== "function";
  if (!leftPrimitive || !rightPrimitive) return false;
  if (typeof left === "boolean") return looselyEqual(Number(left), right);
  if (typeof right === "boolean") return looselyEqual(left, Number(right));
  if (typeof left === "number" && typeof right === "string") return left === Number(right);
  if (typeof left === "string" && typeof right === "number") return Number(left) === right;
  return false;
}

/** The namespace objects the language exposes, frozen and minimal. */
const NAMESPACES: Record<string, unknown> = {
  Math,
  Object,
  Array,
  Number,
  JSON,
};

function checkString(value: string): string {
  if (value.length > MAX_STRING_LENGTH) {
    throw new EvaluationBudgetExceeded(
      `evaluation built a string longer than ${MAX_STRING_LENGTH} characters`,
    );
  }
  return value;
}

function checkArray<T>(value: T[]): T[] {
  if (value.length > MAX_ARRAY_LENGTH) {
    throw new EvaluationBudgetExceeded(
      `evaluation built an array longer than ${MAX_ARRAY_LENGTH} items`,
    );
  }
  return value;
}

function evaluate(node: Node, scopes: readonly Scope[], budget: Budget): unknown {
  budget.step();
  switch (node.kind) {
    case "literal":
      return node.value;

    case "template": {
      let out = "";
      for (const part of node.parts) {
        out = checkString(out + part.cooked);
        if (part.expression !== null) {
          out = checkString(out + String(evaluate(part.expression, scopes, budget)));
        }
      }
      return out;
    }

    case "name": {
      for (let i = scopes.length - 1; i >= 0; i -= 1) {
        const scope = scopes[i]!;
        if (scope.has(node.name)) return scope.get(node.name);
      }
      throw new ReferenceError(`${node.name} is not defined`);
    }

    case "array":
      return checkArray(node.elements.map((element) => evaluate(element, scopes, budget)));

    case "object": {
      const out: Record<string, unknown> = {};
      for (const property of node.properties) {
        const key = String(evaluate(property.key, scopes, budget));
        if (key.startsWith("_") || FORBIDDEN_KEYS.has(key)) {
          throw new UnsafeEvaluatorSource(`'${key}' is not a permitted object key`);
        }
        out[key] = evaluate(property.value, scopes, budget);
      }
      return out;
    }

    case "member":
      return readProperty(
        evaluate(node.object, scopes, budget),
        evaluate(node.property, scopes, budget),
      );

    case "call": {
      // The receiver is resolved through `readProperty`, which already bound
      // the method — so there is no separate `this` to thread and no way to
      // re-target one.
      const callee = evaluate(node.callee, scopes, budget);
      if (typeof callee !== "function") {
        throw new TypeError("attempted to call a value that is not a function");
      }
      const args = node.args.map((argument) => evaluate(argument, scopes, budget));
      budget.depth += 1;
      if (budget.depth > MAX_CALL_DEPTH) {
        throw new EvaluationBudgetExceeded(
          `evaluation exceeded a call depth of ${MAX_CALL_DEPTH}`,
        );
      }
      try {
        const result = (callee as (...a: unknown[]) => unknown)(...args);
        if (typeof result === "string") return checkString(result);
        if (Array.isArray(result)) return checkArray(result);
        return result;
      } finally {
        budget.depth -= 1;
      }
    }

    case "unary": {
      const value = evaluate(node.argument, scopes, budget);
      if (node.operator === "!") return !value;
      if (node.operator === "-") return -(value as number);
      return +(value as number);
    }

    case "logical": {
      const left = evaluate(node.left, scopes, budget);
      if (node.operator === "&&") return left ? evaluate(node.right, scopes, budget) : left;
      if (node.operator === "||") return left ? left : evaluate(node.right, scopes, budget);
      return left === null || left === undefined ? evaluate(node.right, scopes, budget) : left;
    }

    case "conditional":
      return evaluate(node.test, scopes, budget)
        ? evaluate(node.consequent, scopes, budget)
        : evaluate(node.alternate, scopes, budget);

    case "binary": {
      const left = evaluate(node.left, scopes, budget) as never;
      const right = evaluate(node.right, scopes, budget) as never;
      switch (node.operator) {
        case "+": {
          const sum = (left as unknown as number) + (right as unknown as number);
          return typeof sum === "string" ? checkString(sum) : sum;
        }
        case "-":
          return (left as number) - (right as number);
        case "*":
          return (left as number) * (right as number);
        case "/":
          return (left as number) / (right as number);
        case "%":
          return (left as number) % (right as number);
        case "**":
          return (left as number) ** (right as number);
        case "<":
          return left < right;
        case "<=":
          return left <= right;
        case ">":
          return left > right;
        case ">=":
          return left >= right;
        case "===":
          return left === right;
        case "!==":
          return left !== right;
        // See `looselyEqual`: the specification's coercions, none of the
        // operand's own code.
        case "==":
          return looselyEqual(left, right);
        case "!=":
          return !looselyEqual(left, right);
        default:
          throw new UnsafeEvaluatorSource(`unsupported operator '${node.operator}'`);
      }
    }

    case "arrow": {
      const params = node.params;
      const body = node.body;
      return (...args: unknown[]): unknown => {
        budget.step();
        const scope: Scope = new Map();
        params.forEach((param, index) => scope.set(param, args[index]));
        return evaluate(body, [...scopes, scope], budget);
      };
    }
  }
}

export interface CompiledExpression {
  (globals: Record<string, unknown>): unknown;
}

/**
 * Parse and validate `source`, returning a function that evaluates it.
 *
 * The parse happens once, up front, so unsafe or malformed source is rejected
 * before anything runs — and the returned function contains no `eval`, no
 * `Function`, and no reachable path to either.
 */
export function compileExpression(
  source: string,
  options: { fieldName: string; maximumBytes: number; globalNames: readonly string[] },
): CompiledExpression {
  if (typeof source !== "string" || source.trim() === "") {
    fail(options.fieldName, "must not be empty");
  }
  const size = Buffer.byteLength(source, "utf8");
  if (size > options.maximumBytes) {
    fail(options.fieldName, `exceeds ${options.maximumBytes} bytes`);
  }
  const globals = new Set(options.globalNames);
  const ast = Parser.parse(source, options.fieldName, globals);

  return (values: Record<string, unknown>): unknown => {
    const scope: Scope = new Map(Object.entries(values));
    // Namespace globals are bound per call rather than captured, so a future
    // change that made one of them mutable could not leak across evaluations.
    for (const name of Object.keys(NAMESPACES)) {
      if (globals.has(name)) scope.set(name, NAMESPACES[name]);
    }
    return evaluate(ast, [scope], new Budget());
  };
}

export { METHOD_ATTRS, FORBIDDEN_KEYS, NAMESPACE_MEMBERS };
