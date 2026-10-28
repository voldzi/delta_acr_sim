/** Process survival only. Never retries a query or converts rejection to success. */
const attached = new WeakSet();
const states = new Set(['57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006', '08P01']);
export function attachSimPgErrorObservers(pool, lane, sink = record => console.error(JSON.stringify(record))) {
  if (!['target', 'guard'].includes(lane)) throw Error('INVALID_SIM_POOL_LANE');
  if (attached.has(pool)) return;
  attached.add(pool);
  const report = (kind, error) => {
    try {
      sink({ event: 'sim_user_database_connection_error', pool: lane, kind,
        sqlstate: states.has(error?.code) ? error.code : 'OTHER' });
    } catch { /* Diagnostic failure cannot affect admission or query rejection. */ }
  };
  pool.on('error', error => report('idle_client', error));
  pool.on('connect', client => {
    client.on('error', error => report('client', error));
  });
}
