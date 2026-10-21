import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import { loadDatabaseConfig } from '../infrastructure/config/env.js';
import { loadSecurityConfig } from '../infrastructure/config/security-env.js';
import { createDatabase, createPool } from '../infrastructure/database/client.js';
import { composeIdentityCore } from '../composition-root.js';
import { provisionSchema } from '../modules/identity/schemas.js';

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      'user-id': { type: 'string' },
      output: { type: 'string' },
    },
  });
  const database = createDatabase(createPool(loadDatabaseConfig()));
  try {
    const core = composeIdentityCore(database, loadSecurityConfig());
    const requestId = randomUUID();
    if (positionals[0] === 'bootstrap-admin') {
      const result = await core.accounts.bootstrap(
        provisionSchema.parse({ email: values.email, displayName: values.name, role: 'admin' }),
        { requestId },
      );
      if (result.status !== 201) throw new Error('Bootstrap unavailable');
      process.stdout.write(
        'Initial admin queued for secure account setup. Use the setup-token command with its user ID.\n',
      );
      process.stdout.write(`${JSON.stringify(result.body)}\n`);
    } else if (positionals[0] === 'setup-token') {
      const userId = z.uuid().parse(values['user-id']);
      const output = resolve(z.string().min(1).parse(values.output));
      if (!output.startsWith(resolve('work') + sep))
        throw new Error('Secret output must be under ignored work/');
      const token = await core.work.run(async (repositories) => {
        const setup = await repositories.identity.latestSetup(userId);
        if (!setup || setup.consumed_at || setup.expires_at <= new Date())
          throw new Error('No eligible setup');
        const payload = z
          .object({ tokenEnvelope: z.json() })
          .parse(await repositories.identity.delivery(`setup:${setup.id}`));
        const value = z
          .string()
          .parse(core.secrets.decrypt(payload.tokenEnvelope, `activation:${setup.id}`));
        await repositories.audit.append({
          actorId: null,
          action: 'identity.setup_delivery_exported',
          resourceType: 'user',
          resourceId: userId,
          outcome: 'success',
          requestId,
        });
        return value;
      });
      // Operator explicitly chooses the protected local output. Never print the credential.
      await writeFile(output, `${token}\n`, { mode: 0o600, flag: 'wx' });
      process.stdout.write('Setup credential written to the requested owner-only file.\n');
    } else throw new Error('Unknown command');
  } finally {
    await database.destroy();
  }
}

main().catch(() => {
  process.stderr.write(
    'Operator command failed. Check command arguments, privileges, configuration and setup eligibility.\n',
  );
  process.exitCode = 1;
});
