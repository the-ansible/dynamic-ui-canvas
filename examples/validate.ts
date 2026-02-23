/**
 * Validation script for example canvas descriptors.
 *
 * Imports the server-side validateDescriptor function and runs it
 * against every JSON file in this directory.
 *
 * Usage: npx tsx examples/validate.ts
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { validateDescriptor } from '../src/server/validation.js';

const examplesDir = dirname(fileURLToPath(import.meta.url));
const jsonFiles = readdirSync(examplesDir)
  .filter(f => f.endsWith('.json'))
  .sort();

let allPassed = true;
let totalFiles = 0;

console.log(`\nValidating ${jsonFiles.length} example canvas descriptors...\n`);

for (const file of jsonFiles) {
  totalFiles++;
  const filePath = join(examplesDir, file);
  const raw = readFileSync(filePath, 'utf-8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.log(`  FAIL  ${file}`);
    console.log(`        JSON parse error: ${(err as Error).message}\n`);
    allPassed = false;
    continue;
  }

  const result = validateDescriptor(parsed);

  if (result.valid) {
    console.log(`  PASS  ${file}`);
  } else {
    console.log(`  FAIL  ${file}`);
    for (const error of result.errors) {
      console.log(`        - ${error}`);
    }
    console.log();
    allPassed = false;
  }
}

console.log(`\n${allPassed ? 'All' : 'Some'} ${totalFiles} files validated.`);

if (!allPassed) {
  console.log('\nValidation FAILED — see errors above.\n');
  process.exit(1);
} else {
  console.log('\nAll examples are valid!\n');
  process.exit(0);
}
