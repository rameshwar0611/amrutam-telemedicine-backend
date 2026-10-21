import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { phase4Harness } from '../helpers/phase4.js';
const h = phase4Harness();
beforeAll(h.setup);
beforeEach(h.reset);
afterAll(h.close);
const hash = () => randomBytes(32).toString('hex');
async function maintenance(query: string) {
  const c = await h.pool.connect();
  try {
    await c.query('SET ROLE amrutam_maintenance');
    return await c.query<{ result: unknown }>(query);
  } finally {
    await c.query('RESET ROLE');
    c.release();
  }
}
describe('least-privilege operational maintenance', () => {
  it('creates upcoming audit partitions repeatably without changing audit history', async () => {
    const result = await maintenance('SELECT maintain_audit_partitions() AS result');
    expect(result.rows[0]?.result).toMatchObject({ fallback_conflicts: 0 });
    expect(
      (await maintenance('SELECT maintain_audit_partitions() AS result')).rows[0]?.result,
    ).toMatchObject({ created: 0 });
  });
  it('preserves fallback rows and reports conflicts instead of deleting audit data', async () => {
    const name = (
      await h.pool.query<{ name: string }>(
        "SELECT 'audit_logs_'||to_char(date_trunc('month',CURRENT_DATE)+interval '3 months','YYYY_MM') AS name",
      )
    ).rows[0]!.name;
    expect(name).toMatch(/^audit_logs_\d{4}_\d{2}$/);
    await h.pool.query<{ n: number }>(`DROP TABLE IF EXISTS ${name}`);
    await h.pool.query<{ n: number }>(
      "INSERT INTO audit_logs(occurred_at,action,resource_type,outcome) VALUES(date_trunc('month',CURRENT_DATE)+interval '3 months 1 day','test.preserve','user','success')",
    );
    expect(
      (await maintenance('SELECT maintain_audit_partitions() AS result')).rows[0]?.result,
    ).toMatchObject({ fallback_conflicts: 1 });
    expect(await h.count('audit_logs', "action='test.preserve'")).toBe(1);
  });
  it('grants function execution but denies direct security/clinical reads and writes', async () => {
    const c = await h.pool.connect();
    try {
      await c.query('SET ROLE amrutam_maintenance');
      for (const query of [
        'SELECT * FROM users',
        'SELECT * FROM auth_sessions',
        'DELETE FROM consultations WHERE false',
        'DELETE FROM audit_logs WHERE false',
      ])
        await expect(c.query(query)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.query('RESET ROLE');
      c.release();
    }
  });
  it('does not grant cleanup or partition privileges to API and worker identities', async () => {
    const c = await h.pool.connect();
    try {
      for (const role of ['amrutam_api', 'amrutam_worker']) {
        await c.query(`SET ROLE ${role}`);
        await expect(c.query('SELECT cleanup_security_records(1)')).rejects.toMatchObject({
          code: '42501',
        });
        await expect(c.query('SELECT maintain_audit_partitions()')).rejects.toMatchObject({
          code: '42501',
        });
        await c.query('RESET ROLE');
      }
    } finally {
      await c.query('RESET ROLE');
      c.release();
    }
  });
  it('cleans old security data but preserves clinical, audit, active and grace-period records', async () => {
    const doctor = await h.account('doctor');
    const patient = await h.account();
    await h.consultation(doctor, patient);
    const oldToken = randomUUID();
    await h.pool.query<{ n: number }>(
      "INSERT INTO auth_tokens(id,user_id,purpose,token_hash,created_at,expires_at)VALUES($1,$2,'account_setup',$3,now()-interval '10 days',now()-interval '8 days')",
      [oldToken, patient.actor.userId, hash()],
    );
    await h.pool.query<{ n: number }>(
      "INSERT INTO outbox_jobs(kind,deduplication_key,payload)VALUES('identity.setup_delivery',$1,'{}')",
      [`setup:${oldToken}`],
    );
    await h.pool.query<{ n: number }>(
      "INSERT INTO idempotency_records(scope,key,request_fingerprint,created_at,expires_at)VALUES('old','old-key-123',$1,now()-interval '10 days',now()-interval '8 days'),('grace','grace-key-123',$2,now()-interval '2 days',now()-interval '1 day')",
      [hash(), hash()],
    );
    await h.pool.query<{ n: number }>(
      "INSERT INTO auth_sessions(user_id,refresh_token_hash,created_at,expires_at)VALUES($1,$2,now()-interval '10 days',now()-interval '8 days')",
      [patient.actor.userId, hash()],
    );
    await maintenance('SELECT cleanup_security_records(500)');
    expect(
      (
        await h.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM idempotency_records WHERE scope='old'",
        )
      ).rows[0]?.n,
    ).toBe(0);
    expect(
      (
        await h.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM idempotency_records WHERE scope='grace'",
        )
      ).rows[0]?.n,
    ).toBe(1);
    expect(await h.count('consultations')).toBe(1);
    expect(await h.count('outbox_jobs')).toBe(0);
    expect(await h.count('audit_logs', "action='operations.security_cleanup'")).toBe(1);
  });
  it('retains an expired flow still referenced by a pending MFA enrollment', async () => {
    const user = await h.account();
    const flow = randomUUID();
    await h.pool.query<{ n: number }>(
      "INSERT INTO auth_flows(id,user_id,auth_version,purpose,created_at,expires_at)VALUES($1,$2,1,'enroll',now()-interval '10 days',now()-interval '8 days')",
      [flow, user.actor.userId],
    );
    await h.pool.query<{ n: number }>(
      'INSERT INTO mfa_factors(user_id,enrollment_flow_id,secret_envelope)VALUES($1,$2,$3)',
      [
        user.actor.userId,
        flow,
        { ciphertext: 'fixture', iv: 'fixture', tag: 'fixture', key_version: 'fixture' },
      ],
    );
    await maintenance('SELECT cleanup_security_records(500)');
    expect(
      (
        await h.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM auth_flows WHERE id=$1', [
          flow,
        ])
      ).rows[0]?.n,
    ).toBe(1);
  });
  it('bounds cleanup batch sizes and deletes only the selected batch', async () => {
    for (let n = 0; n < 3; n++)
      await h.pool.query<{ n: number }>(
        "INSERT INTO idempotency_records(scope,key,request_fingerprint,created_at,expires_at)VALUES($1,'old-key-123',$2,now()-interval '10 days',now()-interval '8 days')",
        [`batch-${n}`, hash()],
      );
    await maintenance('SELECT cleanup_security_records(1)');
    expect(
      (await h.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM idempotency_records'))
        .rows[0]?.n,
    ).toBe(2);
    await expect(maintenance('SELECT cleanup_security_records(1001)')).rejects.toThrow();
  });
});
