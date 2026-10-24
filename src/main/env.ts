import path from 'node:path';
import { config } from 'dotenv';

/** Load root development secrets while preserving variables already supplied by the shell. */
export function loadLocalEnv(root = process.cwd()): void {
  config({ path: path.join(root, '.env'), override: false });
}
