/**
 * THE COMPILE-TIME HALF OF TENANT ISOLATION, run as a unit test.
 *
 * `findUnique({ where: { id } })` on a scoped model compiles and reaches every operator's rows. That
 * one shape let an operator's staff reset another operator's passwords, add their own wallet to
 * another operator's deposit rotation, rewrite its payment methods and stream its players'
 * receipts. The tenant-scope extension now pins such a selector at runtime, but a runtime rescue is
 * the second line: this spec makes the FIRST line — every call site naming its operator — a failing
 * test instead of a review comment.
 *
 * It parses every non-spec file under src with the TypeScript compiler and checks two shapes:
 *   <client>.<scopedDelegate>.<findUnique|findUniqueOrThrow|update|delete|upsert>({ where: ... })
 *   this._findUnique(...) / this._update(...) in a BaseRepository whose modelName is scoped
 * The selector must be an object literal naming `tenantId` (directly or through a `tenantId_*`
 * composite key), or an `acrossTenants(...)` call — the deliberate, greppable cross-operator form a
 * worker uses before it has read the row that names its operator. Anything else, including a
 * selector built elsewhere and passed in by name, fails: the check cannot see inside it, so neither
 * can a reviewer.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import * as ts from 'typescript';

import { TENANT_SCOPED_MODELS, UNIQUE_OPERATIONS } from './tenant-scope.extension';

interface Finding {
  readonly location: string;
  readonly code: string;
  readonly reason: string;
}

interface ScanResult {
  readonly checked: number;
  readonly findings: Finding[];
}

const SRC_ROOT = join(__dirname, '..', '..');

const lowerFirst = (value: string): string => value.charAt(0).toLowerCase() + value.slice(1);

/** `paymentMethod`, `depositRequest`, … — the delegate names of the scoped models. */
const SCOPED_DELEGATES: ReadonlySet<string> = new Set([...TENANT_SCOPED_MODELS].map(lowerFirst));

const REPOSITORY_HELPERS: ReadonlySet<string> = new Set(['_findUnique', '_update']);

function propertyName(node: ts.ObjectLiteralElementLike): string | null {
  if (ts.isShorthandPropertyAssignment(node)) return node.name.text;
  if (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) {
    const name = node.name;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  }
  return null;
}

/** Why this selector is not provably pinned, or null when it is. */
function selectorProblem(selector: ts.Expression): string | null {
  const unwrapped = ts.isParenthesizedExpression(selector) ? selector.expression : selector;

  if (
    ts.isCallExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    unwrapped.expression.text === 'acrossTenants'
  ) {
    return null;
  }
  if (!ts.isObjectLiteralExpression(unwrapped)) {
    return 'the selector is not an object literal, so its tenant cannot be checked here';
  }
  const names = unwrapped.properties.map(propertyName);
  if (names.some((name) => name === 'tenantId' || (name?.startsWith('tenantId_') ?? false))) {
    return null;
  }
  return 'the selector names no tenant';
}

/** The `where` of a Prisma call's first argument, or a reason it cannot be found. */
function whereOf(args: ts.NodeArray<ts.Expression>): ts.Expression | string {
  const first = args[0];
  if (first === undefined || !ts.isObjectLiteralExpression(first)) {
    return 'the arguments are not an object literal, so the selector cannot be checked here';
  }
  for (const property of first.properties) {
    if (propertyName(property) !== 'where') continue;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    return 'the selector is passed by name, so its tenant cannot be checked here';
  }
  return 'the call has no where';
}

/** The `modelName = '…'` a BaseRepository subclass declares, if this file has one. */
function repositoryModel(sourceFile: ts.SourceFile): string | null {
  let model: string | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'modelName' &&
      node.initializer !== undefined &&
      ts.isStringLiteral(node.initializer)
    ) {
      model = node.initializer.text;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return model;
}

export function scanSource(fileName: string, text: string): ScanResult {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const scopedRepository = TENANT_SCOPED_MODELS.has(repositoryModel(sourceFile) ?? '');
  const findings: Finding[] = [];
  let checked = 0;

  const report = (node: ts.Node, reason: string): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      location: `${fileName}:${String(line + 1)}`,
      code: node.getText(sourceFile).split('\n')[0] ?? '',
      reason,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const operation = node.expression.name.text;
      const receiver = node.expression.expression;

      // <client>.<scopedDelegate>.<uniqueOperation>(...)
      if (
        UNIQUE_OPERATIONS.has(operation) &&
        ts.isPropertyAccessExpression(receiver) &&
        SCOPED_DELEGATES.has(receiver.name.text)
      ) {
        checked += 1;
        const where = whereOf(node.arguments);
        const problem = typeof where === 'string' ? where : selectorProblem(where);
        if (problem !== null) report(node, problem);
      }

      // this._findUnique(where, tx) / this._update(where, data, tx) in a scoped repository
      if (
        scopedRepository &&
        REPOSITORY_HELPERS.has(operation) &&
        receiver.kind === ts.SyntaxKind.ThisKeyword
      ) {
        checked += 1;
        const selector = node.arguments[0];
        const problem =
          selector === undefined ? 'the helper is called without a selector' : selectorProblem(selector);
        if (problem !== null) report(node, problem);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { checked, findings };
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(path);
    }
  }
  return files;
}

describe('tenant pinning of unique selectors (source guard)', () => {
  it('names a tenant in every unique selector on a scoped model under src', () => {
    let checked = 0;
    const findings: Finding[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const result = scanSource(relative(SRC_ROOT, file).split(sep).join('/'), readFileSync(file, 'utf8'));
      checked += result.checked;
      findings.push(...result.findings);
    }

    // Not vacuous: the codebase has dozens of these, and a scanner that found none would pass
    // while checking nothing.
    expect(checked).toBeGreaterThan(40);
    expect(findings.map((finding) => `${finding.location}  ${finding.reason}  ${finding.code}`)).toEqual(
      [],
    );
  });

  describe('the scanner itself', () => {
    const scan = (text: string): ScanResult => scanSource('probe.ts', text);

    it('flags a bare id on a scoped delegate, and a selector it cannot see into', () => {
      expect(scan('prisma.paymentMethod.findUnique({ where: { id } });').findings).toHaveLength(1);
      expect(scan('tx.depositRequest.update({ where: { id: x }, data });').findings).toHaveLength(1);
      expect(scan('tx.depositProof.delete({ where });').findings).toHaveLength(1);
      expect(scan('tx.player.upsert(args);').findings).toHaveLength(1);
    });

    it('accepts a tenant, a composite tenant key, and acrossTenants()', () => {
      const result = scan(
        [
          'prisma.paymentMethod.findUnique({ where: { id, tenantId } });',
          'tx.depositRequest.update({ where: { id, tenantId: t }, data });',
          'prisma.player.findUnique({ where: { tenantId_telegramUserId: { tenantId, telegramUserId } } });',
          'prisma.depositRequest.findUnique({ where: acrossTenants({ id }) });',
        ].join('\n'),
      );
      expect(result).toEqual({ checked: 4, findings: [] });
    });

    it('ignores models that carry no tenant', () => {
      expect(scan('prisma.tenant.findUnique({ where: { id } });')).toEqual({ checked: 0, findings: [] });
    });

    it('checks the BaseRepository helpers only in a repository of a scoped model', () => {
      const scoped = [
        "class R { protected readonly modelName = 'PaymentDestination';",
        '  a() { return this._findUnique({ id }); }',
        '  b() { return this._update({ id, tenantId }, data); } }',
      ].join('\n');
      expect(scan(scoped).findings.map((finding) => finding.code)).toEqual([
        'this._findUnique({ id })',
      ]);

      const unscoped = "class R { protected readonly modelName = 'Currency'; a() { return this._findUnique({ code }); } }";
      expect(scan(unscoped)).toEqual({ checked: 0, findings: [] });
    });
  });
});
