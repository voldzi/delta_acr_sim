/** NEW cases appended to a mechanically selected, SHA-pinned bootstrap.
 * No old cases execute. Actual Root writer/crypto/TLS/PG/native SELF are used;
 * host observation/app peers/enrollment are explicitly SYNTHETIC. This is not
 * native transport, restore, deployment or whole-account acceptance evidence.
 */
const lineage = new Map(), completedTransitions = [], OWNER_DRIVER = 'sim_driver_measurements', OWNER_AI = 'sim_ai_router';
const copyValue = value => JSON.parse(canonical(value));
async function lineageInitialTransition(owner) {
  const o = ids.owners[owner], proofValidUntilUTC = new Date(Date.now() + 29000).toISOString();
  if (owner === OWNER_DRIVER) return {contractVersion: 'cop-root-driver-checkpoint-transition-v1', operationId: randomUUID(),
    expectedPreviousCheckpointHash: o.checkpoint, checkpointHash: hash('synthetic explicit Driver A-to-B target'), proofValidUntilUTC,
    replayReady: true, retentionReviewed: true, reportProtection: 'no_report', publicationFenceVerified: true};
  // Explicit synthetic bootstrap input before A exists; never runtime
  // adoption. This target generation is independent of metadata C1/C2 1/2.
  stage = 'bootstrap.synthetic-ai-large-generation';
  const seed = await aiAdmin.query('UPDATE ai_router_erasure_checkpoint SET checkpoint_generation=$1::bigint WHERE id=1 RETURNING checkpoint_generation::text AS generation', ['9007199254740992']);
  assert.equal(seed.rowCount, 1); assert.equal(seed.rows[0].generation, '9007199254740992');
  const {request} = await targetFacts(owner), previous = request.expectedSnapshot;
  assert.equal(previous.generation, '9007199254740992');
  return {contractVersion: 'cop-root-ai-checkpoint-transition-v1', operationId: randomUUID(),
    expectedCheckpointId: previous.checkpointId, expectedGeneration: previous.generation,
    checkpointId: randomUUID(), generation: String(BigInt(previous.generation) + 1n), operationDigest: previous.operationDigest,
    schemaDigest: previous.schemaDigest, identityReviewed: true, replayReady: true, costPolicy: COST, proofValidUntilUTC};
}
async function stateRows() {
  const out = {};
  for (const [name, client, schema] of [['registry', registry, 'cop_guard'], ['driver', driverAdmin, 'public'], ['ai', aiAdmin, 'public']]) {
    const rows = (await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [schema])).rows;
    for (const {tablename} of rows) {
      assert.match(tablename, /^[a-z_]+$/);
      out[name + '.' + tablename] = (await client.query("SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS digest FROM " + schema + '.' + tablename + ' t')).rows[0].digest;
    }
  }
  return out;
}
async function caseGroup(name, work, mutableTables = []) {
  stage = name;
  for (const owner of Object.keys(specs)) await refresh(owner);
  const before = await stateRows(); await work(); const after = await stateRows();
  for (const table of mutableTables) {delete before[table]; delete after[table];}
  assert.deepEqual(after, before, 'Only explicitly enumerated synthetic transition metadata may change.');
  events.push({name, passed: true, hostObservationSynthetic: true, appPeerSynthetic: true, mutableTables});
}
async function current(owner) {
  const {requireCurrentOwner} = await import(OPT + '/root-owner-authority.mjs');
  const ctx = await requireCurrentOwner(owner, ids.owners[owner].peer, owner === OWNER_DRIVER ? 'read' : 'checkpoint-read');
  try {await ctx.assertCurrent(); return ctx.rootPolicy.reference;} finally {await ctx.close();}
}
function inputFor(owner) {
  const x = lineage.get(owner); return {owner, binding: binding(owner), priorRef: x.priorRef, currentRef: x.currentRef};
}
async function verifyLineage(owner, changed = {}) {
  const {verifyOwnerPolicyLineage} = await import(OPT + '/root-owner-policy-lineage.mjs');
  return verifyOwnerPolicyLineage({...inputFor(owner), ...changed});
}
async function rowDigest(table, key, id) {
  return (await registry.query("SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS digest FROM cop_guard." + table + ' t WHERE ' + key + '=$1', [id])).rows[0].digest;
}
async function appendActualNextAcceptance(owner, source) {
  const o = ids.owners[owner], previous = (await registry.query('SELECT * FROM cop_guard.checkpoint_acceptances WHERE acceptance_id=$1', [o.acceptanceId])).rows[0];
  const previousGeneration = String(previous.generation); assert.match(previousGeneration, /^[1-9][0-9]*$/);
  const nextGeneration = String(BigInt(previousGeneration) + 1n);
  assert.equal(previous.dataset_binding_id, o.dataset); assert.equal(previous.cleanup_status, 'complete');
  assert.equal(source.record.payload.owner, owner); assert.equal(source.record.payload.operationKind, 'deployment');
  const receiptId = randomUUID(), acceptanceId = randomUUID();
  await registry.query("INSERT INTO cop_guard.replay_operations(operation_id,operation_kind,source_proof_id,binding_id,root_evidence_ref) VALUES($1,'deployment',$2,$3,'synthetic-actual-checkpoint-publication')", [source.operationId, source.proofId, o.runtime]);
  await registry.query(`INSERT INTO cop_guard.owner_receipts(receipt_id,replay_operation_id,source_proof_id,source_proof_jws_digest,binding_id,owner_id,
    expected_checkpoint_id,expected_checkpoint_generation,expected_fence_sequence,expected_fence_digest,expected_cleanup_sequence,expected_cleanup_digest,expected_cleanup_status,
    fence_sequence,fence_digest,cleanup_sequence,cleanup_digest,cleanup_status,coverage_evidence_ref,readback_evidence_ref,attempt,observed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9,0,$9,'complete',0,$9,0,$9,'complete','synthetic-published-checkpoint','actual-sql005-readback',$10,clock_timestamp())`,
  [receiptId, source.operationId, source.proofId, source.record.digest, o.runtime, owner, previous.acceptance_id, previousGeneration, ids.frontier, nextGeneration]);
  await registry.query(`INSERT INTO cop_guard.checkpoint_acceptances(acceptance_id,dataset_binding_id,generation,previous_acceptance_id,receipt_id,policy_generation,policy_digest,
    protected_config_id,admission_policy_id,continuity_epoch,accepted_frontier_sequence,accepted_frontier_digest,fence_sequence,fence_digest,cleanup_sequence,cleanup_digest,cleanup_status,root_evidence_ref)
    VALUES($1::uuid,$2,$3,$4,$5,1,$6,$7,'synthetic-fixture-v1',$8,0,$9,0,$9,0,$9,'complete',($1::uuid)::text)`,
  [acceptanceId, o.dataset, nextGeneration, previous.acceptance_id, receiptId, ids.policy, ids.config, ids.epoch, ids.frontier]);
  const acceptanceRef = await signFile(STATE + '/checkpoint-acceptances/' + acceptanceId + '.json', 'checkpoint-acceptance', {
    acceptanceId, datasetBindingId: o.dataset, receiptId, replayOperationId: source.operationId, sourceProofId: source.proofId,
    acceptanceDigest: await rowDigest('checkpoint_acceptances', 'acceptance_id', acceptanceId),
    receiptDigest: await rowDigest('owner_receipts', 'receipt_id', receiptId), replayDigest: await rowDigest('replay_operations', 'operation_id', source.operationId),
  }, 300000, acceptanceId);
  return {acceptanceRef, acceptanceId, receiptId, generation: nextGeneration};
}
async function publishTransition(owner) {
  const o = ids.owners[owner], policyA = copyValue(o.policy), priorRef = copyValue(o.policyRef), t = policyA.transition;
  assert.ok(Date.parse(t.proofValidUntilUTC) - Date.now() > 4000, 'Do not renew an original transition deadline to make the test pass.');
  const policyPath = STATE + '/owner-policies/' + owner + '.json', priorBytes = await readFile(policyPath);
  const historyPath = STATE + '/owner-policy-history/' + priorRef.recordId + '.json'; assert.equal(existsSync(historyPath), false);
  // Independently accepted synthetic checkpoint deployment, not an ordinary
  // refresh: metadata001 deliberately forbids refresh replay operations.
  const source = await refresh(owner, {kind: 'deployment'});
  const {publishRootDriverCheckpoint, publishRootAiCheckpoint} = await import(OPT + '/root-owner-checkpoint.mjs');
  const outcome = await (owner === OWNER_DRIVER ? publishRootDriverCheckpoint : publishRootAiCheckpoint)(o.peer);
  assert.equal(outcome.status, 'checkpoint-readback-known'); assert.equal(outcome.commitAcknowledged, true);
  assert.equal(outcome.operationId, t.operationId);
  // This history must be written by the actual writer/common archive seam,
  // never by a fixture copy that could hide a missing production integration.
  assert.deepEqual(await readFile(historyPath), priorBytes);
  const policyB = copyValue(policyA); delete policyB.transition;
  if (owner === OWNER_DRIVER) {
    policyB.expectedCheckpointHash = t.checkpointHash; policyB.reportProtection = t.reportProtection;
    assert.deepEqual(outcome.checkpoint, {checkpointHash: t.checkpointHash, proofValidUntilUTC: t.proofValidUntilUTC,
      replayReady: true, retentionReviewed: true, reportProtection: t.reportProtection, publicationFenceVerified: true});
  } else {
    policyB.expectedSnapshot = {checkpointId: t.checkpointId, generation: t.generation, operationDigest: t.operationDigest, schemaDigest: t.schemaDigest};
    assert.deepEqual(outcome.checkpoint, {checkpointId: t.checkpointId, generation: t.generation, identityReviewed: true, replayReady: true, costPolicy: COST});
  }
  // B is derived ONLY from the original signed T; no arbitrary target flags,
  // checkpoints or privilege/schema pins are adopted from the target database.
  assert.equal(policyB.schemaFingerprint, policyA.schemaFingerprint); assert.equal(policyB.privilegeFingerprint, policyA.privilegeFingerprint);
  const c2 = await appendActualNextAcceptance(owner, source);
  o.policy = policyB; o.policyRef = await signFile(policyPath, 'owner-policy', {binding: binding(owner), policy: policyB});
  o.acceptanceRef = c2.acceptanceRef; o.acceptanceId = c2.acceptanceId; o.receiptId = c2.receiptId;
  const entry = {owner, priorRef, currentRef: copyValue(o.policyRef), policyA, policyB, source, t, historyPath, acceptanceGeneration: c2.generation};
  lineage.set(owner, entry); completedTransitions.push(entry);
  await refresh(owner);
  assert.deepEqual(await current(owner), o.policyRef);
  const checked = await verifyLineage(owner);
  assert.equal(checked.operationId, t.operationId); assert.deepEqual(checked.priorRef, priorRef); assert.deepEqual(checked.currentRef, o.policyRef);
  assert.ok(Object.isFrozen(checked));
  if (owner === OWNER_DRIVER) assert.deepEqual(checked.expectedDriverState, outcome.checkpoint);
  else assert.deepEqual(checked.expectedAiSnapshot, policyB.expectedSnapshot);
  return entry;
}
async function seedDistinctNextDriverTransition() {
  const owner = OWNER_DRIVER, o = ids.owners[owner], previous = lineage.get(owner);
  const next = {contractVersion: 'cop-root-driver-checkpoint-transition-v1', operationId: randomUUID(),
    expectedPreviousCheckpointHash: previous.t.checkpointHash, checkpointHash: hash('synthetic separately reviewed Driver B-to-C target'),
    proofValidUntilUTC: new Date(Date.now() + 29000).toISOString(), replayReady: true, retentionReviewed: true,
    reportProtection: 'no_report', publicationFenceVerified: true};
  assert.notEqual(next.operationId, previous.t.operationId);
  const intentRef = await signFile(STATE + '/owner-transitions/' + next.operationId + '.json', 'owner-checkpoint-transition',
    {...binding(owner), owner, scope: specs[owner].scope, transition: next}, 300000, next.operationId);
  // A distinct independently signed next T, not a renewed deadline/body/UUID
  // for the already-consumed A-to-B operation. Incoming A-to-B stays verified.
  o.policy = {...copyValue(previous.policyB), transition: {...next, intentRef}};
  o.policyRef = await signFile(STATE + '/owner-policies/' + owner + '.json', 'owner-policy', {binding: binding(owner), policy: o.policy});
  lineage.set(owner, {...previous, currentRef: copyValue(o.policyRef)});
  await refresh(owner); await verifyLineage(owner); assert.deepEqual(await current(owner), o.policyRef);
}
async function temporaryBytes(path, work) {
  const bytes = await readFile(path);
  try {await work(bytes);} finally {await privateFile(path, bytes);}
}
async function pausedObservation(owner, work) {
  pausedHost.add(owner); await Promise.all([...pendingHostWrites.get(owner)]);
  const path = PRIVATE + '/runtime-observations/' + owner + '.json', bytes = await readFile(path);
  try {await work(path, bytes);} finally {
    try {storeRootRecord(path, bytes, {replace: true});} finally {pausedHost.delete(owner); await hostFact(owner);}
  }
}
async function changedSigned(path, kind, transform, work) {
  await temporaryBytes(path, async bytes => {
    const old = canonicalJson(bytes), facts = Object.fromEntries(Object.entries(old.payload).filter(([key]) => !['contractVersion','kind','recordId','issuedAt','expiresAt'].includes(key)));
    await signFile(path, kind, transform(facts), 300000, old.payload.recordId); await work();
  });
}
async function runLineage() {
  const pins = await bootstrap();
  await caseGroup('same-ref P0/P1 regression remains current for both owners', async () => {
    const {requireCurrentOwner, archiveCurrentOwnerPolicy} = await import(OPT + '/root-owner-authority.mjs');
    for (const owner of Object.keys(specs)) {
      assert.deepEqual(await current(owner), ids.owners[owner].policyRef);
      const ctx = await requireCurrentOwner(owner, ids.owners[owner].peer, owner === OWNER_DRIVER ? 'read' : 'checkpoint-read');
      try {
        await assert.rejects(archiveCurrentOwnerPolicy(ctx), {message: 'GUARD_OWNER_CHECKPOINT_PURPOSE'});
        await assert.rejects(archiveCurrentOwnerPolicy({...ctx}), {message: 'GUARD_OWNER_CONTEXT'});
        await ctx.assertCurrent();
      } finally {await ctx.close();}
    }
    assert.deepEqual(await readdir(STATE + '/owner-policy-history'), []);
  });
  await caseGroup('two actual Driver Root writer cycles archive A then B-nextT and accept C2 then C3', async () => {
    const owner = OWNER_DRIVER, o = ids.owners[owner];
    const {requireCurrentOwner} = await import(OPT + '/root-owner-authority.mjs');
    // Explicit synthetic repair preconditions, not ordinary read admission:
    // expired active proof, then coherent quarantine with the SAME old hash.
    const expired = new Date(Date.now() - 1000).toISOString();
    await driverAdmin.query('UPDATE driver_account_erasure_state SET proof_valid_until=$1 WHERE singleton', [expired]);
    await assert.rejects(current(owner), {name: 'DriverReadFactsError', message: 'DRIVER_READ_ADMISSION_UNAVAILABLE'});
    const repair = await requireCurrentOwner(owner, o.peer, 'checkpoint-publish');
    try {assert.equal(repair.purpose, 'checkpoint-publish'); await repair.assertCurrent();} finally {await repair.close();}
    const quarantined = await driverAdmin.query("UPDATE driver_account_erasure_state SET replay_ready=false,retention_reviewed=false,publication_fence_verified=false,report_protection='unverified' WHERE singleton RETURNING replay_checkpoint_hash::text AS checkpoint");
    assert.equal(quarantined.rows[0].checkpoint, o.policy.transition.expectedPreviousCheckpointHash);
    await assert.rejects(current(owner), {name: 'DriverReadFactsError', message: 'DRIVER_READ_ADMISSION_UNAVAILABLE'});
    await publishTransition(OWNER_DRIVER);
    await seedDistinctNextDriverTransition();
    const second = await publishTransition(OWNER_DRIVER); assert.equal(second.acceptanceGeneration, '3');
  },
    ['driver.driver_account_erasure_state', 'registry.accepted_runtime_proofs', 'registry.replay_operations', 'registry.owner_receipts', 'registry.checkpoint_acceptances']);
  await caseGroup('actual AI Root writer SQL005 preserves bigint generation and exact A-to-B via C2', () => publishTransition(OWNER_AI),
    ['ai.ai_router_erasure_checkpoint', 'registry.accepted_runtime_proofs', 'registry.replay_operations', 'registry.owner_receipts', 'registry.checkpoint_acceptances']);
  const owner = OWNER_DRIVER, x = lineage.get(owner);
  await caseGroup('missing forged or nonprivate history never grants lineage', async () => {
    await temporaryBytes(x.historyPath, async bytes => {await unlink(x.historyPath); await assert.rejects(verifyLineage(owner), {code: 'ENOENT'});});
    await temporaryBytes(x.historyPath, async bytes => {
      const altered = canonicalJson(bytes); altered.signature = (altered.signature[0] === 'A' ? 'B' : 'A') + altered.signature.slice(1);
      await privateFile(x.historyPath, canonical(altered) + '\n'); await assert.rejects(verifyLineage(owner), {message: 'GUARD_SIGNATURE_INVALID'});
    });
    try {await chmod(x.historyPath, 0o666); await assert.rejects(verifyLineage(owner), {message: 'GUARD_FILE_CUSTODY'});}
    finally {await chmod(x.historyPath, 0o600);}
    const c1 = x.source.record.payload.checkpointAcceptanceRef;
    assert.ok(c1 && c1.recordId !== ids.owners[owner].acceptanceId);
    const c1Path = STATE + '/checkpoint-acceptances/' + c1.recordId + '.json';
    await temporaryBytes(c1Path, async () => {await unlink(c1Path); await assert.rejects(current(owner), {code: 'ENOENT'});});
    await temporaryBytes(c1Path, async bytes => {
      const altered = canonicalJson(bytes); altered.signature = (altered.signature[0] === 'A' ? 'B' : 'A') + altered.signature.slice(1);
      await privateFile(c1Path, canonical(altered) + '\n');
      await assert.rejects(current(owner), {message: 'GUARD_SIGNATURE_INVALID'});
    });
  });
  await caseGroup('binding evidence pins and current cohort are independently required', async () => {
    await assert.rejects(verifyLineage(owner, {binding: {...binding(owner), storeIncarnation: randomUUID()}}), {message: 'GUARD_POLICY_LINEAGE_BINDING'});
    const currentPath = STATE + '/owner-policies/' + owner + '.json';
    await temporaryBytes(currentPath, async () => {
      const changed = {...x.policyB, schemaFingerprint: 'f'.repeat(64)}, badRef = await signFile(currentPath, 'owner-policy', {binding: binding(owner), policy: changed});
      await assert.rejects(verifyLineage(owner, {currentRef: badRef}), {message: 'GUARD_POLICY_LINEAGE_EVIDENCE'});
    });
    await pausedObservation(owner, async (path, bytes) => {
      const observed = canonicalJson(bytes).payload.observation;
      const signed = issueRootRecord('host-runtime-observation', {observation: {...observed, observedAtUTC: new Date().toISOString(), configurationDigest: hash('synthetic different app cohort')}},
        {lifetimeMs: 5000, expectedKeyringDigest: hash(await readFile(ETC + '/public/verification-keys.json'))});
      storeRootRecord(path, signed.bytes, {replace: true}); await assert.rejects(current(owner), {message: 'GUARD_OWNER_RUNTIME_OBSERVATION'});
    });
  });
  await caseGroup('original transition intent and consumed dispatch must all match', async () => {
    await changedSigned(STATE + '/owner-transitions/' + x.t.operationId + '.json', 'owner-checkpoint-transition', facts => ({...facts, transition: {...facts.transition, checkpointHash: 'e'.repeat(64)}}),
      () => assert.rejects(verifyLineage(owner), {message: 'GUARD_POLICY_LINEAGE_REFERENCE'}));
    await changedSigned(STATE + '/checkpoint-intents/' + x.t.operationId + '.json', 'owner-checkpoint-intent', facts => ({...facts, bodyDigest: 'e'.repeat(64)}),
      () => assert.rejects(verifyLineage(owner), {message: 'GUARD_POLICY_LINEAGE_INTENT'}));
    await changedSigned(STATE + '/checkpoint-dispatches/' + x.t.operationId + '.json', 'checkpoint-dispatch', facts => ({...facts, bodyDigest: 'e'.repeat(64)}),
      () => assert.rejects(verifyLineage(owner), {message: 'GUARD_POLICY_LINEAGE_DISPATCH'}));
  });
  await caseGroup('actual wrong target checkpoint is not accepted merely because lineage validates', async () => {
    assert.ok(Date.parse(x.t.proofValidUntilUTC) - Date.now() > 1000, 'Expired proof is not evidence of the wrong-checkpoint rejection.');
    await verifyLineage(owner);
    try {
      await driverAdmin.query('UPDATE driver_account_erasure_state SET replay_checkpoint_hash=$1 WHERE singleton', ['d'.repeat(64)]);
      await assert.rejects(current(owner), {name: 'DriverReadFactsError', message: 'DRIVER_READ_ADMISSION_UNAVAILABLE'});
    } finally {await driverAdmin.query('UPDATE driver_account_erasure_state SET replay_checkpoint_hash=$1 WHERE singleton', [x.t.checkpointHash]);}
    const aiState = lineage.get(OWNER_AI);
    await verifyLineage(OWNER_AI);
    try {
      await aiAdmin.query('UPDATE ai_router_erasure_checkpoint SET checkpoint_id=$1 WHERE id=1', [randomUUID()]);
      await assert.rejects(current(OWNER_AI), {name: 'AiCheckpointFactsError', message: 'AI_ROUTER_CHECKPOINT_UNAVAILABLE'});
    } finally {await aiAdmin.query('UPDATE ai_router_erasure_checkpoint SET checkpoint_id=$1 WHERE id=1', [aiState.t.checkpointId]);}
  });
  await caseGroup('expired original P0t and transition are historical only and never renewed', async () => {
    const artifacts = new Map();
    for (const entry of completedTransitions) for (const path of [entry.historyPath,
      STATE + '/owner-transitions/' + entry.t.operationId + '.json', STATE + '/checkpoint-intents/' + entry.t.operationId + '.json',
      STATE + '/checkpoint-dispatches/' + entry.t.operationId + '.json', STATE + '/runtime-proofs/' + entry.source.proofId + '.jws'])
      artifacts.set(path, {bytes: await readFile(path), mtime: (await lstat(path)).mtimeMs});
    const expiry = Math.max(...completedTransitions.flatMap(entry => [Date.parse(entry.t.proofValidUntilUTC), Date.parse(entry.source.record.payload.expiresAt)]));
    await delay(Math.max(1, expiry - Date.now() + 80));
    for (const key of Object.keys(specs)) await refresh(key);
    // AI has no DB TTL column. A new current P1 may use the exact historical
    // P0t/C2/A lineage, but neither the original transition nor permit renews.
    assert.deepEqual(await current(OWNER_AI), ids.owners[OWNER_AI].policyRef);
    await assert.rejects(current(OWNER_DRIVER), {name: 'DriverReadFactsError', message: 'DRIVER_READ_ADMISSION_UNAVAILABLE'}); // actual proofCurrent is now false
    for (const key of Object.keys(specs)) await verifyLineage(key);
    for (const [path, original] of artifacts) {assert.deepEqual(await readFile(path), original.bytes); assert.equal((await lstat(path)).mtimeMs, original.mtime);}
  }, ['registry.accepted_runtime_proofs']);
  for (const [path, pin] of Object.entries(pins)) assert.equal(hash(await readFile(path)), pin);
  return {contractVersion: 'sim-root-owner-policy-lineage-isolated-linux-v1', passed: events.length, cases: events, startedAt, completedAt: new Date().toISOString(),
    hostObservationSynthetic: true, appPeerSynthetic: true, actualHostObserverExecuted: false, actualPidfdSelf: true, singleRootProcess: true,
    actualBrokerStartTicks: true, actualBrokerExecutableDigest: true, actualPidfdProcObserver: false, nativeTransport: false,
    realRootCustody: true, realEd25519: true, realJws: true, realStrictTls: true, realMetadata001: true, realTargetSql: true,
    checkpointWriterIntegrationExercised: true, driverActualSql005: true, aiActualSql005: true, differentPolicyAdvanceAccepted: true,
    driverCheckpointCycles: 2, driverMetadataAcceptanceGenerations: ['1', '2', '3'], aiCheckpointCycles: 1,
    aiTargetGeneration: {before: '9007199254740992', after: '9007199254740993'}, aiMetadataAcceptanceGenerations: ['1', '2'],
    syntheticAcceptedMetadata: true, originalDeadlinesRenewed: false, pgStubs: 0, authorityCallbacks: 0, providerCalls: 0,
    unknownTargetEndExercised: false, lostCommitExercised: false, nativeHostDeployment: false, restoreAccepted: false,
    productionEnrollment: false, productionChanged: false, wholeAccountComplete: false};
}
let result, failure;
try {assert.deepEqual(process.argv.slice(2), ['--run']); result = await runLineage();} catch (error) {failure = error;}
finally {
  if (hostTimer) clearInterval(hostTimer);
  await Promise.all([...pendingHostWrites.values()].flatMap(jobs => [...jobs])).catch(() => {});
  for (const client of clients) await client.end().catch(() => {});
  if (started) await pgCommand('pg_ctl', ['-D', PGROOT + '/data', '-m', 'immediate', '-w', 'stop']).catch(() => {});
  clearTimeout(deadline);
}
if (failure) {
  const message = typeof failure.message === 'string' && /^GUARD_[A-Z0-9_]+$/.test(failure.message) ? failure.message : 'FIXTURE_ASSERTION_FAILED';
  const site = typeof failure.stack === 'string' ? /\/fixture\/harness\.mjs:([0-9]{1,6}):([0-9]{1,4})\b/.exec(failure.stack) : null;
  const failureCode = typeof failure.code === 'string' && /^(?:[0-9A-Z]{5}|ERR_[A-Z0-9_]+|GUARD_[A-Z0-9_]+)$/.test(failure.code) ? failure.code : null;
  console.log(JSON.stringify({contractVersion: 'sim-root-owner-policy-lineage-isolated-linux-v1', passed: false, stage, failure: message,
    failureSite: site ? 'harness.mjs:' + site[1] + ':' + site[2] : null, failureCode}));
} else console.log(JSON.stringify(result));
process.exit(failure ? 1 : 0);
