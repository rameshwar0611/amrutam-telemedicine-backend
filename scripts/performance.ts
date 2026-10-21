import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { phase4Harness } from '../tests/helpers/phase4.js';
const option = (name: string, fallback: number) => {
  const value = Number(
    process.argv.find((v) => v.startsWith(`--${name}=`))?.split('=')[1] ?? fallback,
  );
  if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid performance option');
  return value;
};
if (!process.argv.includes('--reset-isolated-test-data'))
  throw new Error('Requires --reset-isolated-test-data; never use production data');
const writes = option('writes', 50),
  rate = option('rate', 100000 / 86400),
  historical = option('historical', 1000);
if (writes > 100000 || historical > 1000000 || rate > 100)
  throw new Error('Bounded benchmark options exceeded');
const h = phase4Harness();
await h.setup();
const results: { read: number[]; write: number[]; errors: number } = {
  read: [],
  write: [],
  errors: 0,
};
try {
  const doctor = await h.account('doctor');
  const patients = await Promise.all(Array.from({ length: 20 }, () => h.account()));
  await h.pool.query(
    "INSERT INTO availability_slots(doctor_id,starts_at,ends_at) SELECT $1,now()-interval '1 day'-(n+1)*interval '30 minutes',now()-interval '1 day'-n*interval '30 minutes' FROM generate_series(1,$2::int) n",
    [doctor.doctorId, historical],
  );
  await h.pool.query(
    "INSERT INTO consultations(slot_id,doctor_id,patient_id,status,started_at,completed_at) SELECT id,doctor_id,$2,'completed',starts_at,ends_at FROM availability_slots WHERE doctor_id=$1",
    [doctor.doctorId, patients[0]!.actor.userId],
  );
  const slots = (
    await h.pool.query<{ id: string }>(
      "INSERT INTO availability_slots(doctor_id,starts_at,ends_at) SELECT $1,now()+interval '1 day'+n*interval '30 minutes',now()+interval '1 day'+(n+1)*interval '30 minutes' FROM generate_series(1,$2::int) n RETURNING id",
      [doctor.doctorId, writes],
    )
  ).rows;
  const server = await new Promise<ReturnType<typeof h.application.app.listen>>((resolve) => {
    const s = h.application.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Benchmark socket missing');
  const base = `http://127.0.0.1:${address.port}`;
  const start = performance.now();
  const pending: Promise<void>[] = [];
  for (let n = 0; n < writes; n++) {
    if (n % 60 === 0) for (const fixture of patients) await h.renew(fixture);
    const due = start + (n * 1000) / rate;
    await delay(Math.max(0, due - performance.now()));
    const patient = patients[n % patients.length]!;
    pending.push(
      (async () => {
        for (let read = 0; read < 4; read++) {
          const t = performance.now();
          const r = await fetch(base + '/v1/doctors', {
            headers: { Authorization: `Bearer ${patient.token}` },
          });
          await r.arrayBuffer();
          results.read.push(performance.now() - t);
          if (r.status !== 200) results.errors++;
        }
        const t = performance.now();
        const r = await fetch(base + '/v1/consultations', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${patient.token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({ slotId: slots[n]!.id }),
        });
        await r.arrayBuffer();
        results.write.push(performance.now() - t);
        if (r.status !== 201) results.errors++;
      })(),
    );
  }
  await Promise.all(pending);
  const elapsed = (performance.now() - start) / 1000;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  const p95 = (values: number[]) =>
    values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  const report = {
    scope:
      'Local synthetic HTTP workload, trusted MFA-complete fixtures; not full-day/production proof',
    historicalConsultations: historical,
    scheduledWrites: writes,
    targetWritesPerSecond: rate,
    elapsedSeconds: elapsed,
    completedWritesPerSecond: writes / elapsed,
    reads: results.read.length,
    errors: results.errors,
    readP95Ms: p95(results.read),
    writeP95Ms: p95(results.write),
    readTargetMs: 200,
    writeTargetMs: 500,
    node: process.version,
  };
  await writeFile('work/performance.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (results.errors) process.exitCode = 1;
} finally {
  await h.close();
}
