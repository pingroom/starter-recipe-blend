import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportProposal, exportAnalysis } from '../src/engine.js';
import { readJson, atomicJson, acquireLock, atomicText } from '../src/storage.js';
import { validateInput, validateState, tasksFor, parseFraction, recipeBlend, minimumBlend, POLICY, POLICY_HASH, TOKEN, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/model.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = () => structuredClone(example);
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-blend-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later fractions; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), '5'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options = [{value:'yes',label:'Yes'}]; }, (q) => { q.text_input.max_length = 30; }, (q) => { q.text_input = null; },
    (q) => { q.data.task_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('misattributed, malformed or non-text answers never resolve a count', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = '1e2'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), '5'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.proposal, null);
    assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across fractions', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), '5'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).observedStatus, 'expired'); assert.equal((await localReport(s.directory, s.options.input)).proposal, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), '5');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), '5'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), '5'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing operator before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), '5');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), '5'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).proposal, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});



const manifest = (total, ingredients, min = 0, max = 1000) => ({ blendId: 'fixture', title: 'Paper composition', context: 'Harmless dry-paper planning exercise.',
  partDefinition: 'one equal-mass paper portion', constituent: 'recycled fibre mass fraction', costUnit: 'practice credits', totalParts: total,
  targetMinPermille: min, targetMaxPermille: max, ingredients: ingredients.map(([id, maxParts, costPerPart]) => ({ id, label: `Stock ${id}`, maxParts, costPerPart })) });
const fractionsFor = (input, values) => Object.fromEntries(tasksFor(input).map((row, i) => [row.id, values[i]]));
const answersFor = (input, values) => tasksFor(input).map((row, i) => ({ ingredientId: row.id, text: values[i] === null ? null : String(values[i]) }));

// Independent oracle: flatten the full Cartesian count grid, then filter totals,
// availability and constituent inequalities. It does not recurse on remaining mass.
function oracle(input, fractions) {
  const ingredients = [...input.ingredients].sort((a, b) => a.id < b.id ? -1 : 1), radix = input.totalParts + 1, feasible = []; let evaluated = 0;
  for (let code = 0; code < radix ** ingredients.length; code++) {
    let remainder = code; const counts = ingredients.map(() => { const count = remainder % radix; remainder = Math.floor(remainder / radix); return count; });
    if (counts.reduce((a, b) => a + b, 0) !== input.totalParts || counts.some((c, i) => c > ingredients[i].maxParts)) continue;
    evaluated++; const numerator = counts.reduce((sum, count, i) => sum + count * fractions[ingredients[i].id], 0);
    if (numerator < input.targetMinPermille * input.totalParts || numerator > input.targetMaxPermille * input.totalParts) continue;
    const cost = counts.reduce((sum, count, i) => sum + count * ingredients[i].costPerPart, 0); feasible.push({ counts, numerator, cost });
  }
  feasible.sort((a, b) => { if (a.cost !== b.cost) return a.cost - b.cost; for (let i = 0; i < a.counts.length; i++) if (a.counts[i] !== b.counts[i]) return a.counts[i] - b.counts[i]; return 0; });
  return { evaluated, feasible, best: feasible[0] ?? null, ties: feasible.length ? feasible.filter(row => row.cost === feasible[0].cost).length : 0 };
}
function compareOracle(input, fractions) {
  const expected = oracle(input, fractions), actual = minimumBlend(input, fractions);
  assert.equal(actual.evaluatedCompositionCount, expected.evaluated); assert.equal(actual.feasibleCount, expected.feasible.length); assert.equal(actual.tiedOptimalCount, expected.ties);
  assert.equal(actual.status, expected.best ? 'feasible' : 'infeasible');
  if (!expected.best) { assert.equal(actual.recipe, null); return; }
  assert.deepEqual(actual.recipe.counts, expected.best.counts); assert.equal(actual.recipe.totalCost, String(expected.best.cost));
  assert.deepEqual(actual.recipe.weightedPermille, { numerator: String(expected.best.numerator), denominator: String(input.totalParts) });
  assert.deepEqual(actual.recipe.constituentMassFraction, { numerator: String(expected.best.numerator), denominator: String(1000 * input.totalParts) });
  assert.equal(actual.recipe.counts.reduce((a, b) => a + b, 0), input.totalParts);
  for (const usage of actual.recipe.usage) { assert.ok(usage.parts <= usage.maxParts); assert.equal(usage.remainingParts, usage.maxParts - usage.parts); assert.equal(usage.ingredientCost, String(usage.parts * usage.costPerPart)); }
}

test('7776 bounded two-ingredient models agree with independent Cartesian composition enumeration', () => {
  let models = 0;
  for (let total = 1; total <= 4; total++) for (let a = 0; a <= total; a++) for (let b = 0; b <= total; b++)
    for (const fa of [0, 500, 1000]) for (const fb of [0, 500, 1000]) for (const ca of [0, 2]) for (const cb of [0, 2])
      for (const [min, max] of [[0, 1000], [0, 0], [500, 500], [1000, 1000]]) {
        const input = manifest(total, [['a', a, ca], ['b', b, cb]], min, max); compareOracle(input, { a: fa, b: fb }); models++;
      }
  assert.equal(models, 7776);
});

test('240 deterministic three/four-ingredient models match an independent oracle', () => {
  let seed = 3181; const next = max => { seed = (seed * 48271) % 2147483647; return seed % max; };
  for (let index = 0; index < 240; index++) {
    const n = 3 + index % 2, total = 1 + next(6), min = next(1001), max = min + next(1001 - min);
    const input = manifest(total, ['a', 'b', 'c', 'd'].slice(0, n).map(id => [id, next(total + 1), next(11)]), min, max);
    compareOracle(input, fractionsFor(input, input.ingredients.map(() => next(1001))));
  }
});

test('strict returned-text fraction grammar preserves zero and Unknown without rounding', () => {
  for (const value of [0, 1, 999, 1000]) assert.deepEqual(parseFraction(String(value)), { kind: 'quantity', fraction: value });
  assert.deepEqual(parseFraction('Unknown'), { kind: 'unknown', fraction: null });
  for (const value of ['1001', '-1', '-0', '+0', '01', '1.0', '1e2', ' 0', '0 ', '0\n', '0\r', '0\u2028', 'unknown', 'Unavailable', '١', '', null, 0]) assert.throws(() => parseFraction(value));
});

test('zero prices, zero fractions and zero availability remain distinct with stable count ties', () => {
  const input = manifest(3, [['a', 3, 0], ['b', 3, 0]], 0, 0), result = minimumBlend(input, { a: 0, b: 0 });
  assert.deepEqual(result.recipe.counts, [0, 3]); assert.equal(result.recipe.totalCost, '0'); assert.equal(result.feasibleCount, 4); assert.equal(result.tiedOptimalCount, 4);
  input.ingredients[1].maxParts = 0; const forced = minimumBlend(input, { a: 0, b: 1000 }); assert.deepEqual(forced.recipe.counts, [3, 0]); assert.equal(forced.feasibleCount, 1);
  input.ingredients[0].maxParts = 0; const empty = minimumBlend(input, { a: 0, b: 0 }); assert.equal(empty.status, 'infeasible'); assert.equal(empty.evaluatedCompositionCount, 0);
});

test('inclusive fraction boundaries use exact products, not rounded permille', () => {
  const input = manifest(3, [['a', 2, 1], ['b', 1, 1]], 333, 334), fractions = { a: 0, b: 1000 };
  const result = minimumBlend(input, fractions); assert.equal(result.status, 'feasible'); assert.deepEqual(result.recipe.counts, [2, 1]);
  assert.deepEqual(result.recipe.weightedPermille, { numerator: '1000', denominator: '3' });
  assert.equal(minimumBlend({ ...input, targetMaxPermille: 333 }, fractions).status, 'infeasible');
  assert.equal(minimumBlend({ ...input, targetMinPermille: 334 }, fractions).status, 'infeasible');
  for (const fraction of [0, 1000]) { const exact = manifest(1, [['a', 1, 1], ['b', 1, 2]], fraction, fraction); assert.equal(minimumBlend(exact, { a: fraction, b: fraction }).status, 'feasible'); }
});

test('maximum manifest has 2925 compositions and exact cost totals and decimal-string fractions', () => {
  const input = manifest(24, ['a', 'b', 'c', 'd'].map(id => [id, 24, 999999]), 500, 500);
  const result = minimumBlend(input, { a: 500, b: 500, c: 500, d: 500 });
  assert.equal(result.evaluatedCompositionCount, 2925); assert.equal(result.feasibleCount, 2925); assert.equal(result.tiedOptimalCount, 2925);
  assert.deepEqual(result.recipe.counts, [0, 0, 0, 24]); assert.equal(result.recipe.totalCost, '23999976');
  assert.deepEqual(result.recipe.constituentMassFraction, { numerator: '12000', denominator: '24000' });
});

test('complete real SDK evidence exports recipe and infeasible analysis; neither mixes nor purchases', async t => {
  const s = await setup(t), complete = await decide(s, ['200', '800', '500']);
  assert.equal(complete.status, 'complete'); assert.equal(complete.analysis.status, 'feasible'); assert.deepEqual(complete.analysis.recipe.counts, [2, 2, 2]); assert.equal(complete.analysis.recipe.totalCost, '12');
  assert.deepEqual(complete.answers.map(row => row.fraction), [200, 800, 500]);
  const proposal = await exportProposal(s.directory, example), analysis = await exportAnalysis(s.directory, example);
  assert.deepEqual(proposal, complete.proposal); assert.deepEqual(analysis.analysis, complete.analysis); assert.equal(proposal.mixingPerformed, false); assert.equal(proposal.purchasesMade, false);
  assert.deepEqual(await readJson(join(s.directory, 'proposal.json')), proposal); assert.equal((await stat(join(s.directory, 'proposal.json'))).mode & 0o777, 0o600);
  const negative = await setup(t), infeasible = await decide(negative, ['0', '0', '0']); assert.equal(infeasible.status, 'complete'); assert.equal(infeasible.analysis.status, 'infeasible'); assert.equal(infeasible.proposal, null);
  assert.deepEqual((await exportAnalysis(negative.directory, example)).analysis, infeasible.analysis); await assert.rejects(exportProposal(negative.directory, example));
  assert.equal((await negative.run()).status, 'complete'); assert.equal(sends(negative.api), 3);
});

test('Unknown, missing or invalid fractions block all analysis even for zero-availability ingredients', async t => {
  const input = simple(); input.ingredients[0].maxParts = 0;
  for (const first of ['Unknown', '1001']) {
    const s = await setup(t, input), result = await decide(s, [first, '800', '500']); assert.equal(result.status, 'incomplete'); assert.equal(result.analysis, null); assert.equal(result.proposal, null);
    await assert.rejects(exportAnalysis(s.directory, input)); await assert.rejects(exportProposal(s.directory, input)); assert.equal(sends(s.api), 3);
  }
  assert.equal(recipeBlend(input, answersFor(input, [null, 800, 500])).analysis, null);
  assert.throws(() => recipeBlend(input, answersFor(input, [0, 800, 500]).reverse()));
  assert.throws(() => recipeBlend(input, Array(3)), /one ordered answer/);
});

test('canonical manifest permutation preserves identities and deterministic recipe', async t => {
  const input = simple(), reordered = simple(); reordered.ingredients.reverse(); const fractions = { plain: 200, recycled: 800, scrap: 500 };
  assert.deepEqual(validateInput(input), validateInput(reordered)); assert.deepEqual(minimumBlend(input, fractions), minimumBlend(reordered, fractions));
  const s = await setup(t); await s.run(); const calls = s.api.calls.length;
  for (const mutate of [x => { x.constituent = 'Different constituent'; }, x => { x.partDefinition = 'Different part mass'; }, x => { x.ingredients[0].maxParts--; }, x => { x.ingredients[0].costPerPart++; }, x => { x.targetMinPermille++; }]) {
    const changed = simple(); mutate(changed); await assert.rejects(s.run({ input: changed })); assert.equal(s.api.calls.length, calls);
  }
  assert.equal((await s.run({ input: reordered })).status, 'pending');
});

test('strict manifest and numeric schemas reject unsafe or ambiguous values before API access', async t => {
  for (const mutate of [x => { x.extra = 1; }, x => { x.ingredients[0].extra = 1; }, x => { x.ingredients = x.ingredients.slice(0, 1); }, x => { x.ingredients = Array(5).fill(x.ingredients[0]); },
    x => { x.ingredients.push(x.ingredients[0]); }, x => { x.ingredients[0].id = '__proto__'; }, x => { x.ingredients[0].label = '\ud800'; }, x => { x.context = 'hidden\u202e'; },
    x => { x.totalParts = 0; }, x => { x.totalParts = 25; }, x => { x.totalParts = 1.5; }, x => { x.targetMinPermille = 1001; }, x => { x.targetMaxPermille = 400; },
    x => { x.ingredients[0].maxParts = 7; }, x => { x.ingredients[0].maxParts = -0; }, x => { x.ingredients[0].costPerPart = -1; }, x => { x.ingredients[0].costPerPart = 1000000; }, x => { x.ingredients[0].costPerPart = '2'; }
  ]) { const invalid = simple(); mutate(invalid); assert.throws(() => validateInput(invalid)); }
  for (const values of [{ plain: 0, recycled: 0 }, { plain: 0, recycled: 0, scrap: null }, { plain: 0, recycled: 0, scrap: -0 }, { plain: 0, recycled: 0, scrap: 1001 }, { plain: 0, recycled: 0, scrap: 0, extra: 1 }]) assert.throws(() => minimumBlend(example, values));
  const s = await setup(t); for (const ending of ['\n', '\r', '\r\n', '\u2028', '\u2029']) { assert.throws(() => validateConnection({ token: 'token' + ending, room: ROOM_CODE })); assert.throws(() => iso(s.options.now() + ending)); assert.equal(isId(CONFIG.participant.id + ending), false); }
  assert.equal(s.api.calls.length, 0);
});

test('maximum Unicode descriptions preserve full measurement meaning within prompt limit', () => {
  const input = manifest(24, [['aaaaaaaaaaaa', 24, 999999], ['bbbbbbbbbbbb', 24, 0]]);
  input.blendId = 'b'.repeat(32); input.title = '🦉'.repeat(16); input.context = '🦉'.repeat(30); input.partDefinition = '🦉'.repeat(20); input.constituent = '🦉'.repeat(30); input.ingredients.forEach(row => { row.label = '🦉'.repeat(20); });
  const valid = validateInput(input); for (const ingredient of valid.ingredients) {
    const request = requestFor(input, CONFIG, ingredient.id, id(1)); assert.ok(request.prompt.length <= 500); assert.ok(request.prompt.includes(ingredient.label)); assert.ok(request.prompt.includes(input.partDefinition)); assert.ok(request.prompt.includes(input.constituent)); assert.ok(request.prompt.includes(input.context));
    assert.equal(request.options, undefined); assert.deepEqual(request.text_input, { placeholder: '0..1000 or Unknown', max_length: 60 });
  }
});

test('forged saved numeric evidence, policy and regressing time are rejected without replacing exports', async t => {
  const s = await setup(t); await decide(s, ['200', '800', '500']); await exportProposal(s.directory, example); const before = await readFile(join(s.directory, 'proposal.json'), 'utf8'), original = await s.saved();
  for (const mutate of [x => { x.attempts[0].observation.answer.fraction = 201; }, x => { x.attempts[0].request.data.policy_hash = 'changed'; }, x => { x.attempts[0].observation.answer.kind = 'unknown'; }]) {
    const changed = structuredClone(original); mutate(changed); await atomicJson(s.directory, 'state.json', changed); await assert.rejects(exportProposal(s.directory, example));
  }
  assert.equal(await readFile(join(s.directory, 'proposal.json'), 'utf8'), before);
  const active = await setup(t); await active.run(); active.clock.value = '2026-01-01T09:01:00.000Z'; await active.run(); const saved = await readFile(join(active.directory, 'state.json'), 'utf8'); active.clock.value = '2026-01-01T09:00:30.000Z'; await assert.rejects(active.run(), /regressed/); assert.equal(await readFile(join(active.directory, 'state.json'), 'utf8'), saved);
});
