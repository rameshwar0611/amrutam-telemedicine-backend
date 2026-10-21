import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/database/types.js';
import type { JsonValue } from '../../../shared/json.js';
import type { IdentityStore, UserRecord } from '../domain/ports.js';

export class IdentityRepository implements IdentityStore {
  constructor(private readonly db: Kysely<Database> | Transaction<Database>) {}
  async lockEmail(email: string) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${email}, 0))`.execute(this.db);
  }
  userByEmail(email: string) {
    return this.db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
  }
  userById(id: string, lock = false) {
    const query = this.db.selectFrom('users').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }
  createUser(input: Parameters<IdentityStore['createUser']>[0]) {
    return this.db.insertInto('users').values(input).returningAll().executeTakeFirstOrThrow();
  }
  async updateUser(id: string, values: Parameters<IdentityStore['updateUser']>[1]) {
    await this.db.updateTable('users').set(values).where('id', '=', id).execute();
  }
  async createProfile(userId: string, displayName: string, timeZone: string) {
    await this.db
      .insertInto('profiles')
      .values({ user_id: userId, display_name: displayName, time_zone: timeZone })
      .execute();
  }
  profile(userId: string) {
    return this.db
      .selectFrom('profiles')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();
  }
  async updateProfile(userId: string, values: Parameters<IdentityStore['updateProfile']>[1]) {
    await this.db
      .updateTable('profiles')
      .set({
        ...(values.displayName !== undefined ? { display_name: values.displayName } : {}),
        ...(values.phone !== undefined ? { phone: values.phone } : {}),
        ...(values.timeZone !== undefined ? { time_zone: values.timeZone } : {}),
      })
      .where('user_id', '=', userId)
      .execute();
  }
  async createDoctor(userId: string, publicName: string, specialty: string) {
    await this.db
      .insertInto('doctors')
      .values({ user_id: userId, public_name: publicName, specialty, active: false })
      .execute();
  }
  async setDoctorActive(userId: string, active: boolean) {
    await this.db.updateTable('doctors').set({ active }).where('user_id', '=', userId).execute();
  }
  async lockBootstrap() {
    await sql`select pg_advisory_xact_lock(174230, 2)`.execute(this.db);
  }
  async hasAdmin() {
    return !!(await this.db
      .selectFrom('users')
      .select('id')
      .where('role', '=', 'admin')
      .executeTakeFirst());
  }
  async createSetupToken(input: Parameters<IdentityStore['createSetupToken']>[0]) {
    await this.db
      .insertInto('auth_tokens')
      .values({
        id: input.id,
        user_id: input.userId,
        purpose: 'account_setup',
        token_hash: input.tokenHash,
        requires_password: input.requiresPassword,
        expires_at: input.expiresAt,
      })
      .execute();
  }
  setupByHash(hash: string, lock = false) {
    const query = this.db
      .selectFrom('auth_tokens')
      .selectAll()
      .where('token_hash', '=', hash)
      .where('purpose', '=', 'account_setup');
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }
  latestSetup(userId: string) {
    return this.db
      .selectFrom('auth_tokens')
      .selectAll()
      .where('user_id', '=', userId)
      .where('purpose', '=', 'account_setup')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
  }
  async consumeSetup(id: string, now: Date) {
    await this.db
      .updateTable('auth_tokens')
      .set({ consumed_at: now })
      .where('id', '=', id)
      .where('consumed_at', 'is', null)
      .execute();
  }
  async queueDelivery(deduplicationKey: string, payload: JsonValue) {
    await this.db
      .insertInto('outbox_jobs')
      .values({ kind: 'identity.setup_delivery', deduplication_key: deduplicationKey, payload })
      .execute();
  }
  async delivery(deduplicationKey: string) {
    return (
      await this.db
        .selectFrom('outbox_jobs')
        .select('payload')
        .where('deduplication_key', '=', deduplicationKey)
        .executeTakeFirst()
    )?.payload;
  }
  createFlow(user: UserRecord, purpose: 'enroll' | 'verify', expiresAt: Date) {
    return this.db
      .insertInto('auth_flows')
      .values({ user_id: user.id, auth_version: user.auth_version, purpose, expires_at: expiresAt })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  flow(id: string, lock = false) {
    const query = this.db.selectFrom('auth_flows').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }
  async consumeFlow(id: string, now: Date) {
    await this.db
      .updateTable('auth_flows')
      .set({ consumed_at: now })
      .where('id', '=', id)
      .where('consumed_at', 'is', null)
      .execute();
  }
  async failFlow(id: string) {
    await this.db
      .updateTable('auth_flows')
      .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
      .where('id', '=', id)
      .where('attempts', '<', 5)
      .execute();
  }
  factor(userId: string) {
    return this.db
      .selectFrom('mfa_factors')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();
  }
  async saveEnrollment(userId: string, flowId: string, envelope: JsonValue, now: Date) {
    await this.db
      .insertInto('mfa_factors')
      .values({ user_id: userId, secret_envelope: envelope, enrollment_flow_id: flowId })
      .onConflict((conflict) =>
        conflict
          .column('user_id')
          .doUpdateSet({ secret_envelope: envelope, enrollment_flow_id: flowId })
          .where('mfa_factors.confirmed_at', 'is', null),
      )
      .execute();
    await this.db
      .updateTable('auth_flows')
      .set({ consumed_at: now })
      .where('user_id', '=', userId)
      .where('purpose', '=', 'enroll')
      .where('id', '!=', flowId)
      .where('consumed_at', 'is', null)
      .execute();
  }
  async acceptStep(userId: string, step: number) {
    const result = await this.db
      .updateTable('mfa_factors')
      .set({ last_accepted_step: step })
      .where('user_id', '=', userId)
      .where((eb) =>
        eb.or([eb('last_accepted_step', 'is', null), eb('last_accepted_step', '<', String(step))]),
      )
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }
  async confirmFactor(userId: string, now: Date) {
    await this.db
      .updateTable('mfa_factors')
      .set({ confirmed_at: now, enrollment_flow_id: null })
      .where('user_id', '=', userId)
      .execute();
  }
  async replaceRecoveryCodes(userId: string, hashes: string[]) {
    await this.db.deleteFrom('mfa_recovery_codes').where('user_id', '=', userId).execute();
    await this.db
      .insertInto('mfa_recovery_codes')
      .values(hashes.map((code_hash) => ({ user_id: userId, code_hash })))
      .execute();
  }
  async consumeRecoveryCode(userId: string, hash: string, now: Date) {
    const result = await this.db
      .updateTable('mfa_recovery_codes')
      .set({ consumed_at: now })
      .where('user_id', '=', userId)
      .where('code_hash', '=', hash)
      .where('consumed_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }
  createSession(input: Parameters<IdentityStore['createSession']>[0]) {
    return this.db
      .insertInto('auth_sessions')
      .values({
        id: input.id,
        user_id: input.userId,
        refresh_token_hash: input.hash,
        expires_at: input.expiresAt,
        mfa_verified_at: input.mfaVerifiedAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  session(id: string, lock = false) {
    const query = this.db.selectFrom('auth_sessions').selectAll().where('id', '=', id);
    return (lock ? query.forUpdate() : query).executeTakeFirst();
  }
  sessions(userId: string) {
    return this.db
      .selectFrom('auth_sessions')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
  }
  async rotateSession(id: string, currentHash: string, nextHash: string, retryUntil: Date) {
    await this.db
      .insertInto('refresh_token_history')
      .values({ token_hash: currentHash, session_id: id })
      .execute();
    await this.db
      .updateTable('auth_sessions')
      .set({
        refresh_token_hash: nextHash,
        previous_refresh_token_hash: currentHash,
        previous_token_valid_until: retryUntil,
      })
      .where('id', '=', id)
      .execute();
  }
  async refreshWasUsed(sessionId: string, hash: string) {
    return !!(await this.db
      .selectFrom('refresh_token_history')
      .select('token_hash')
      .where('session_id', '=', sessionId)
      .where('token_hash', '=', hash)
      .executeTakeFirst());
  }
  async revokeFamily(familyId: string, now: Date) {
    await this.db
      .updateTable('auth_sessions')
      .set({ revoked_at: now })
      .where('family_id', '=', familyId)
      .where('revoked_at', 'is', null)
      .execute();
  }
  async revokeSession(id: string, now: Date) {
    await this.db
      .updateTable('auth_sessions')
      .set({ revoked_at: now })
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .execute();
  }
  async revokeAll(userId: string, now: Date) {
    await this.db
      .updateTable('auth_sessions')
      .set({ revoked_at: now })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
  }
}
