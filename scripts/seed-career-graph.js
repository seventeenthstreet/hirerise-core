#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const CONFIG = Object.freeze({
  supabaseUrl: process.env.SUPABASE_URL?.trim(),
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  graphDataDir:
    process.env.GRAPH_DATA_DIR?.trim() ||
    path.resolve(process.cwd(), 'src', 'data', 'career-graph'),
  chunkSize: Math.max(
    1,
    Number.parseInt(process.env.SEED_CHUNK_SIZE || '500', 10),
  ),
  dryRun: process.argv.includes('--dry-run'),
  rollback: process.argv.includes('--rollback'),
  failFast: process.argv.includes('--fail-fast'),
});

function log(level, message, meta = null) {
  const ts = new Date().toISOString();
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';

  const fn =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : console.log;

  fn(`[${ts}] [${level.toUpperCase()}] ${message}${suffix}`);
}

function validateEnv() {
  const missing = [];

  if (!CONFIG.supabaseUrl) missing.push('SUPABASE_URL');
  if (!CONFIG.supabaseKey) {
    missing.push('SUPABASE_SERVICE_ROLE_KEY');
  }

  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(', ')}`);
  }
}

function buildClient() {
  return createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function toSlug(str = '') {
  return String(str)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function safeReadJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function discoverRoleFiles(dir) {
  const files = [];

  async function walk(current) {
    const entries = await fs.readdir(current, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.json') &&
        entry.name !== 'skills_registry.json' &&
        entry.name !== 'role_transitions.json'
      ) {
        files.push(full);
      }
    }
  }

  await walk(dir);
  return files;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function batchUpsert(
  supabase,
  table,
  rows,
  conflictCols,
) {
  const stats = {
    attempted: rows.length,
    upserted: 0,
    errorCount: 0,
  };

  if (!rows.length) {
    log('info', `[${table}] No rows — skipping`);
    return stats;
  }

  const batches = chunk(rows, CONFIG.chunkSize);

  log(
    'info',
    `[${table}] Upserting ${rows.length} rows in ${batches.length} batch(es)`,
  );

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    if (CONFIG.dryRun) {
      log(
        'info',
        `[DRY-RUN] [${table}] Batch ${i + 1}/${batches.length}`,
        { rows: batch.length },
      );
      stats.upserted += batch.length;
      continue;
    }

    const { error } = await supabase.from(table).upsert(batch, {
      onConflict: conflictCols.join(','),
      ignoreDuplicates: false,
      returning: 'minimal',
    });

    if (error) {
      stats.errorCount++;

      log(
        'error',
        `[${table}] Batch ${i + 1}/${batches.length} FAILED`,
        {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint,
          sample: batch.slice(0, 2),
        },
      );

      if (CONFIG.failFast) {
        throw error;
      }
    } else {
      stats.upserted += batch.length;
    }
  }

  return stats;
}