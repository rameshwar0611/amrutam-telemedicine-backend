import { readFile } from 'node:fs/promises';
const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!Array.isArray(report.Results)) throw new Error('Missing image scan results');
const severity = {};
let fixableHighCritical = 0;
for (const result of report.Results) {
  for (const finding of result.Vulnerabilities ?? []) {
    severity[finding.Severity] = (severity[finding.Severity] ?? 0) + 1;
    if (['HIGH', 'CRITICAL'].includes(finding.Severity) && finding.FixedVersion)
      fixableHighCritical++;
  }
}
console.log(JSON.stringify({ severity, fixableHighCritical }, null, 2));
console.log(
  'Unfixed findings remain visible and require security review before deployment. This gate rejects fixable high/critical findings only.',
);
if (fixableHighCritical > 0) process.exitCode = 1;
