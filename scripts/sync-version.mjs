import { readFile, writeFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const apiUrl = new URL('../src/api.ts', import.meta.url);
const source = await readFile(apiUrl, 'utf8');
const updated = source.replace(
  /export const VERSION = '[^']+';/,
  `export const VERSION = '${packageJson.version}';`,
);

if (updated === source && !source.includes(`export const VERSION = '${packageJson.version}';`)) {
  throw new Error('Could not update VERSION in src/api.ts');
}

if (updated !== source) await writeFile(apiUrl, updated);
