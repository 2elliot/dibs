import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, connect as tcpConnect, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { PROVIDERS } from '@dibs/protocol';
import { connect, subscribeLobby } from '@dibs/client';
import { waitFor } from '../../packages/cli/src/commands/common.ts';
import { spacetime } from '../../packages/cli/src/commands/local.ts';
import { fresh, prepare, uri, type Harness } from './harness.ts';

let path: string, h: Harness;
beforeAll(async () => { path = await prepare(); });
beforeEach(async () => { h = await fresh(path); });
afterEach(() => h?.close());

describe('frozen API rules against a real local database', () => {
  test('rule 1: unknown senders, wrong roles, builds and lobbies are rejected', async () => {
    const stranger = await h.stranger();
    await expect(stranger.reducers.createLobby({ scenario: 'x', mode: 'dibs', baseSha: 'a', vocabularyJson: '[]', charter: 'x', buildHash: 'x' })).rejects.toThrow('not admin');
    await expect(h.peer.claude.reducers.createInvite({ code: 'x', name: 'outsider', provider: 'codex', role: 'agent' })).rejects.toThrow('not admin');
    const a = await h.lobby('dibs', ['claude', 'codex'], false);
    await expect(h.peer.droid.reducers.joinLobby({ lobbyId: a, buildHash: 'wrong' })).rejects.toThrow('build mismatch');
    await h.admin.reducers.startLobby({ lobbyId: a });
    const b = await h.lobby('dibs', ['droid']);
    await expect(h.peer.droid.reducers.reportHead({ lobbyId: a, sha: 'f'.repeat(40), outOfAreaFiles: [] })).rejects.toThrow('wrong lobby');
    await expect(h.peer.claude.reducers.joinLobby({ lobbyId: b, buildHash: 'test-v1' })).rejects.toThrow('already in an active lobby');
    await h.plan('claude'); await h.plan('codex'); await h.analyze(a);
    const p = await h.proposal(a);
    await expect(h.vote('droid', p)).rejects.toThrow('proposal not open');
    await expect(h.peer.claude.reducers.leaseJob({ jobId: 1, leaseToken: 'x' })).rejects.toThrow('not worker');
  });
  test('rule 2: bad tokens, expired leases and stale plan snapshots cannot commit', async () => {
    const lobbyId = await h.planned(), args = await h.lease(lobbyId);
    const findingsJson = '{"findings":[]}';
    await expect(h.peer.worker.reducers.submitAnalysis({ ...args, leaseToken: 'bad', findingsJson })).rejects.toThrow('stale lease');
    await expect(h.peer.worker.reducers.submitAnalysis({ ...args, inputKey: 'p:old;r:', findingsJson })).rejects.toThrow('stale inputKey');
    await new Promise(r => setTimeout(r, 1050));
    await expect(h.peer.worker.reducers.submitAnalysis({ ...args, findingsJson })).rejects.toThrow('stale lease');
    const nextToken = randomUUID(); await h.peer.worker.reducers.leaseJob({ jobId: args.jobId, leaseToken: nextToken });
    await h.plan('codex', 'changed');
    await expect(h.peer.worker.reducers.submitAnalysis({ ...args, leaseToken: nextToken, findingsJson })).rejects.toThrow('stale lease');
    expect(h.admin.db.proposal.count()).toBe(0n);
  });
  test('rule 3: required parties include uncited consumers; invalid and cross-key citations are dropped', async () => {
    const lobbyId = await h.planned();
    await h.analyze(lobbyId, 'conflict', 'cookie', [999999]);
    expect(h.admin.db.proposal.count()).toBe(0n);
    await h.plan('claude');
    const claudeItem = await waitFor(() => [...h.peer.worker.db.planItem.iter()].find(i => i.current && i.participantId === h.peer.worker.db.participant.name.find('claude')!.id));
    await h.analyze(lobbyId, 'conflict', 'cookie', [claudeItem.id]);
    const p = await h.proposal(lobbyId);
    expect(p.requiredPartyIds).toHaveLength(3);
    expect(new Set(p.requiredPartyIds)).toEqual(new Set(PROVIDERS.map(name => h.admin.db.participant.name.find(name)!.id)));
    const frozen = [...p.requiredPartyIds];
    await h.plan('droid', 'same unrelated consumer change');
    expect(h.admin.db.proposal.id.find(p.id)!.requiredPartyIds).toEqual(frozen);
  });
  test('rule 4: unanimous same-revision votes produce one contract and close the unique slot', async () => {
    const lobbyId = await h.planned(); await h.analyze(lobbyId); const p = await h.proposal(lobbyId);
    await h.vote('claude', p);
    await expect(h.peer.codex.reducers.respond({ requestId: randomUUID(), proposalId: p.id, revision: p.revision + 1, decision: 'accept', reason: '' })).rejects.toThrow('proposal not open');
    await h.vote('codex', p);
    expect(h.admin.db.contract.count()).toBe(0n);
    await h.vote('droid', p);
    const c = await waitFor(() => [...h.admin.db.contract.iter()].find(c => c.current));
    expect(c.source).toBe('agreed'); expect(c.basisItemIds).toEqual(p.citedItemIds);
    expect(h.admin.db.proposal.id.find(p.id)!.slot).toBe(`closed/${p.id}`);
    expect([...h.admin.db.delivery.iter()].filter(d => d.kind === 'contract')).toHaveLength(3);
    expect([...h.admin.db.delivery.iter()].filter(d => d.kind === 'proposal').every(d => d.stage === 'responded')).toBe(true);
  });
  test('rule 4: first rejection requeues the same job; second rejection escalates the key', async () => {
    const lobbyId = await h.planned(); const initialJob = await h.job(lobbyId); await h.analyze(lobbyId);
    const p = await h.proposal(lobbyId); await h.vote('claude', p, 'reject');
    const revisedJob = await h.job(lobbyId);
    expect(revisedJob.id).toBe(initialJob.id); expect(revisedJob.kind).toBe('revise'); expect(revisedJob.attempts).toBe(0);
    expect(revisedJob.inputKey).toMatch(/;r:\d+/);
    await h.analyze(lobbyId, 'conflict', 'new cookie contract');
    const revised = await h.proposal(lobbyId); expect(revised.revision).toBe(2);
    await h.vote('codex', revised, 'reject');
    await waitFor(() => h.admin.db.proposal.id.find(revised.id)?.state === 'escalated');
    expect(h.admin.db.job.count()).toBe(1n);
    expect([...h.admin.db.delivery.iter()].filter(d => d.kind === 'escalated')).toHaveLength(3);
    expect(h.admin.db.contract.count()).toBe(0n);
  });
  test('rule 5: identical republishing preserves open proposals; changed cited text supersedes only open ones', async () => {
    const lobbyId = await h.planned(); await h.analyze(lobbyId); const p = await h.proposal(lobbyId);
    await h.plan('claude', 'bearer');
    expect(h.admin.db.proposal.id.find(p.id)!.state).toBe('proposed');
    await h.plan('claude', 'new bearer format');
    await waitFor(() => h.admin.db.proposal.id.find(p.id)?.state === 'superseded');
    await h.analyze(lobbyId); const next = await h.proposal(lobbyId);
    for (const name of PROVIDERS) await h.vote(name, next);
    await waitFor(() => h.admin.db.proposal.id.find(next.id)?.state === 'accepted');
    await h.plan('claude', 'a later change');
    expect(h.admin.db.proposal.id.find(next.id)!.state).toBe('accepted');
    expect([...h.admin.db.contract.iter()].filter(c => c.current)).toHaveLength(1);
  });
  test('rule 6: retries are no-ops; changed payloads and cross-sender request theft fail', async () => {
    const lobbyId = await h.lobby(); const requestId = randomUUID();
    await h.plan('claude', 'bearer', requestId);
    await h.plan('claude', 'bearer', requestId);
    expect([...h.admin.db.plan.iter()].filter(p => p.lobbyId === lobbyId)).toHaveLength(1);
    await expect(h.plan('claude', 'cookie', requestId)).rejects.toThrow('requestId reused');
    await expect(h.plan('codex', 'bearer', requestId)).rejects.toThrow('requestId reused');
    const invalid = randomUUID();
    await expect(h.peer.claude.reducers.publishPlan({ requestId: invalid, goal: 'x', produces: [{ key: 'unknown', text: 'x' }], requires: [], notes: '' })).rejects.toThrow('unknown vocabulary');
    await h.plan('claude', 'bearer', invalid); // Failed transaction did not poison requestId.
    expect([...h.admin.db.plan.iter()].filter(p => p.current)).toHaveLength(1);
    expect(h.admin.db.plan.count()).toBe(2n);
  });
  test.each(['none', 'chat'])('rule 7: %s mode creates no jobs or proposals and enforces messages', async mode => {
    await h.planned(mode); expect(h.admin.db.job.count()).toBe(0n); expect(h.admin.db.proposal.count()).toBe(0n);
    const message = h.peer.claude.reducers.sendMessage({ requestId: randomUUID(), to: 'codex', text: 'hello' });
    if (mode === 'none') await expect(message).rejects.toThrow('messages disabled');
    else { await message; await waitFor(() => h.admin.db.message.count() === 1n); }
    const args = { lobbyId: 1, assembledFrom: '{}', treeHash: 'f'.repeat(64), oracleHash: 'f'.repeat(64), reportHash: 'f'.repeat(64), mergeTreeClean: true, exitCode: 0, passed: 1, total: 1 };
    await expect(h.peer.worker.reducers.recordVerification(args)).rejects.toThrow('not verifier');
    await expect(h.peer.claude.reducers.recordReview({ lobbyId: 1, verificationId: 1, kind: 'diagnosis', summary: 'x', findingsJson: '{}', model: 'x', sessionId: 'x' })).rejects.toThrow('not verifier');
  });
  test('rule 8: identical plans, contract-conforming revisions and aligned findings preserve agreed keys', async () => {
    const lobbyId = await h.agreed();
    for (const name of PROVIDERS) await h.plan(name, name === 'claude' ? 'bearer' : 'cookie');
    await h.analyze(lobbyId, 'conflict', 'another contract');
    expect(h.admin.db.proposal.count()).toBe(1n);
    await h.plan('claude', 'cookie'); await h.analyze(lobbyId, 'conflict', 'another contract');
    expect(h.admin.db.proposal.count()).toBe(1n);
    await h.plan('claude', 'divergent late requirement'); await h.analyze(lobbyId, 'compatible', 'aligned');
    expect([...h.admin.db.contract.iter()].filter(c => c.current).map(c => c.source)).toEqual(['agreed']);
    await h.plan('claude', 'divergent late requirement'); await h.analyze(lobbyId, 'conflict', 'new binding contract');
    const p = await h.proposal(lobbyId); expect(p.revision).toBe(2);
    expect([...h.admin.db.contract.iter()].filter(c => c.current)[0].text).toBe('cookie');
  });
  test('rule 9: deliveries are target-only, forward-only, and timestamps are monotonic', async () => {
    await h.lobby(); const targetId = h.admin.db.participant.name.find('claude')!.id;
    await h.admin.reducers.debugDeliver({ targetId, kind: 'debug', summary: 'test' });
    const d = await waitFor(() => [...h.admin.db.delivery.iter()][0]);
    await expect(h.peer.codex.reducers.markDelivery({ deliveryId: d.id, stage: 'shown' })).rejects.toThrow('not delivery target');
    await h.peer.claude.reducers.markDelivery({ deliveryId: d.id, stage: 'shown' });
    await waitFor(() => h.admin.db.delivery.id.find(d.id)?.stage === 'shown');
    const shown = h.admin.db.delivery.id.find(d.id)!;
    expect(shown.receivedAtUs).toBeGreaterThanOrEqual(shown.queuedAtUs); expect(shown.shownAtUs).toBeGreaterThanOrEqual(shown.receivedAtUs);
    await expect(h.peer.claude.reducers.markDelivery({ deliveryId: d.id, stage: 'received' })).rejects.toThrow('cannot move backward');
    await h.peer.claude.reducers.markDelivery({ deliveryId: d.id, stage: 'responded' });
    await h.peer.claude.reducers.markDelivery({ deliveryId: d.id, stage: 'responded' });
    await waitFor(() => h.admin.db.delivery.id.find(d.id)?.stage === 'responded');
    expect(h.admin.db.delivery.id.find(d.id)!.shownAtUs).toBe(shown.shownAtUs);
  });
});

describe('timers, failures and generated client integration', () => {
  test('inputKey sorts current plan ids and clears a rejection once revised', async () => {
    const lobbyId = await h.planned(); const j = await h.job(lobbyId);
    const ids = [...h.admin.db.plan.iter()].filter(p => p.current).map(p => p.id).sort((a,b) => a-b);
    expect(j.inputKey).toBe(`p:${ids.join(',')};r:`);
    await h.analyze(lobbyId); const p = await h.proposal(lobbyId); await h.vote('claude', p, 'reject');
    expect((await h.job(lobbyId)).inputKey).toMatch(/;r:\d+/);
    await h.analyze(lobbyId, 'conflict', 'revised'); await h.plan('codex');
    expect((await h.job(lobbyId)).inputKey).toMatch(/;r:$/);
  });
  test('promote_job waits for every agent plan; a later plan promotes the latest job', async () => {
    const lobbyId = await h.lobby(); await h.plan('claude');
    await new Promise(r => setTimeout(r, 350));
    expect([...h.admin.db.job.iter()][0].state).toBe('debouncing');
    await h.plan('codex'); await h.plan('droid'); expect((await h.job(lobbyId)).state).toBe('queued');
  });
  test('analyze_anyway opens the gate; fallback is a delivery, never agreement; stop ends the lobby', async () => {
    const lobbyId = await h.lobby(); await h.plan('claude');
    await waitFor(() => h.admin.db.lobby.id.find(lobbyId)?.analyzeAnywayFired, 4000);
    expect((await h.job(lobbyId)).state).toBe('queued');
    await waitFor(() => [...h.admin.db.delivery.iter()].some(d => d.lobbyId === lobbyId && d.kind === 'fallback'), 5000);
    expect(h.admin.db.contract.count()).toBe(0n);
    await waitFor(() => h.admin.db.lobby.id.find(lobbyId)?.state === 'stopped', 14000);
    await expect(h.plan('claude')).rejects.toThrow('lobby not running');
  });
  test('manual stop prevents a previously scheduled debounce from queuing work', async () => {
    const lobbyId = await h.planned(); await h.admin.reducers.stopLobby({ lobbyId });
    await new Promise(r => setTimeout(r, 350));
    expect([...h.admin.db.job.iter()][0].state).toBe('debouncing');
    await expect(h.peer.worker.reducers.leaseJob({ jobId: [...h.admin.db.job.iter()][0].id, leaseToken: 'x' })).rejects.toThrow();
  });
  test('compatible findings write aligned contracts without votes', async () => {
    const lobbyId = await h.planned(); await h.analyze(lobbyId, 'compatible');
    expect(h.admin.db.proposal.count()).toBe(0n);
    expect([...h.admin.db.contract.iter()][0].source).toBe('aligned');
    expect([...h.admin.db.delivery.iter()].filter(d => d.kind === 'aligned')).toHaveLength(3);
  });
  test('worker failure emits deterministic overlap notices, no proposal or contract', async () => {
    const lobbyId = await h.planned(), args = await h.lease(lobbyId);
    await h.peer.worker.reducers.failJob({ jobId: args.jobId, leaseToken: args.leaseToken, error: 'service unavailable' });
    await waitFor(() => h.admin.db.job.id.find(args.jobId)?.state === 'failed');
    const notices = [...h.admin.db.delivery.iter()].filter(d => d.kind === 'notice');
    expect(notices).toHaveLength(3); expect(notices[0].summary).toContain('claude produces');
    expect(h.admin.db.proposal.count()).toBe(0n); expect(h.admin.db.contract.count()).toBe(0n);
  });
  test('verification and advisory review preserve test evidence', async () => {
    const lobbyId = await h.lobby();
    await expect(h.peer.verifier.reducers.markVerified({ lobbyId })).rejects.toThrow('no verification');
    const hash = 'e'.repeat(64);
    await h.peer.verifier.reducers.recordVerification({ lobbyId, assembledFrom: JSON.stringify({ claude: 'a'.repeat(40) }), treeHash: hash, mergeTreeClean: true, oracleHash: hash, exitCode: 1, passed: 0, total: 3, reportHash: hash });
    const v = await waitFor(() => [...h.peer.verifier.db.verification.iter()][0]);
    await h.peer.verifier.reducers.recordReview({ lobbyId, verificationId: v.id, kind: 'diagnosis', summary: 'advisory', findingsJson: '{"summary":"advisory","clauses":[],"rootCause":null}', model: 'fake', sessionId: 'test' });
    await h.peer.verifier.reducers.markVerified({ lobbyId });
    await waitFor(() => h.admin.db.lobby.id.find(lobbyId)?.state === 'verified');
    expect(h.admin.db.verification.id.find(v.id)!.passed).toBe(0); expect(h.admin.db.verification.id.find(v.id)!.exitCode).toBe(1);
  });
  test('typed lobby subscriptions filter rows, and saved tokens reconnect to the same identity', async () => {
    const a = await h.lobby('chat'); const session = await connect({ uri, dbName: h.dbName, token: h.tokens.claude });
    h.connections.push(session.conn);
    await subscribeLobby(session.conn, a, ['lobby', 'participant', 'plan_item']);
    expect(session.identity.toHexString()).toBe(h.admin.db.participant.name.find('claude')!.identity.toHexString());
    await h.plan('claude'); await waitFor(() => session.conn.db.planItem.count() === 1n);
    await h.admin.reducers.stopLobby({ lobbyId: a }); await h.lobby('chat'); await h.plan('claude');
    await new Promise(r => setTimeout(r, 75)); expect(session.conn.db.lobby.count()).toBe(1n); expect(session.conn.db.planItem.count()).toBe(1n);
    session.conn.disconnect();
    await new Promise(r => setTimeout(r, 75)); expect(h.admin.db.participant.name.find('claude')!.online).toBe(true);
  });
  test('the CLI owner can bootstrap with spacetime call using the canonical snake_case names', async () => {
    const name = 'cli-agent', code = randomUUID();
    spacetime(['call', '--server', uri, h.dbName, 'create_invite', JSON.stringify(code), JSON.stringify(name), '"claude"', '"agent"']);
    spacetime(['call', '--server', uri, h.dbName, 'claim_invite', JSON.stringify(code)]);
    spacetime(['call', '--server', uri, h.dbName, 'create_lobby', '"cli"', '"dibs"', '"base"', JSON.stringify('[{"key":"auth.session","description":"session"}]'), '"charter"', '"build"']);
    const l = await waitFor(() => [...h.admin.db.lobby.iter()][0]);
    spacetime(['call', '--server', uri, h.dbName, 'join_lobby', String(l.id), '"build"']);
    spacetime(['call', '--server', uri, h.dbName, 'start_lobby', String(l.id)]);
    spacetime(['call', '--server', uri, h.dbName, 'publish_plan', JSON.stringify(randomUUID()), '"goal"', JSON.stringify([{ key: 'auth.session', text: 'cookie' }]), '[]', '""']);
    await waitFor(() => h.admin.db.plan.count() === 1n);
  });
  test('the browser bundle connects and applies typed subscriptions without Node-only helpers', async () => {
    const lobbyId = await h.lobby('chat');
    const bundle = await build({ entryPoints: [fileURLToPath(new URL('../../packages/client/src/index.ts', import.meta.url))],
      bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'DibsClient', target: 'es2023', logLevel: 'silent' });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage(); await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const result = await page.evaluate(async ({ uri, dbName, lobbyId }) => {
        const client = (globalThis as any).DibsClient;
        const session = await client.connect({ uri, dbName });
        try {
          await client.subscribeLobby(session.conn, lobbyId, ['lobby', 'participant']);
          return { state: session.conn.db.lobby.id.find(lobbyId).state, identity: client.toJson(session.identity), count: Number(session.conn.db.participant.count()) };
        } finally { session.conn.disconnect(); }
      }, { uri, dbName: h.dbName, lobbyId });
      expect(result.state).toBe('running'); expect(result.identity).toHaveLength(64); expect(result.count).toBe(6);
    } finally { await browser.close(); }
  });
  test('automatic reconnect survives failed attempts and replays its subscription', async () => {
    const lobbyId = await h.lobby('chat'); const sockets = new Set<Socket>(); let rejectConnections = false;
    const proxy = createServer(client => {
      sockets.add(client); client.on('error', () => {}); client.on('close', () => sockets.delete(client));
      if (rejectConnections) { client.destroy(); return; }
      const upstream = tcpConnect({ host: '127.0.0.1', port: 3000 }); sockets.add(upstream);
      upstream.on('error', () => client.destroy()); upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
      client.on('close', () => upstream.destroy()); client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(4111, '127.0.0.1', resolve); });
    let conn: Awaited<ReturnType<typeof connect>>['conn'] | undefined;
    try {
      const session = await connect({ uri: 'http://127.0.0.1:4111', dbName: h.dbName, token: h.tokens.claude }); conn = session.conn;
      const subscription = await subscribeLobby(conn, lobbyId, ['plan']);
      await h.plan('claude'); await waitFor(() => conn!.db.plan.count() === 1n);
      rejectConnections = true; for (const socket of sockets) socket.destroy();
      await waitFor(() => !conn!.isActive);
      await new Promise(r => setTimeout(r, 1600)); // Force at least one failed reconnect, not just a clean socket swap.
      await h.plan('claude', 'updated while disconnected'); rejectConnections = false;
      await waitFor(() => conn!.isActive && [...conn!.db.plan.iter()].some(p => p.current && p.revision === 2), 10000);
      expect(subscription.isActive).toBe(true); expect(conn.identity?.toHexString()).toBe(session.identity.toHexString());
    } finally {
      conn?.disconnect(); for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  });
});
