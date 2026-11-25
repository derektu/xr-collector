import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rule, SourceCode } from 'eslint';
import type { Comment, Node } from 'estree';
import { ENTRIES, importsOf, LAYERS, moduleOf } from '../source-structure.js';

const LICENSE_PATTERN = /^[\s*]*SPDX-License-Identifier:/u;
const LINT_DIRECTIVE_PATTERN = /^\s*(eslint-disable-next-line|eslint-disable-line|eslint-disable|eslint-enable|eslint|globals?|exported)(\s|$)/u;
const TOOL_DIRECTIVE_PATTERN = /^\s*prettier-ignore(\s|$)/u;
const TRIPLE_SLASH_PATTERN = /^\/\s*<reference\s/u;
const TS_DIRECTIVE_PATTERN = /^[\s*/]*@ts-(ignore|expect-error|nocheck)\b/u;
const EXTERNAL_PATTERN = /^\s*External:/u;

const MESSAGES = {
  comment:
    'Code carries no comments. Explain our own code by renaming, extracting a function, adding a type or writing a test; put design reasoning in docs/. A fact about another system (a dependency, platform or protocol) that the code must follow is a `// External:` comment. See docs/code-guidelines.md, section Comment.',
  docComment:
    'A /** */ doc comment goes only on an exported declaration of a public file, or on a public member of one: a file under src/shared, a module entry (index.ts, declarations.ts, server-entries.ts) or a file an entry re-exports with `export … from`. Not on private members or inside a function. Elsewhere, rename or add a type so the code explains itself, or move the contract to docs/. See docs/code-guidelines.md, section Comment.',
  lintDirective:
    'Lint rules are not configured from code: inline eslint directives have no effect. Fix the code; when a rule needs an exception, add it to eslint.config.ts so every exception is reviewed in one place. See docs/code-guidelines.md, section 規則放在哪一層.',
  tsDirective:
    '@ts-ignore, @ts-expect-error and @ts-nocheck hide type errors. Fix the type instead: narrow with a type guard, validate external data at the boundary, or correct the declaration. See docs/code-guidelines.md, section 型別.',
} as const;

type MessageId = keyof typeof MESSAGES;
type TreeNode = Node & { parent?: TreeNode };

const MEMBER_TYPES = new Set([
  'TSPropertySignature',
  'TSMethodSignature',
  'TSIndexSignature',
  'TSCallSignatureDeclaration',
  'TSConstructSignatureDeclaration',
  'PropertyDefinition',
  'MethodDefinition',
  'AccessorProperty',
  'TSAbstractPropertyDefinition',
  'TSAbstractMethodDefinition',
  'TSAbstractAccessorProperty',
  'TSEnumMember',
  'Property',
]);
const CONTAINER_TYPES = new Set([
  'TSInterfaceBody',
  'TSInterfaceDeclaration',
  'TSTypeLiteral',
  'TSTypeAnnotation',
  'TSTypeAliasDeclaration',
  'TSUnionType',
  'TSIntersectionType',
  'ClassBody',
  'ClassDeclaration',
  'TSEnumBody',
  'TSEnumDeclaration',
  'ObjectExpression',
  'VariableDeclarator',
  'VariableDeclaration',
  'TSAsExpression',
  'TSSatisfiesExpression',
]);
const EXPORT_DECLARATIONS = new Set(['ExportNamedDeclaration', 'ExportDefaultDeclaration']);

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const publicFilesByRoot = new Map<string, Set<string>>();

function entryFiles(root: string): string[] {
  return LAYERS.filter((layer) => layer.folder !== 'shared').flatMap((layer) => {
    const layerDirectory = path.join(root, 'src', layer.folder);
    if (!existsSync(layerDirectory)) return [];
    return readdirSync(layerDirectory, { withFileTypes: true })
      .filter((module) => module.isDirectory())
      .flatMap((module) => ENTRIES.map((entry) => `src/${layer.folder}/${module.name}/${entry.file}`))
      .filter((file) => existsSync(path.join(root, file)));
  });
}

function publicFiles(root: string): Set<string> {
  const cached = publicFilesByRoot.get(root);
  if (cached) return cached;
  const found = new Set<string>();
  const pending = entryFiles(root);
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (found.has(file)) continue;
    found.add(file);
    for (const edge of importsOf(file, root)) {
      if (edge.reExport && edge.target && existsSync(path.join(root, edge.target))) pending.push(edge.target);
    }
  }
  publicFilesByRoot.set(root, found);
  return found;
}

export function isPublicFile(root: string, file: string): boolean {
  const relative = path.relative(root, file).split(path.sep).join('/');
  if (moduleOf(relative) === 'shared') return true;
  return publicFiles(root).has(relative);
}

function isLicenseHeader(comment: Comment, sourceCode: SourceCode): boolean {
  const firstToken = sourceCode.ast.tokens[0];
  const beforeCode = !firstToken || (comment.range?.[1] ?? 0) <= firstToken.range[0];
  return beforeCode && LICENSE_PATTERN.test(comment.value);
}

function isDocComment(comment: Comment): boolean {
  return comment.type === 'Block' && comment.value.startsWith('*');
}

function isHiddenClassMember(node: TreeNode): boolean {
  const member = node as TreeNode & { accessibility?: string; key?: { type: string } };
  return member.accessibility === 'private' || member.accessibility === 'protected' || member.key?.type === 'PrivateIdentifier';
}

function documentedNode(comment: Comment, sourceCode: SourceCode): TreeNode | null {
  const start = sourceCode.getTokenAfter(comment, { includeComments: true })?.range?.[0];
  if (start === undefined) return null;
  let node = sourceCode.getNodeByRangeIndex(start) as TreeNode | null;
  while (node?.parent && node.parent.type !== 'Program' && node.parent.range?.[0] === start) node = node.parent;
  return node;
}

function documentsPublicDeclaration(comment: Comment, sourceCode: SourceCode): boolean {
  const node = documentedNode(comment, sourceCode);
  if (!node) return false;
  if (EXPORT_DECLARATIONS.has(node.type)) return node.parent?.type === 'Program';
  if (!MEMBER_TYPES.has(node.type)) return false;
  for (let current: TreeNode | undefined = node; current; current = current.parent) {
    if (EXPORT_DECLARATIONS.has(current.type)) return current.parent?.type === 'Program';
    if (MEMBER_TYPES.has(current.type) && isHiddenClassMember(current)) return false;
    if (!MEMBER_TYPES.has(current.type) && !CONTAINER_TYPES.has(current.type)) return false;
  }
  return false;
}

function startsItsLine(comment: Comment, sourceCode: SourceCode): boolean {
  const start = comment.loc?.start;
  return start !== undefined && sourceCode.lines[start.line - 1]!.slice(0, start.column).trim() === '';
}

function continuesExternalComment(comment: Comment, previous: Comment | undefined, sourceCode: SourceCode): boolean {
  if (previous?.type !== 'Line' || !previous.loc || !comment.loc) return false;
  const adjacent = comment.loc.start.line === previous.loc.end.line + 1;
  return adjacent && startsItsLine(previous, sourceCode) && startsItsLine(comment, sourceCode);
}

export const commentPolicy: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Allow only license headers, doc comments on public declarations, `// External:` comments and tool directives' },
    messages: MESSAGES,
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const publicFile = isPublicFile(REPO_ROOT, context.filename);
    const externalRuns = new Set<Comment>();

    function violation(comment: Comment, previous: Comment | undefined): MessageId | null {
      if (TS_DIRECTIVE_PATTERN.test(comment.value)) return 'tsDirective';
      if (LINT_DIRECTIVE_PATTERN.test(comment.value)) return 'lintDirective';
      if (TOOL_DIRECTIVE_PATTERN.test(comment.value)) return null;
      if (comment.type === 'Line' && TRIPLE_SLASH_PATTERN.test(comment.value)) return null;
      if (isLicenseHeader(comment, sourceCode)) return null;
      if (isDocComment(comment)) return publicFile && documentsPublicDeclaration(comment, sourceCode) ? null : 'docComment';
      if (comment.type === 'Line' && EXTERNAL_PATTERN.test(comment.value)) {
        externalRuns.add(comment);
        return null;
      }
      if (previous && externalRuns.has(previous) && continuesExternalComment(comment, previous, sourceCode)) {
        externalRuns.add(comment);
        return null;
      }
      return 'comment';
    }

    return {
      'Program:exit'() {
        let previous: Comment | undefined;
        for (const comment of sourceCode.getAllComments()) {
          const messageId = violation(comment, previous);
          if (messageId && comment.loc) context.report({ loc: comment.loc, messageId });
          previous = comment;
        }
      },
    };
  },
};
