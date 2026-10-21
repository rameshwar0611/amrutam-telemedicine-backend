import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, stat, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const paths = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean)
  .sort();
if (
  paths.some((p) =>
    /(^|\/)(\.env(?!\.example)|node_modules|work|dist|\.terraform)(\/|$)|\.tfstate|\.tfvars$|\.tfplan$|\.dump$/.test(
      p,
    ),
  )
)
  throw new Error('Publication includes a forbidden path');
const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
const url = new URL(remote);
if (url.username || url.password) throw new Error('Remote embeds credentials');
await mkdir('work', { recursive: true });
if (process.argv.includes('--snapshot'))
  await rm('work/submission', { recursive: true, force: true });
let patch = '';
for (const path of paths) {
  if (!(await stat(path)).isFile()) continue;
  const text = await readFile(path, 'utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))
    throw new Error('Literal private key in source');
  const diff = spawnSync('git', ['diff', '--binary', '--no-index', '--', '/dev/null', path], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (![0, 1].includes(diff.status ?? -1)) throw new Error('Complete source diff failed');
  patch += diff.stdout;
  if (process.argv.includes('--snapshot'))
    await cp(path, resolve('work/submission', path), { recursive: true, force: true });
}
await writeFile('work/publication.diff', patch, { mode: 0o600 });
await writeFile(
  'work/publication-status.txt',
  execFileSync('git', ['status', '--porcelain=v1'], { encoding: 'utf8' }),
  { mode: 0o600 },
);
console.log(
  JSON.stringify(
    {
      branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
      remote,
      files: paths.length,
      diff: 'work/publication.diff',
      mutations: 'No index/commit/push changes',
    },
    null,
    2,
  ),
);
