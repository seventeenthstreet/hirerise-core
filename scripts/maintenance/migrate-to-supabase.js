#!/usr/bin/env node
'use strict';

/**
 * migrate-to-supabase.js
 *
 * AST-based migration: Firestore db.collection() → supabase.from()
 *
 * SAFE PATTERNS (auto-converted):
 *   1. db.collection(t).doc(id).get()           → supabase.from(t).select("*").eq("id", id).single()
 *   2. db.collection(t).where(f,"==",v).get()   → supabase.from(t).select("*").eq(f, v)
 *   3. db.collection(t).add(data)               → supabase.from(t).insert(data)
 *   4. db.collection(t).doc(id).update(data)    → supabase.from(t).update(data).eq("id", id)
 *
 * UNSAFE PATTERNS (flagged with TODO comment, NOT touched):
 *   - Multiple .where() chains
 *   - array-contains / not-in / in operators
 *   - Sub-collections  (.collection().doc().collection())
 *   - .set() calls
 *   - .delete() calls
 *   - batch writes / transactions
 *   - .count().get()
 *   - .orderBy() / .limit()
 *   - .doc() with no id (auto-id generation)
 *
 * Usage:
 *   node migrate-to-supabase.js [--dir ./src] [--dry-run] [--verbose]
 */

const fs   = require('fs');
const path = require('path');

// ─── Lazy-load babel tools (installed via npm i --save-dev) ──────────────────
let parser, traverse, generate, t;
try {
  parser   = require('@babel/parser');
  traverse = require('@babel/traverse').default;
  generate = require('@babel/generator').default;
  t        = require('@babel/types');
} catch (e) {
  console.error('❌  Missing deps. Run: npm install --save-dev @babel/parser @babel/traverse @babel/generator @babel/types');
  process.exit(1);
}

// ─── CLI args ────────────────────────────────────────────────────────────────
const argv     = process.argv.slice(2);
const DRY_RUN  = argv.includes('--dry-run');
const VERBOSE  = argv.includes('--verbose');
const dirFlag  = argv.indexOf('--dir');
const ROOT_DIR = dirFlag !== -1 ? argv[dirFlag + 1] : path.join(process.cwd(), 'src');

// ─── Reporting ───────────────────────────────────────────────────────────────
const report = {
  scanned:        0,
  converted:      0,
  flagged:        0,
  skipped:        0,
  filesUpdated:   [],
  filesManual:    [],
  conversions:    [],   // { file, line, from, to }
  flags:          [],   // { file, line, reason, snippet }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Walk a directory recursively and yield .js file paths */
function* walkJs(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'build', '__tests__', 'tests'].includes(entry.name)) continue;
      yield* walkJs(full);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      yield full;
    }
  }
}

/** Stringify a node back to code for logging/comments */
function nodeToCode(node) {
  try { return generate(node, { compact: true }).code; }
  catch (_) { return '<unparseable>'; }
}

/**
 * Detect the "chain" shape of a db.collection(...) call expression.
 * Returns a structured description of what methods are chained.
 */
function describeChain(node) {
  const calls = [];
  let current = node;

  while (t.isCallExpression(current)) {
    const callee = current.callee;
    if (t.isMemberExpression(callee)) {
      calls.unshift({
        method: callee.property.name || callee.property.value,
        args:   current.arguments,
        node:   current,
      });
      current = callee.object;
    } else {
      break;
    }
  }

  // current should now be the db identifier
  const root = current;
  return { root, calls };
}

/**
 * Check whether a node is a db.collection(...) call at the root.
 */
function isDbCollectionRoot(node) {
  return (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    t.isIdentifier(node.callee.property, { name: 'collection' }) &&
    (
      t.isIdentifier(node.callee.object, { name: 'db' }) ||
      (t.isMemberExpression(node.callee.object) &&
        t.isIdentifier(node.callee.object.property, { name: 'db' }))
    )
  );
}

// ─── Supabase node builders ───────────────────────────────────────────────────

/**
 * Build: supabase.from(table).select("*").eq("id", id).single()
 */
function buildSimpleGet(tableArg, idArg) {
  return t.callExpression(
    t.memberExpression(
      t.callExpression(
        t.memberExpression(
          t.callExpression(
            t.memberExpression(
              t.callExpression(
                t.memberExpression(t.identifier('supabase'), t.identifier('from')),
                [tableArg]
              ),
              t.identifier('select')
            ),
            [t.stringLiteral('*')]
          ),
          t.identifier('eq')
        ),
        [t.stringLiteral('id'), idArg]
      ),
      t.identifier('single')
    ),
    []
  );
}

/**
 * Build: supabase.from(table).select("*").eq(field, value)
 */
function buildSimpleWhere(tableArg, fieldArg, valueArg) {
  return t.callExpression(
    t.memberExpression(
      t.callExpression(
        t.memberExpression(
          t.callExpression(
            t.memberExpression(t.identifier('supabase'), t.identifier('from')),
            [tableArg]
          ),
          t.identifier('select')
        ),
        [t.stringLiteral('*')]
      ),
      t.identifier('eq')
    ),
    [fieldArg, valueArg]
  );
}

/**
 * Build: supabase.from(table).insert(data)
 */
function buildInsert(tableArg, dataArg) {
  return t.callExpression(
    t.memberExpression(
      t.callExpression(
        t.memberExpression(t.identifier('supabase'), t.identifier('from')),
        [tableArg]
      ),
      t.identifier('insert')
    ),
    [dataArg]
  );
}

/**
 * Build: supabase.from(table).update(data).eq("id", id)
 */
function buildUpdate(tableArg, dataArg, idArg) {
  return t.callExpression(
    t.memberExpression(
      t.callExpression(
        t.memberExpression(
          t.callExpression(
            t.memberExpression(t.identifier('supabase'), t.identifier('from')),
            [tableArg]
          ),
          t.identifier('update')
        ),
        [dataArg]
      ),
      t.identifier('eq')
    ),
    [t.stringLiteral('id'), idArg]
  );
}

// ─── Core analyser ───────────────────────────────────────────────────────────

/**
 * Attempt to classify the chain and return either:
 *   { type: 'safe', replacement: ASTNode, description: string }
 *   { type: 'unsafe', reason: string }
 *   { type: 'unknown' }
 */
function classifyChain(node) {
  const { calls } = describeChain(node);
  if (!calls.length) return { type: 'unknown' };

  const methods = calls.map(c => c.method);

  // Detect sub-collection: collection → doc → collection
  if (methods.filter(m => m === 'collection').length > 1) {
    return { type: 'unsafe', reason: 'sub-collection detected' };
  }

  // Detect transactions / batch
  if (methods.includes('runTransaction') || methods.includes('batch')) {
    return { type: 'unsafe', reason: 'transaction/batch detected' };
  }

  const tableArg = calls[0].args[0]; // first arg to .collection(...)

  // ── Pattern: .doc(id).get() ──────────────────────────────────────────────
  if (methods[0] === 'collection' && methods[1] === 'doc' && methods[2] === 'get') {
    if (calls[1].args.length === 0) {
      return { type: 'unsafe', reason: '.doc() with no id (auto-id)' };
    }
    const idArg = calls[1].args[0];
    const replacement = buildSimpleGet(tableArg, idArg);
    return {
      type: 'safe',
      replacement,
      description: `collection(...).doc(...).get() → supabase.from(...).select("*").eq("id",...).single()`,
    };
  }

  // ── Pattern: .doc(id).update(data) ──────────────────────────────────────
  if (methods[0] === 'collection' && methods[1] === 'doc' && methods[2] === 'update') {
    if (calls[1].args.length === 0) {
      return { type: 'unsafe', reason: '.doc() with no id (auto-id)' };
    }
    const idArg   = calls[1].args[0];
    const dataArg = calls[2].args[0];
    if (!dataArg) return { type: 'unsafe', reason: '.update() missing data argument' };
    const replacement = buildUpdate(tableArg, dataArg, idArg);
    return {
      type: 'safe',
      replacement,
      description: `collection(...).doc(...).update(...) → supabase.from(...).update(...).eq("id",...)`,
    };
  }

  // ── Pattern: .add(data) ──────────────────────────────────────────────────
  if (methods[0] === 'collection' && methods[1] === 'add') {
    const dataArg = calls[1].args[0];
    if (!dataArg) return { type: 'unsafe', reason: '.add() missing data argument' };
    const replacement = buildInsert(tableArg, dataArg);
    return {
      type: 'safe',
      replacement,
      description: `collection(...).add(...) → supabase.from(...).insert(...)`,
    };
  }

  // ── Pattern: single .where(field, "==", value).get() ────────────────────
  if (
    methods[0] === 'collection' &&
    methods[1] === 'where' &&
    methods[2] === 'get' &&
    methods.length === 3
  ) {
    const whereArgs = calls[1].args;
    if (whereArgs.length !== 3) {
      return { type: 'unsafe', reason: '.where() unexpected argument count' };
    }
    const [fieldArg, opArg, valueArg] = whereArgs;

    // Only handle "==" safely; other ops need manual review
    const op = t.isStringLiteral(opArg) ? opArg.value : null;
    if (op !== '==') {
      return { type: 'unsafe', reason: `where() with operator "${op}" – non-== operators need manual review` };
    }

    const replacement = buildSimpleWhere(tableArg, fieldArg, valueArg);
    return {
      type: 'safe',
      replacement,
      description: `collection(...).where(f,"==",v).get() → supabase.from(...).select("*").eq(f,v)`,
    };
  }

  // ── Everything else is unsafe ────────────────────────────────────────────

  // Multiple where chains
  if (methods.filter(m => m === 'where').length > 1) {
    return { type: 'unsafe', reason: 'multiple .where() chains' };
  }

  // .set() (upsert — needs manual schema knowledge)
  if (methods.includes('set')) {
    return { type: 'unsafe', reason: '.set() requires manual upsert/insert decision' };
  }

  // .delete()
  if (methods.includes('delete')) {
    return { type: 'unsafe', reason: '.delete() requires manual review' };
  }

  // .count()
  if (methods.includes('count')) {
    return { type: 'unsafe', reason: '.count() needs Supabase { count: "exact", head: true }' };
  }

  // .orderBy() / .limit()
  if (methods.includes('orderBy') || methods.includes('limit')) {
    return { type: 'unsafe', reason: '.orderBy()/.limit() chains need manual port' };
  }

  // array-contains and other operators inside a single where
  if (methods.includes('where')) {
    const whereArgs = (calls.find(c => c.method === 'where') || {}).args || [];
    const op = whereArgs[1] && t.isStringLiteral(whereArgs[1]) ? whereArgs[1].value : '';
    if (['array-contains', 'array-contains-any', 'in', 'not-in'].includes(op)) {
      return { type: 'unsafe', reason: `where() with "${op}" operator` };
    }
  }

  return { type: 'unsafe', reason: `unrecognised chain: ${methods.join('.')}` };
}

// ─── Per-file processor ───────────────────────────────────────────────────────

function processFile(filePath) {
  const rel     = path.relative(process.cwd(), filePath);
  const source  = fs.readFileSync(filePath, 'utf8');
  let ast;

  try {
    ast = parser.parse(source, {
      sourceType: 'unambiguous',
      plugins: ['optionalChaining', 'nullishCoalescingOperator'],
      allowReturnOutsideFunction: true,
    });
  } catch (err) {
    if (VERBOSE) console.warn(`  ⚠️  Parse error in ${rel}: ${err.message}`);
    report.skipped++;
    return;
  }

  report.scanned++;

  let fileConverted = 0;
  let fileFlagged   = 0;
  const commentMap  = new Map(); // nodeStart → comment string

  traverse(ast, {
    CallExpression(nodePath) {
      const node = nodePath.node;

      // We only care about the OUTERMOST db.collection(...) chain,
      // i.e. the node that is the deepest db.collection call at the root.
      // We detect this by checking whether the parent is NOT also a
      // MemberExpression that's part of the same chain.
      const parent = nodePath.parent;
      const isPartOfLargerChain =
        t.isMemberExpression(parent) &&
        parent.object === node;

      if (isPartOfLargerChain) return;   // skip intermediate nodes

      // Walk down to find the db.collection root
      let root = node;
      while (
        t.isCallExpression(root) &&
        t.isMemberExpression(root.callee) &&
        !isDbCollectionRoot(root)
      ) {
        root = root.callee.object;
      }

      if (!isDbCollectionRoot(root)) return;

      const line    = node.loc ? node.loc.start.line : '?';
      const snippet = nodeToCode(node).slice(0, 120);

      const result = classifyChain(node);

      if (result.type === 'safe') {
        // Replace the node
        nodePath.replaceWith(result.replacement);
        fileConverted++;
        report.converted++;
        report.conversions.push({ file: rel, line, description: result.description, from: snippet });
        if (VERBOSE) console.log(`  ✅  ${rel}:${line} → ${result.description}`);

      } else if (result.type === 'unsafe') {
        // Add a leading comment to the statement containing this node
        const stmtPath = nodePath.findParent(p => p.isStatement());
        if (stmtPath) {
          const commentText = ` TODO: MANUAL MIGRATION REQUIRED — ${result.reason}`;
          // Avoid duplicate comments
          const existing = (stmtPath.node.leadingComments || []).map(c => c.value);
          if (!existing.some(c => c.includes('MANUAL MIGRATION'))) {
            t.addComment(stmtPath.node, 'leading', commentText, true);
          }
        }
        fileFlagged++;
        report.flagged++;
        report.flags.push({ file: rel, line, reason: result.reason, snippet });
        if (VERBOSE) console.log(`  ⚠️  ${rel}:${line} FLAGGED — ${result.reason}`);
      }
    },
  });

  if (fileConverted > 0 || fileFlagged > 0) {
    const newSource = generate(ast, {
      retainLines:   false,
      concise:       false,
      comments:      true,
      jsescOption:   { minimal: true },
    }, source).code;

    if (!DRY_RUN && fileConverted > 0) {
      // Write backup first
      fs.writeFileSync(filePath + '.bak', source, 'utf8');
      fs.writeFileSync(filePath, newSource, 'utf8');
    } else if (!DRY_RUN && fileFlagged > 0) {
      // Write with added TODO comments even if nothing was auto-converted
      fs.writeFileSync(filePath + '.bak', source, 'utf8');
      fs.writeFileSync(filePath, newSource, 'utf8');
    }

    if (fileConverted > 0) report.filesUpdated.push({ file: rel, converted: fileConverted, flagged: fileFlagged });
    if (fileFlagged  > 0) {
      if (!report.filesManual.find(f => f.file === rel)) {
        report.filesManual.push({ file: rel, flagged: fileFlagged, converted: fileConverted });
      }
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(ROOT_DIR)) {
    console.error(`❌  Directory not found: ${ROOT_DIR}`);
    process.exit(1);
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║       Firestore → Supabase  AST Migration Script            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Root  : ${ROOT_DIR}`);
  console.log(`  Mode  : ${DRY_RUN ? '🔍  DRY RUN (no files written)' : '✍️   LIVE (files will be modified + .bak created)'}`);
  console.log('');

  for (const filePath of walkJs(ROOT_DIR)) {
    processFile(filePath);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Files scanned        : ${report.scanned}`);
  console.log(`  Files skipped (parse): ${report.skipped}`);
  console.log(`  Calls auto-converted : ${report.converted}`);
  console.log(`  Calls flagged manual : ${report.flagged}`);
  console.log('');

  if (report.filesUpdated.length) {
    console.log('  ✅  Auto-converted files:');
    for (const f of report.filesUpdated) {
      console.log(`      ${f.file}  (${f.converted} converted, ${f.flagged} flagged)`);
    }
    console.log('');
  }

  if (report.filesManual.length) {
    console.log('  ⚠️  Files requiring manual work:');
    for (const f of report.filesManual) {
      console.log(`      ${f.file}  (${f.flagged} TODO comments added)`);
    }
    console.log('');
  }

  // Write full JSON report
  const reportPath = path.join(process.cwd(), 'migration-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`  📄  Full report written to: ${reportPath}`);
  console.log('');

  if (!DRY_RUN) {
    console.log('  💾  Backups created as <filename>.js.bak');
    console.log('  ↩️   To rollback: node migrate-to-supabase.js --rollback');
  }
  console.log('');
}

// ─── Rollback mode ────────────────────────────────────────────────────────────
if (argv.includes('--rollback')) {
  console.log('↩️  Rolling back from .bak files...');
  let rolled = 0;
  for (const filePath of walkJs(ROOT_DIR || path.join(process.cwd(), 'src'))) {
    const bak = filePath + '.bak';
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, filePath);
      fs.unlinkSync(bak);
      rolled++;
      if (VERBOSE) console.log(`  restored: ${filePath}`);
    }
  }
  console.log(`  ✅  Rolled back ${rolled} file(s).`);
  process.exit(0);
}

main();