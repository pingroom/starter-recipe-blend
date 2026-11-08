import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, exportAnalysis, exportProposal } from './engine.js';
import { readJson } from './storage.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const input = await readJson(new URL('../examples/model.json', import.meta.url), 65536);
for (const scenario of [
  { name: 'Target paper composition', values: ['200', '800', '500'], expected: 'feasible' },
  { name: 'Known fractions cannot reach the band', values: ['0', '0', '0'], expected: 'infeasible' },
  { name: 'Unknown fraction withholds analysis', values: ['Unknown', '800', '500'], expected: null }
]) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-blend-demo-'));
  try {
    const now = () => '2026-11-08T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    let result;
    for (const value of scenario.values) { result = await step(options); api.answer(result.answers.find(a => a.status === 'pending').questionId, value); result = await step(options); }
    assert.equal(result.analysis?.status ?? null, scenario.expected);
    if (result.analysis) assert.deepEqual((await exportAnalysis(directory, input)).analysis, result.analysis); else await assert.rejects(exportAnalysis(directory, input));
    if (result.proposal) assert.deepEqual(await exportProposal(directory, input), result.proposal); else await assert.rejects(exportProposal(directory, input));
    console.log(JSON.stringify({ scenario: scenario.name, status: result.status, analysis: result.analysis, mixingPerformed: false, purchasesMade: false }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log('Offline SDK mock demo only. No live pings, mixing or purchases.');
