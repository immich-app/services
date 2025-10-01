#!/usr/bin/env ts-node

/**
 * Script to convert product key CSV files into SQL INSERT statements
 *
 * Usage:
 *   ts-node scripts/import-product-keys.ts client-keys.csv server-keys.csv
 *
 * CSV Format:
 *   license_key,activation_key
 *   IMSV-...,IYiqy7A_...
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

interface ProductKey {
  keyValue: string;
  activationKey: string;
  keyType: 'client' | 'server';
}

function parseCSV(filePath: string, keyType: 'client' | 'server'): ProductKey[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n');

  // Skip header row if it exists
  const startIndex = lines[0].toLowerCase().includes('license') || lines[0].toLowerCase().includes('key') ? 1 : 0;

  const keys: ProductKey[] = [];

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    const [keyValue, activationKey] = line.split(',').map(s => s.trim());

    if (!keyValue || !activationKey) {
      console.error(`[WARN] Skipping invalid line ${i + 1}: ${line}`);
      continue;
    }

    keys.push({
      keyValue,
      activationKey,
      keyType,
    });
  }

  return keys;
}

function escapeSQL(value: string): string {
  // Escape single quotes in SQL by doubling them
  return value.replaceAll("'", "''");
}

function generateInsertStatements(keys: ProductKey[]): string {
  if (keys.length === 0) {
    return '-- No keys to insert';
  }

  const timestamp = new Date().toISOString();
  const statements: string[] = [];

  for (const key of keys) {
    const statement = `INSERT INTO product_keys (key_value, activation_key, key_type, is_claimed, created_at) VALUES ('${escapeSQL(key.keyValue)}', '${escapeSQL(key.activationKey)}', '${key.keyType}', FALSE, '${timestamp}');`;
    statements.push(statement);
  }

  return statements.join('\n');
}

function main() {
  const args = process.argv.slice(2);

  if (args.length !== 2) {
    console.error('Usage: ts-node scripts/import-product-keys.ts <client-keys.csv> <server-keys.csv>');
    console.error('');
    console.error('CSV Format:');
    console.error('  license_key,activation_key');
    console.error('  IMSV-V9W4-CVV5-6VE3-9G6U-RFUA-P747-39DM-3Q74,IYiqy7A_GzS3ybBDAKDXX...');
    process.exit(1);
  }

  const [clientKeysPath, serverKeysPath] = args;

  // Verify files exist
  if (!fs.existsSync(clientKeysPath)) {
    console.error(`[ERROR] Client keys file not found: ${clientKeysPath}`);
    process.exit(1);
  }

  if (!fs.existsSync(serverKeysPath)) {
    console.error(`[ERROR] Server keys file not found: ${serverKeysPath}`);
    process.exit(1);
  }

  console.log('[INFO] Parsing CSV files...');

  // Parse CSV files
  const clientKeys = parseCSV(clientKeysPath, 'client');
  const serverKeys = parseCSV(serverKeysPath, 'server');

  console.log(`[INFO] Found ${clientKeys.length} client keys`);
  console.log(`[INFO] Found ${serverKeys.length} server keys`);

  // Combine all keys
  const allKeys = [...clientKeys, ...serverKeys];

  if (allKeys.length === 0) {
    console.error('[ERROR] No valid keys found in CSV files');
    process.exit(1);
  }

  console.log(`[INFO] Total keys: ${allKeys.length}`);
  console.log('[INFO] Generating SQL INSERT statements...');

  // Generate SQL for client keys
  const clientSql = generateInsertStatements(clientKeys);
  const clientOutputPath = path.join(process.cwd(), 'client-keys-import.sql');
  fs.writeFileSync(clientOutputPath, clientSql, 'utf8');
  console.log(`[SUCCESS] Client keys SQL written to: ${clientOutputPath}`);

  // Generate SQL for server keys
  const serverSql = generateInsertStatements(serverKeys);
  const serverOutputPath = path.join(process.cwd(), 'server-keys-import.sql');
  fs.writeFileSync(serverOutputPath, serverSql, 'utf8');
  console.log(`[SUCCESS] Server keys SQL written to: ${serverOutputPath}`);

  console.log('');
  console.log('To import into D1 database:');
  console.log('  wrangler d1 execute DB --file=client-keys-import.sql');
  console.log('  wrangler d1 execute DB --file=server-keys-import.sql');
  console.log('');
  console.log('Or copy the SQL and run it in the Cloudflare dashboard.');
}

main();
