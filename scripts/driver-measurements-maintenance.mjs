// Mounted at /maintenance.mjs inside the SDA image. No alternate configuration,
// producer, direct database path or authority may be supplied through this CLI.
try {
  if (process.argv.length !== 2) throw new Error('Unsupported maintenance arguments');
  const { runDriverMaintenance } = await import('/app/apps/situation-data-api/dist/driver-maintenance-cli.js');
  await runDriverMaintenance();
  console.log(JSON.stringify({ cleanup: 'completed' }));
} catch {
  // Never print exception payloads, connection strings or measurement values.
  console.error('Driver measurement cleanup unavailable');
  process.exitCode = 1;
}
