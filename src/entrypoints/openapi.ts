import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openApiDocument } from '../infrastructure/openapi/document.js';

const filename = resolve('docs/openapi.json');
const document = `${JSON.stringify(openApiDocument, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if ((await readFile(filename, 'utf8')) !== document)
    throw new Error('Run npm run openapi:generate and commit the updated contract');
} else {
  await mkdir(resolve('docs'), { recursive: true });
  await writeFile(filename, document);
}
