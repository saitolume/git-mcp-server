#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { API } from "typescript/unstable/sync";
import {
  SyntaxKind,
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
} from "typescript/unstable/ast";

const EXPECTED_DEPENDENCIES = {
  "@modelcontextprotocol/server": "2.0.0-beta.4",
  zod: "4.4.3",
};
const FORBIDDEN_RUNTIME_FIELDS = [
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies",
];

function hasEntries(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== false && value !== "";
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if ([".ts", ".tsx", ".mts", ".cts"].includes(extname(entry.name)) && !entry.name.endsWith(".d.ts")) {
      files.push(path);
    }
  }
  return files;
}

function externalPackageRoot(specifier) {
  if (specifier.startsWith("node:") || specifier.startsWith(".")) return undefined;
  if (specifier.startsWith("/")) return specifier;
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/", 1)[0];
}

function stringLiteralArgument(node) {
  return node && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

function moduleSpecifiers(sourceFile) {
  const specifiers = [];
  function visit(node) {
    if ((isImportDeclaration(node) || isExportDeclaration(node)) && node.moduleSpecifier) {
      const value = stringLiteralArgument(node.moduleSpecifier);
      if (value !== undefined) specifiers.push(value);
    } else if (isImportEqualsDeclaration(node)
      && isExternalModuleReference(node.moduleReference)) {
      const value = stringLiteralArgument(node.moduleReference.expression);
      if (value !== undefined) specifiers.push(value);
    } else if (isCallExpression(node)) {
      const dynamicImport = node.expression.kind === SyntaxKind.ImportKeyword;
      const commonJsRequire = isIdentifier(node.expression) && node.expression.text === "require";
      if (dynamicImport || commonJsRequire) {
        const value = stringLiteralArgument(node.arguments[0]);
        if (value !== undefined) specifiers.push(value);
      }
    }
    node.forEachChild(visit);
  }
  visit(sourceFile);
  return specifiers;
}

async function main() {
  const root = resolve(process.argv[2] ?? process.cwd());
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const dependencyEntries = Object.entries(manifest.dependencies ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const expectedEntries = Object.entries(EXPECTED_DEPENDENCIES).sort(([left], [right]) => left.localeCompare(right));
  if (JSON.stringify(dependencyEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error(`dependencies must exactly equal ${JSON.stringify(EXPECTED_DEPENDENCIES)}`);
  }
  for (const field of FORBIDDEN_RUNTIME_FIELDS) {
    if (hasEntries(manifest[field])) throw new Error(`${field} must be empty or absent`);
  }

  const declared = new Set(Object.keys(manifest.dependencies));
  const files = await sourceFiles(join(root, "src"));
  const api = new API({ cwd: root });
  try {
    const snapshot = api.updateSnapshot({ openFiles: files });
    for (const file of files) {
      const project = snapshot.getDefaultProjectForFile(file);
      const sourceFile = project?.program.getSourceFile(file);
      if (!project || !sourceFile) throw new Error(`could not parse ${relative(root, file)} for runtime imports`);
      if (project.program.getSyntacticDiagnostics(file).length > 0) {
        throw new Error(`could not parse ${relative(root, file)} for runtime imports`);
      }
      for (const specifier of moduleSpecifiers(sourceFile)) {
        const packageRoot = externalPackageRoot(specifier);
        if (packageRoot && !declared.has(packageRoot)) {
          throw new Error(`${packageRoot} imported by ${relative(root, file)} is not declared in dependencies`);
        }
      }
    }
  } finally {
    api.close();
  }
  process.stdout.write(`runtime dependency policy passed for ${files.length} source files\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
