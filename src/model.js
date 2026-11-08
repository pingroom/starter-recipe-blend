import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


export const POLICY = Object.freeze({ algorithm: 'bounded-integer-compositions-v1', target: 'inclusive-exact-weighted-permille-v1', order: 'cost-then-lexicographic-counts-by-sorted-id-v1', unknown: 'withhold-all-v1' });
export const POLICY_HASH = hash(POLICY);
const safeId = value => word(value) && value.length <= 12 && !['constructor', 'prototype', '__proto__'].includes(value);
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max && !Object.is(value, -0);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const ingredientPrompt = (input, ingredient) => `${input.title}\nBlend ${input.blendId}\nContext: ${input.context}\nIngredient ${ingredient.id}: ${ingredient.label}\nConstituent: ${input.constituent}\nEqual-mass part: ${input.partDefinition}\nWhat is this ingredient's constituent fraction by mass, in permille (1000 = all)? Reply 0..1000 or Unknown. Digits only; no leading zeros. Planning only.`;

export function validateInput(input) {
  if (!keys(input, ['blendId', 'title', 'context', 'partDefinition', 'constituent', 'costUnit', 'totalParts', 'targetMinPermille', 'targetMaxPermille', 'ingredients'])
    || !word(input.blendId) || input.blendId.length > 32 || !line(input.title, 32) || !line(input.context, 60)
    || !line(input.partDefinition, 40) || !line(input.constituent, 60) || !line(input.costUnit, 20)
    || !integer(input.totalParts, 24) || input.totalParts < 1 || !integer(input.targetMinPermille, 1000) || !integer(input.targetMaxPermille, 1000)
    || input.targetMinPermille > input.targetMaxPermille || !Array.isArray(input.ingredients) || input.ingredients.length < 2 || input.ingredients.length > 4) throw new Error('Provide a bounded blend manifest: 2–4 ingredients, 1–24 equal-mass parts and an inclusive target band 0..1000 permille.');
  const ids = new Set();
  for (const ingredient of input.ingredients) {
    if (!keys(ingredient, ['id', 'label', 'maxParts', 'costPerPart']) || !safeId(ingredient.id) || ids.has(ingredient.id) || !line(ingredient.label, 40)
      || !integer(ingredient.maxParts, input.totalParts) || !integer(ingredient.costPerPart, 999999)) throw new Error('Ingredients require unique safe IDs, labels up to 40, availability 0..totalParts and integer costPerPart 0..999999.');
    ids.add(ingredient.id);
  }
  const result = structuredClone(input); result.ingredients.sort((a, b) => compare(a.id, b.id));
  if (result.ingredients.some(ingredient => ingredientPrompt(result, ingredient).length > 500)) throw new Error('Full ingredient prompt exceeds 500 characters. Shorten descriptions.');
  return result;
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact blend operator UUID and label.');
  return structuredClone(config);
}
export const tasksFor = input => validateInput(input).ingredients;
export function parseFraction(text) {
  if (text === 'Unknown') return { kind: 'unknown', fraction: null };
  if (typeof text !== 'string' || !/^(?:0|[1-9][0-9]{0,2}|1000)(?![\s\S])/.test(text)) throw new Error('Reply 0 to 1000 without spaces or leading zeros, or exactly Unknown.');
  return { kind: 'quantity', fraction: Number(text) };
}
export function requestFor(rawInput, config, taskId, attemptId) {
  const input = validateInput(rawInput), ingredient = input.ingredients.find(row => row.id === taskId); validateConfig(config);
  if (!ingredient || !isId(attemptId)) throw new Error('Invalid ingredient or attempt.');
  const key = `blend-${attemptId}`;
  return { prompt: ingredientPrompt(input, ingredient), context: `To ${config.participant.id}`, text_input: { placeholder: '0..1000 or Unknown', max_length: 60 },
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), ingredient_hash: hash(ingredient), policy_hash: POLICY_HASH, task_id: taskId, attempt_id: attemptId }, idempotencyKey: key };
}

function knownFractions(input, fractions) {
  if (!keys(fractions, input.ingredients.map(row => row.id)) || Object.values(fractions).some(value => !integer(value, 1000))) throw new Error('Every ingredient needs an integer constituent fraction 0..1000 permille.');
  return fractions;
}
const vectorOrder = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

export function minimumBlend(rawInput, rawFractions) {
  const input = validateInput(rawInput), fractions = knownFractions(input, rawFractions), ingredients = input.ingredients;
  const total = BigInt(input.totalParts), lower = BigInt(input.targetMinPermille) * total, upper = BigInt(input.targetMaxPermille) * total;
  let evaluatedCompositionCount = 0, feasibleCount = 0, tiedOptimalCount = 0, best = null;
  function evaluate(counts) {
    evaluatedCompositionCount++;
    const numerator = counts.reduce((sum, count, i) => sum + BigInt(count) * BigInt(fractions[ingredients[i].id]), 0n);
    if (numerator < lower || numerator > upper) return;
    feasibleCount++;
    const cost = counts.reduce((sum, count, i) => sum + BigInt(count) * BigInt(ingredients[i].costPerPart), 0n);
    if (best === null || cost < best.cost) { best = { counts: [...counts], numerator, cost }; tiedOptimalCount = 1; }
    else if (cost === best.cost) { tiedOptimalCount++; if (vectorOrder(counts, best.counts) < 0) best = { counts: [...counts], numerator, cost }; }
  }
  function visit(index, remaining, counts) {
    if (index === ingredients.length - 1) { if (remaining <= ingredients[index].maxParts) evaluate([...counts, remaining]); return; }
    for (let count = 0; count <= Math.min(ingredients[index].maxParts, remaining); count++) visit(index + 1, remaining - count, [...counts, count]);
  }
  visit(0, input.totalParts, []);
  const recipe = best === null ? null : {
    ingredientIds: ingredients.map(row => row.id), counts: best.counts, totalParts: input.totalParts, totalCost: best.cost.toString(), costUnit: input.costUnit,
    weightedPermille: { numerator: best.numerator.toString(), denominator: total.toString() },
    constituentMassFraction: { numerator: best.numerator.toString(), denominator: (1000n * total).toString() },
    targetCheck: { lowerProduct: lower.toString(), weightedNumerator: best.numerator.toString(), upperProduct: upper.toString(), inclusive: true },
    usage: ingredients.map((row, i) => ({ ingredientId: row.id, parts: best.counts[i], maxParts: row.maxParts, remainingParts: row.maxParts - best.counts[i],
      fractionPermille: fractions[row.id], costPerPart: row.costPerPart, ingredientCost: (BigInt(best.counts[i]) * BigInt(row.costPerPart)).toString() }))
  };
  const result = { status: best === null ? 'infeasible' : 'feasible', evaluatedCompositionCount, feasibleCount, tiedOptimalCount, recipe,
    fractions, exactIntegerParts: true, mixingPerformed: false, purchasesMade: false };
  return { ...result, analysisHash: hash(result) };
}
export function recipeBlend(rawInput, answers) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!Array.isArray(answers) || answers.length !== tasks.length || Array.from(answers).some((row, index) => !keys(row, ['ingredientId', 'text']) || row.ingredientId !== tasks[index].id || row.text !== null && typeof row.text !== 'string')) throw new Error('Provide one ordered answer or missing outcome for every ingredient.');
  const outcomes = answers.map(row => row.text === null ? { kind: 'missing', fraction: null } : parseFraction(row.text));
  if (outcomes.some(row => row.kind !== 'quantity')) return { status: 'incomplete', analysis: null };
  return { status: 'complete', analysis: minimumBlend(input, Object.fromEntries(tasks.map((row, index) => [row.id, outcomes[index].fraction]))) };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || state.credentialHash.length !== 64 || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > tasks.length || iso(state.startedAt) !== state.startedAt) {
    throw new Error('Invalid state or changed ingredient manifest. Restore the original inputs.');
  }
  validateConfig(state.config);
  const ids = new Set(), questionIds = new Set();
  let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'taskId', 'createdAt', 'request', 'questionId', 'status', 'observation'])
      || !isId(attempt.id) || ids.has(attempt.id) || attempt.taskId !== tasks[index].id
      || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.taskId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) {
      throw new Error('Invalid saved fraction request.');
    }
    ids.add(attempt.id);
    previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId);
      validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS
        || attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates creation intent.');
      previous = attempt.observation.checkedAt;
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) {
      throw new Error('Only the last task may have an active Question.');
    }
  }
  return state;
}

export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const answers = tasksFor(input).map(ingredient => {
    const attempt = state.attempts.find(row => row.taskId === ingredient.id), answer = attempt?.observation?.answer;
    return { ingredientId: ingredient.id, ingredientHash: hash(ingredient), status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      text: answer?.text ?? null, kind: answer?.kind ?? null, fraction: answer?.fraction ?? null,
      questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const calculation = recipeBlend(input, answers.map(({ ingredientId, text }) => ({ ingredientId, text })));
  const active = answers.find(row => ['create_unknown', 'pending'].includes(row.status));
  const status = active?.status ?? (answers.some(row => row.status === 'unasked') ? 'ready' : calculation.status);
  const evidence = { blendId: input.blendId, source: input, sourceHash: hash(input), configHash: hash(state.config), policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, answers, analysis: calculation.analysis, mixingPerformed: false, purchasesMade: false };
  return { ...evidence, status, proposal: calculation.status === 'complete' && calculation.analysis.status === 'feasible' ? { ...evidence, status: 'complete' } : null };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['text', 'kind', 'fraction', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || hash(parseFraction(answer.text)) !== hash({ kind: answer.kind, fraction: answer.fraction })
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved fraction evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered tasks must not contain fraction evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || hash(q.text_input) !== hash(request.text_input) || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== 0) throw new Error('Question does not match the saved task, room, or blend operator.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.value !== null || answer.label !== null || answer.responder?.id !== request.target_user_id || typeof answer.text !== 'string' || answer.text.length > 60) throw new Error('Invalid text answer.');
      observation.answer = { text: answer.text, ...parseFraction(answer.text), responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
