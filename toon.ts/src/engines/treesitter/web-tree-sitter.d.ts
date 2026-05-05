/**
 * Ambient type declarations for `web-tree-sitter` ^0.26.8.
 *
 * Describes ONLY the API surface used by tree-sitter.ts. Matches the v0.26.x
 * shipped declarations: `Node` (not `SyntaxNode`), and `hasError` / `isMissing`
 * are GETTERS (not methods).
 *
 * LIFECYCLE
 * ---------
 * This file is a build-time stub for environments where the `web-tree-sitter`
 * package is NOT yet installed (e.g. fresh checkout, CI before `npm ci`,
 * type-only review).
 *
 * After running `npm install web-tree-sitter`, the package's own bundled
 * declarations (`node_modules/web-tree-sitter/web-tree-sitter.d.ts`) become
 * available and DECLARE THE SAME CLASS NAMES under the same module. To avoid
 * duplicate-class conflicts at compile time, DELETE THIS FILE once the
 * package is installed:
 *
 *   rm src/engines/treesitter/web-tree-sitter.d.ts
 *
 * This stub is structurally compatible with the real declarations, so any
 * code that compiles against this file will continue to compile against the
 * real package.
 *
 * Imports used by tree-sitter.ts:
 *   import { Parser, Language as TSLanguage, Query as TSQuery } from 'web-tree-sitter';
 *   import type { Node, QueryCapture } from 'web-tree-sitter';
 *
 * Construction:
 *   - Parser.init({ locateFile })  // static, returns Promise<void>
 *   - Language.load(wasmPath)      // static, returns Promise<Language>
 *   - new Query(language, source)  // constructor (NOT language.query(source))
 */
declare module 'web-tree-sitter' {
  /** Zero-based row/column position in a text document. */
  export interface Point {
    row: number;
    column: number;
  }

  /** Edit description for incremental parsing. */
  export interface Edit {
    startIndex: number;
    oldEndIndex: number;
    newEndIndex: number;
    startPosition: Point;
    oldEndPosition: Point;
    newEndPosition: Point;
  }

  /**
   * A node in the parsed syntax tree.
   *
   * In web-tree-sitter v0.26.x this class is exported as `Node`.
   * `hasError` and `isMissing` are GETTERS (properties), not methods —
   * calling them as `node.hasError()` will throw at runtime.
   */
  export class Node {
    readonly type: string;
    readonly text: string;
    readonly startPosition: Point;
    readonly endPosition: Point;
    readonly startIndex: number;
    readonly endIndex: number;
    readonly childCount: number;
    readonly parent: Node | null;
    readonly firstChild: Node | null;
    readonly lastChild: Node | null;
    readonly nextSibling: Node | null;
    readonly previousSibling: Node | null;
    /** True if this node represents a syntax error or contains one. */
    readonly hasError: boolean;
    /** True if this node was inserted by the parser to recover from an error. */
    readonly isMissing: boolean;
    child(index: number): Node | null;
    namedChild(index: number): Node | null;
    toString(): string;
  }

  export interface Tree {
    readonly rootNode: Node;
    delete(): void;
    edit(edit: Edit): void;
  }

  export interface QueryCapture {
    name: string;
    node: Node;
  }

  export interface QueryMatch {
    pattern: number;
    captures: QueryCapture[];
  }

  /** Constructed via `new Query(language, source)`. */
  export class Query {
    constructor(language: Language, source: string);
    captures(node: Node, startPosition?: Point, endPosition?: Point): QueryCapture[];
    matches(node: Node, startPosition?: Point, endPosition?: Point): QueryMatch[];
    delete(): void;
  }

  /** Loaded via static `Language.load(wasmPath)`. */
  export class Language {
    static load(path: string): Promise<Language>;
  }

  export class Parser {
    static init(options?: { locateFile?: (file: string, prefix: string) => string }): Promise<void>;
    setLanguage(language: Language): void;
    parse(input: string, oldTree?: Tree): Tree;
    delete(): void;
  }
}
