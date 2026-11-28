'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../src/core.js');

const pulsoCard = (sets, extra) => Object.assign(C.newCard('Supino', 'Peito', { p: '2×6–8 RIR 1', l: '60×8, 60×7' }), { sets }, extra);
const pulsoSet = (kg, reps, rir = '') => ({ kg: String(kg), reps: String(reps), rir });

test('Pulso only reads explicit set prescriptions, without guessing prose', () => {
  for (const p of ['2×6–8 RIR 1', ' 2 x 8 ', '2*8-10 RIR 2']) assert.equal(C.plannedSets(p), 2);
  for (const p of ['', null, 'até 2×8', '2×8 + drop', '0×8', 'livre', '?×8 · RIR 0', '2×? · 90 s', '2×8 · alt.:']) assert.equal(C.plannedSets(p), null);
  // what the sheet really sends: Sessions.prescriptionText
  const S = require('../../sheet4/test/harness').load().Sessions;
  const p = { sets: 2, repsMin: 6, repsMax: 10, rirMax: 1, restS: 150, alternative: null, setModel: null };
  for (const [over, sets] of [[{}, 2], [{ rirMax: 0 }, 2], [{ rirMax: null, restS: null }, 2], [{ repsMin: 8, repsMax: 8, sets: 3 }, 3],
    [{ alternative: 'Supino máquina · 3×8' }, 2], [{ rirMax: 1.5 }, 2], [{ restS: 90.5 }, 2], [{ alternative: 'Supino\nmáquina 4×8' }, 2], [{ sets: null }, null], [{ repsMin: null, repsMax: null }, null]]) {
    const text = S.prescriptionText({ ...p, ...over });
    assert.equal(C.plannedSets(text), sets, text);
  }
  assert.equal(S.prescriptionText(p), '2×6–10 · RIR 0–1 · 150 s');
});

test('Pulso requires all sets of each planned exercise; extra sets do not fill another exercise', () => {
  const a = pulsoCard([pulsoSet(60, 8), pulsoSet(60, 8), pulsoSet(60, 8)]);
  const b = pulsoCard([pulsoSet(50, 8)]);
  assert.equal(C.pulsoPlan([a, b]).remaining, 1);
  assert.equal(C.pulsoPlan([a, b]).complete, false);
  b.sets.push(pulsoSet(50, 8));
  assert.equal(C.pulsoPlan([a, b]).complete, true);
  assert.equal(C.pulsoPlan([a, pulsoCard([], { p: 'livre' })]).known, false);
  assert.equal(C.pulsoPlan([]).complete, false);
  assert.equal(C.pulsoPlan([a, pulsoCard([], { fromPlan: false })]).complete, true);
});

test('Pulso gain compares the same numbered set and formats decimal deltas in Portuguese', () => {
  assert.deepEqual(C.pulsoGain(pulsoCard([pulsoSet('62,5', 6)]), 0), { value: 2.5, unit: 'kg', line: '+2,5 kg em relação à última vez' });
  assert.equal(C.pulsoGain(pulsoCard([pulsoSet(60, 8), pulsoSet(60, 9)]), 1).line, '+2 reps em relação à última vez');
  assert.equal(C.pulsoGain(pulsoCard([pulsoSet('17,6', 8)], { l: '17,5×8' }), 0).value, 0.1);
  assert.equal(C.pulsoGain(pulsoCard([pulsoSet('60,000001', 8)]), 0), null, 'never display a rounded +0 gain');
  for (const sets of [[pulsoSet(60, 8)], [pulsoSet(59, 20)], [pulsoSet(70, '')], [pulsoSet(70, '2,5')], [pulsoSet(1001, 8)], [pulsoSet(70, 8, '99')]]) {
    assert.equal(C.pulsoGain(pulsoCard(sets), 0), null);
  }
  assert.equal(C.pulsoGain(pulsoCard([pulsoSet(70, 8)], { l: 'sem registro' }), 0), null);
  assert.equal(C.pulsoGain(pulsoCard([pulsoSet(70, 8), pulsoSet(70, 8), pulsoSet(70, 8)]), 2), null);
});

test('Pulso cycles applicable tips from the current exercise and plan', () => {
  const context = { view: 'workout', cards: [pulsoCard([]), pulsoCard([], { name: 'Remada' })], cardIndex: 0 };
  const tips = C.pulsoTips(context);
  assert.match(tips[0], /Supino, última vez: 60 kg × 8/);
  assert.equal(tips[1], 'Faltam 4 séries planejadas.');
  assert.equal(tips[2], 'Depois de Supino: Remada.');
  assert.equal(C.pulsoTip(context, 3).line, tips[0]);
  assert.equal(C.pulsoTip(context, -1).line, tips[0]);
  assert.equal(C.pulsoTip(Object.assign({}, context, { cardIndex: null }), 0).line, tips[0]);
  context.cardIndex = 1;
  assert.match(C.pulsoTip(context, 0).line, /^Remada/);
  const unknown = { view: 'workout', cards: [pulsoCard([], { p: 'livre', l: '' })] };
  assert.deepEqual(C.pulsoTips(unknown), ['Tô por aqui. Um registro de cada vez.']);
});

test('Pulso meal tips distinguish description without quantity from a missing required food quantity', () => {
  const context = { view: 'food', items: [{ kind: 'food', food: 'Arroz', qty: '' }] };
  assert.deepEqual(C.pulsoTips(context), ['Seu prato tem 1 item.']);
  context.compose = { kind: 'description', description: 'pastel', qty: '' };
  assert.equal(C.pulsoTips(context)[1], 'A descrição sem quantidade entra no diário sem cálculo.');
  context.compose.qty = '1';
  assert.equal(C.pulsoTips(context).length, 1);
});

test('Pulso reacts once to a gain and gives completion priority when both happen together', () => {
  const before = [pulsoCard([pulsoSet(60, 8), pulsoSet('', '')])];
  const after = [pulsoCard([pulsoSet(60, 8), pulsoSet('62,5', 8)])];
  const full = C.pulsoReaction(before, after, 0, 1);
  assert.equal(full.pulse, 'full');
  assert.match(full.line, /Todas as séries planejadas.*\+2,5 kg/);
  assert.equal(C.pulsoReaction(after, after, 0, 1), null);
  const extra = [pulsoCard([pulsoSet(60, 8), pulsoSet(70, 8)], { p: '3×8' })];
  assert.equal(C.pulsoReaction(before, extra, 0, 1).pulse, 'celebrate');
  const lower = [pulsoCard([pulsoSet(60, 8), pulsoSet(65, 8)], { p: '3×8' })];
  assert.equal(C.pulsoReaction(extra, lower, 0, 1), null, 'lowering a current gain does not celebrate');
});

test('Pulso summaries use valid sets and the best known gain, without asserting delivery', () => {
  assert.equal(C.pulsoSummary({ view: 'workout', cards: [pulsoCard([pulsoSet('62,5', 8), pulsoSet(70, '')])] }), '1 série neste treino. Supino: +2,5 kg em relação à última vez.');
  assert.equal(C.pulsoSummary({ view: 'food', items: [{}, {}] }), '2 itens nesta refeição.');
  assert.equal(C.pulsoSummary({ cards: [] }), 'Sessão pronta para conferir.');
});

test('Pulso error decisions preserve the first field target and all remaining error counts', () => {
  assert.equal(C.pulsoError([]), null);
  assert.deepEqual(C.pulsoError([{ message: 'kg: obrigatório', card: 0, path: 'exercises[0].work[1].kg' }, { message: 'reps' }]), {
    mood: 'alert', pulse: 'no', line: 'kg: obrigatório (e mais 1 ajuste)', card: 0, item: undefined, path: 'exercises[0].work[1].kg',
  });
});

test('Pulso dozes at 45 seconds, except while busy', () => {
  assert.equal(C.pulsoDozing(44999, false), false);
  assert.equal(C.pulsoDozing(45000, false), true);
  assert.equal(C.pulsoDozing(90000, true), false);
});

test('Pulso counts current catalog prescriptions even when an older draft lacks a planned exercise', () => {
  const rows = [{ e: 'Supino', p: '2×8' }, { e: 'Remada', p: '2×8' }];
  const cards = [pulsoCard([pulsoSet(60, 8), pulsoSet(60, 8)])];
  const plan = C.pulsoPlan(cards, rows);
  assert.equal(plan.total, 4);
  assert.equal(plan.remaining, 2);
  assert.equal(plan.complete, false);
  assert.equal(C.pulsoPlan(cards, []).complete, false);
  assert.ok(C.pulsoTips({ cards, plan: rows }).includes('Faltam 2 séries planejadas.'));
});

test('Pulso acknowledges repeat-last unless that same action completes the current plan', () => {
  const before = [pulsoCard([])];
  const after = [pulsoCard([pulsoSet(60, 8), pulsoSet(60, 7)])];
  assert.equal(C.pulsoReaction(before, after, 0, undefined, { action: 'repeat' }).pulse, 'full');
  const rows = [{ e: 'Supino', p: '2×8' }, { e: 'Remada', p: '2×8' }];
  assert.equal(C.pulsoReaction(before, after, 0, undefined, { action: 'repeat', plan: rows }).line, 'Última carga copiada. Ajuste o que mudou hoje.');
});

/** The bot's encoding: base64url_nopad(raw_deflate(utf8(json_compact(catalog)))), zlib wbits=-15. */
function pythonBlob(obj, level) {
  const json = JSON.stringify(obj);
  const raw = zlib.deflateRawSync(Buffer.from(json, 'utf8'), { level: level === undefined ? 9 : level, windowBits: 15 });
  return Buffer.from(raw).toString('base64url');
}
const nodeInflate = (bytes) => new Uint8Array(zlib.inflateRawSync(Buffer.from(bytes)));

const SPEC_CATALOG = {
  v: 1,
  today: '2026-11-09',
  tz: 'America/Sao_Paulo',
  client: 'Luan',
  next: 'Push A',
  sessions: ['Push A', 'Pull A', 'Legs A'],
  plan: [{ s: 'Push A', e: 'Supino reto', g: 'Peito', p: '2×6–8 RIR 1', l: '80×8, 80×7' }],
  ex: [['Supino reto', 'Peito']],
  foods: ['Arroz branco cozido'],
  fav: ['Café da manhã padrão'],
  meals: ['Café da manhã', 'Almoço'],
  units: ['g', 'ml', 'un'],
};

/* catalog decode ------------------------------------------------------------------------------- */

test('decodes the spec catalog encoded the Python way (zlib inflateRawSync)', async () => {
  const blob = pythonBlob(SPEC_CATALOG);
  assert.match(blob, /^[A-Za-z0-9_-]+$/, 'base64url, no padding');
  const cat = await C.decodeCatalog(blob, nodeInflate);
  assert.equal(cat.next, 'Push A');
  assert.deepEqual(cat.sessions, ['Push A', 'Pull A', 'Legs A']);
  assert.deepEqual(cat.plan[0], { s: 'Push A', e: 'Supino reto', g: 'Peito', p: '2×6–8 RIR 1', l: '80×8, 80×7' });
  assert.deepEqual(cat.ex, [{ name: 'Supino reto', group: 'Peito' }]);
  assert.deepEqual(cat.foods, ['Arroz branco cozido']);
  assert.deepEqual(cat.fav, ['Café da manhã padrão']);
  assert.deepEqual(cat.units, ['g', 'ml', 'un']);
});

test('the JS inflate fallback matches zlib for every block type', async () => {
  const big = { ...SPEC_CATALOG, foods: Array.from({ length: 300 }, (_, i) => `Alimento genérico número ${i} com acentuação ção`) };
  for (const level of [0, 1, 6, 9]) {
    const blob = pythonBlob(big, level);
    const viaJs = await C.decodeCatalog(blob, (b) => C.inflateRaw(b));
    const viaZlib = await C.decodeCatalog(blob, nodeInflate);
    assert.deepEqual(viaJs, viaZlib, `level ${level}`);
    assert.equal(viaJs.foods.length, 300);
  }
  // Fixed-Huffman block (short input) and random bytes (mostly stored/dynamic).
  const short = zlib.deflateRawSync(Buffer.from('ab'));
  assert.equal(Buffer.from(C.inflateRaw(short)).toString(), 'ab');
  const rnd = Buffer.alloc(5000);
  for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 7919 + (i >> 3) * 31) & 0xff;
  assert.deepEqual(Buffer.from(C.inflateRaw(zlib.deflateRawSync(rnd))), rnd);
});

test('the default browser inflate path works where DecompressionStream exists (Node 22)', async () => {
  const cat = await C.decodeCatalog(pythonBlob(SPEC_CATALOG));
  assert.equal(cat.client, 'Luan');
});

test('corrupt or foreign blobs are rejected', async () => {
  await assert.rejects(C.decodeCatalog('!!!', nodeInflate), /base64url/);
  assert.throws(() => C.inflateRaw(new Uint8Array([0xff, 0xff])), /inflate/);
  await assert.rejects(C.decodeCatalog(pythonBlob({ v: 2 }), nodeInflate), /versão/);
  await assert.rejects(C.decodeCatalog(pythonBlob([1, 2]), nodeInflate), /inválido/);
});

test('base64url decodes with and without padding, including the URL alphabet', () => {
  const bytes = Buffer.from([0xfb, 0xff, 0xbf, 0x00, 0x10]);
  assert.deepEqual(Buffer.from(C.base64UrlToBytes(bytes.toString('base64url'))), bytes);
  assert.deepEqual(Buffer.from(C.base64UrlToBytes(bytes.toString('base64'))), bytes);
});

test('muscleEntries resolves exercises to their group and adds the week on request', () => {
  const cat = C.normalizeCatalog({ v: 1, ex: [['Supino reto', 'Peito'], ['Prancha', '']], wk: [['Costas', 4]] });
  const items = [{ name: 'supino RETO', sets: 2 }, { name: 'Prancha', sets: 3 }, { name: 'Desconhecido', sets: 1 }, { name: 'Supino reto', sets: 0 }, null];
  assert.deepEqual(C.muscleEntries(cat, items, false), [{ group: 'Peito', sets: 2 }]);
  assert.deepEqual(C.muscleEntries(cat, items, true), [{ group: 'Costas', sets: 4 }, { group: 'Peito', sets: 2 }]);
  assert.deepEqual(C.muscleEntries(cat, [], true), [{ group: 'Costas', sets: 4 }]);
  assert.equal(cat.week.length, 1, 'the catalog is not changed');
});

test('an exercise without a group in the catalogue takes the group of its plan row', () => {
  const cat = C.normalizeCatalog({
    v: 1,
    ex: [['Supino', ''], ['Remada', 'Costas']],
    plan: [{ s: 'Upper', e: 'Supino', g: 'Peito' }, { s: 'Upper', e: 'Remada', g: 'Dorsal' }],
  });
  assert.deepEqual(cat.ex, [{ name: 'Supino', group: 'Peito' }, { name: 'Remada', group: 'Costas' }]);
  assert.deepEqual(C.muscleEntries(cat, [{ name: 'Supino', sets: 2 }], false), [{ group: 'Peito', sets: 2 }]);
});

test('normalizeCatalog reads the week (wk) and drops malformed rows', () => {
  const wk = [['Peito', 6], ['  Costas ', 2], ['Ombros', 0], ['', 3], ['Bíceps', '2'], 'x', ['Tríceps', Infinity]];
  assert.deepEqual(C.normalizeCatalog({ v: 1, wk }).week, [{ group: 'Peito', sets: 6 }, { group: 'Costas', sets: 2 }]);
  assert.deepEqual(C.normalizeCatalog({ v: 1 }).week, []);
  assert.deepEqual(C.normalizeCatalog({ v: 1, wk: 'x' }).week, []);
});

test('normalizeCatalog fills defaults, keeps foods null when dropped, merges plan into lists', () => {
  const cat = C.normalizeCatalog({
    v: 1, tz: 'Not/AZone', next: 'Upper',
    plan: [{ s: 'Lower', e: 'Leg press', g: 'Quadríceps' }, { s: 'Lower' }],
    ex: [['Supino', 'Peito'], 'Remada', ['supino', 'x']],
  });
  assert.equal(cat.tz, 'America/Sao_Paulo');
  assert.deepEqual(cat.sessions, ['Upper', 'Lower']);
  assert.equal(cat.next, 'Upper');
  assert.deepEqual(cat.ex.map((e) => e.name), ['Supino', 'Remada', 'Leg press']);
  assert.equal(cat.foods, null);
  assert.deepEqual(cat.meals, C.DEFAULT_MEALS);
  assert.deepEqual(cat.units, ['g', 'mg', 'kg', 'ml', 'l', 'un', 'fatia', 'colher', 'porção']);
  assert.deepEqual(cat.plan, [{ s: 'Lower', e: 'Leg press', g: 'Quadríceps', p: '', l: '' }]);
});

test('parseHash: plain fragment (preview / browser)', () => {
  assert.deepEqual(C.parseHash('#v=food&c=abc-_9'), { view: 'food', blob: 'abc-_9', telegram: false });
  assert.deepEqual(C.parseHash(''), { view: 'workout', blob: '', telegram: false });
  assert.deepEqual(C.parseHash('#v=evil&c=not+base64/'), { view: 'workout', blob: '', telegram: false });
});

test('parseHash: Telegram params appended with "&"', () => {
  const h = '#v=food&c=abc-_9&tgWebAppData=query_id%3DAA%26user%3D1&tgWebAppVersion=8.0&tgWebAppPlatform=android&tgWebAppThemeParams=%7B%22bg_color%22%3A%22%23fff%22%7D';
  assert.deepEqual(C.parseHash(h), { view: 'food', blob: 'abc-_9', telegram: true });
});

test('parseHash: Telegram params appended with "?"; first v/c win; search fallback', () => {
  assert.deepEqual(C.parseHash('#v=workout&c=XYZ?tgWebAppVersion=7.10&tgWebAppPlatform=ios&c=OTHER&v=food'), { view: 'workout', blob: 'XYZ', telegram: true });
  assert.deepEqual(C.parseHash('#tgWebAppVersion=8.0', '?v=food&c=QRS'), { view: 'food', blob: 'QRS', telegram: true });
  assert.deepEqual(C.parseHash('#v=food', '?v=workout&c=QRS'), { view: 'food', blob: 'QRS', telegram: false });
});

test('the sample catalog is valid and generic', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dev', 'sample-catalog.json'), 'utf8'));
  const cat = C.normalizeCatalog(raw);
  assert.ok(cat.sessions.includes(cat.next));
  assert.ok(cat.plan.length >= 4);
  assert.ok(Array.isArray(cat.foods) && cat.foods.length >= 8);
  assert.doesNotMatch(JSON.stringify(raw), /Luan|Breno|Zoio/i);
});

/* numbers, text, dates ------------------------------------------------------------------------- */

test('parseDecimal reads Brazilian input and refuses ambiguous text', () => {
  assert.equal(C.parseDecimal('82,5'), 82.5);
  assert.equal(C.parseDecimal(' 80 '), 80);
  assert.equal(C.parseDecimal('7.5'), 7.5);
  assert.equal(C.parseDecimal(',5'), 0.5);
  assert.equal(C.parseDecimal(''), null);
  assert.equal(C.parseDecimal('   '), null);
  assert.equal(C.parseDecimal(null), null);
  assert.equal(C.parseDecimal(12), 12);
  for (const bad of ['82,', 'abc', '1,2,3', '-5', '1e3', '80kg', 'NaN']) assert.ok(Number.isNaN(C.parseDecimal(bad)), bad);
});

test('formatBR and stepValue', () => {
  assert.equal(C.formatBR(82.5), '82,5');
  assert.equal(C.formatBR(80), '80');
  assert.equal(C.formatBR(0.1 + 0.2), '0,3');
  assert.equal(C.formatBR(''), '');
  assert.equal(C.stepValue('80', 2.5, 0, 1000), '82,5');
  assert.equal(C.stepValue('82,5', -2.5, 0, 1000), '80');
  assert.equal(C.stepValue('1', -2.5, 0, 1000), '0');
  assert.equal(C.stepValue('999', 2.5, 0, 1000), '1000');
  assert.equal(C.stepValue('', 2.5, 0, 1000, 80), '80', 'first tap uses the suggestion');
  assert.equal(C.stepValue('', 2.5, 0, 1000), '2,5');
  assert.equal(C.stepValue('', 1, 1, 100), '1');
  assert.equal(C.stepValue('', -1, 0, 10), '0');
  assert.equal(C.stepValue('abc', 1, 1, 100, 8), '8');
});

test('fold and search are accent- and case-insensitive with sensible ranking', () => {
  assert.equal(C.fold('  Feijão  CARIOCA '), 'feijao carioca');
  const list = ['Pão francês', 'Pão de queijo', 'Requeijão', 'Arroz branco cozido', 'Feijão carioca cozido', 'Queijo minas'];
  assert.deepEqual(C.search('pao', list), ['Pão francês', 'Pão de queijo']);
  assert.deepEqual(C.search('QUEIJO', list), ['Queijo minas', 'Pão de queijo']);
  assert.deepEqual(C.search('cozido feij', list), ['Feijão carioca cozido']);
  assert.deepEqual(C.search('', list, 2), list.slice(0, 2));
  assert.deepEqual(C.search('zzz', list), []);
  assert.deepEqual(C.search('sup', [{ name: 'Supino reto' }, { name: 'Remada' }], 5, (x) => x.name), [{ name: 'Supino reto' }]);
});

test('utf8Bytes counts bytes, not characters', () => {
  assert.equal(C.utf8Bytes('abc'), 3);
  assert.equal(C.utf8Bytes('ção'), 5);
  assert.equal(C.utf8Bytes('×'), 2);
  assert.equal(C.utf8Bytes('🏋️'), 7);
});

test('todayIn uses the catalog time zone, not the machine clock', () => {
  const lateNightUtc = new Date('2026-11-10T02:30:00Z'); // 23:30 on the 9th in São Paulo
  assert.equal(C.todayIn('America/Sao_Paulo', lateNightUtc), '2026-11-09');
  assert.equal(C.todayIn('Asia/Tokyo', lateNightUtc), '2026-11-10');
  assert.equal(C.todayIn('Bad/Zone', lateNightUtc), '2026-11-09');
  assert.deepEqual(C.dateOptions('America/Sao_Paulo', lateNightUtc).map((d) => d.key), ['2026-11-09', '2026-11-08']);
  assert.equal(C.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(C.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(C.shortDate('2026-11-09'), '09/11');
  assert.equal(C.weekday('2026-11-09'), 'seg');
  assert.ok(C.isDateKey('2026-02-28'));
  assert.ok(!C.isDateKey('2026-02-30'));
  assert.ok(!C.isDateKey('1999-01-01'));
});

/* last work ------------------------------------------------------------------------------------ */

test('parseLastWork understands the spec and the sheet formats', () => {
  assert.deepEqual(C.parseLastWork('80×8, 80×7'), [{ kg: 80, reps: 8 }, { kg: 80, reps: 7 }]);
  assert.deepEqual(C.parseLastWork('82,5x8; 80X7'), [{ kg: 82.5, reps: 8 }, { kg: 80, reps: 7 }]);
  assert.deepEqual(C.parseLastWork('80 kg × 8 (RIR 1) · 77,5 kg × 7 (RIR 2)'), [{ kg: 80, reps: 8, rir: 1 }, { kg: 77.5, reps: 7, rir: 2 }]);
  assert.deepEqual(C.parseLastWork('60×10 @2'), [{ kg: 60, reps: 10, rir: 2 }]);
  assert.deepEqual(C.parseLastWork('40×12, 40×12, 40×10'), [{ kg: 40, reps: 12 }, { kg: 40, reps: 12 }], 'at most 2 work sets');
  assert.deepEqual(C.parseLastWork('80 kg × 8 (RIR 1,5)'), [{ kg: 80, reps: 8, rir: 1.5 }], 'RIR may be decimal');
  assert.deepEqual(C.parseLastWork('80 kg × 8 (RIR 12)'), [{ kg: 80, reps: 8 }], 'out-of-range RIR is dropped');
});

test('parseLastWork returns null instead of guessing', () => {
  for (const t of ['', '   ', 'Sem registro', '80×', '80×8, falhei', '2000×5', '80×0', null, 42]) {
    assert.equal(C.parseLastWork(t), null, String(t));
  }
});

test('repeatSets turns last work into field texts', () => {
  assert.deepEqual(C.repeatSets('82,5×8, 80×7'), [{ kg: '82,5', reps: '8', rir: '' }, { kg: '80', reps: '7', rir: '' }]);
  assert.equal(C.repeatSets('?'), null);
});

/* workout -------------------------------------------------------------------------------------- */

const CAT = C.normalizeCatalog(SPEC_CATALOG);
const TODAY = '2026-11-09';

function card(name, sets, extra) {
  return Object.assign(C.newCard(name, ''), { sets }, extra || {});
}

test('buildWorkout produces exactly the spec args, skipping empty cards', () => {
  const cat = C.normalizeCatalog({ ...SPEC_CATALOG, ex: [['Supino reto', 'Peito'], ['Crucifixo', 'Peito']] });
  const state = {
    date: TODAY, session: 'Push A', complete: false,
    cards: [
      card('Supino reto', [{ kg: '80', reps: '8', rir: '1' }], { warmup: { kg: '40', reps: '10' }, pain: '0', note: '  ombro ok ' }),
      card('Crucifixo', [C.newSet()]),
    ],
  };
  const r = C.buildWorkout(state, cat, { today: TODAY });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.args, {
    date: '2026-11-09', session: 'Push A', complete: false,
    exercises: [{ name: 'Supino reto', work: [{ kg: 80, reps: 8, rir: 1 }], warmup: { kg: 40, reps: 10 }, pain: 0, note: 'ombro ok' }],
  });
  const p = C.serializePayload('workout', r.args);
  assert.equal(p.json, '{"v":1,"t":"workout","args":{"date":"2026-11-09","session":"Push A","complete":false,"exercises":[{"name":"Supino reto","work":[{"kg":80,"reps":8,"rir":1}],"warmup":{"kg":40,"reps":10},"pain":0,"note":"ombro ok"}]}}');
  assert.ok(p.ok);
});

test('buildWorkout converts Brazilian decimals and omits blank optional fields', () => {
  const r = C.buildWorkout({ date: TODAY, session: 'Push A', cards: [card('Supino reto', [{ kg: '82,5', reps: '8', rir: '' }, { kg: '80', reps: '7', rir: '2' }])] }, CAT, { today: TODAY });
  assert.deepEqual(r.args.exercises[0], { name: 'Supino reto', work: [{ kg: 82.5, reps: 8 }, { kg: 80, reps: 7, rir: 2 }] });
  const half = C.buildWorkout({ date: TODAY, session: 'Push A', cards: [card('Supino reto', [{ kg: '80', reps: '8', rir: '1,5' }])] }, CAT, { today: TODAY });
  assert.deepEqual(half.args.exercises[0].work, [{ kg: 80, reps: 8, rir: 1.5 }], 'RIR is a number, decimals allowed');
});

test('buildWorkout: names are unique ignoring case and accents; complete defaults to false', () => {
  const cat = C.normalizeCatalog({ ...SPEC_CATALOG, ex: [['Elevação lateral', 'Ombros'], ['Elevacao Lateral', 'Ombros']] });
  const r = C.buildWorkout({ date: TODAY, session: 'Push A', cards: [card('Elevação lateral', [{ kg: '8', reps: '12' }])] }, cat, { today: TODAY });
  assert.equal(r.args.complete, false);
  assert.deepEqual(cat.ex.map((e) => e.name), ['Elevação lateral', 'Supino reto'], 'catalog duplicates collapse (plan adds Supino reto)');
  const dup = C.buildWorkout({ date: TODAY, session: 'Push A', cards: [card('Supino reto', [{ kg: '1', reps: '1' }]), card('SUPINO RETO', [{ kg: '2', reps: '2' }])] },
    C.normalizeCatalog({ ...SPEC_CATALOG, ex: [['Supino reto', 'Peito'], ['SUPINO RETO', 'Peito']] }), { today: TODAY });
  assert.ok(dup.errors.some((e) => /repetido/.test(e.message)));
  const old = C.buildWorkout({ date: '1999-12-31', session: 'Push A', cards: [card('Supino reto', [{ kg: '1', reps: '1' }])] }, CAT, { today: TODAY });
  assert.ok(old.errors.some((e) => e.path === 'date'), 'dates before 2000 are refused');
});

test('buildWorkout mirrors the sheet limits', () => {
  const bad = card('Supino reto', [{ kg: '1001', reps: '8,5', rir: '11' }, { kg: '', reps: '101', rir: '' }], {
    feeder: { kg: '50', reps: '' }, pain: '11', note: 'x'.repeat(201),
  });
  const r = C.buildWorkout({ date: '2026-11-10', session: 'Inexistente', cards: [bad] }, CAT, { today: TODAY });
  assert.equal(r.args, null);
  const msgs = r.errors.map((e) => e.message).join('\n');
  for (const frag of ['Data no futuro', 'Escolha uma sessão', 'série 1, kg: entre 0 e 1000', 'série 1, reps: use um número inteiro',
    'série 1, RIR: entre 0 e 10', 'série 2, kg: obrigatório', 'série 2, reps: entre 1 e 100', 'feeder, reps: obrigatório',
    'dor: entre 0 e 10', 'nota: máximo 200']) {
    assert.ok(msgs.includes(frag), `missing "${frag}" in\n${msgs}`);
  }
  assert.ok(r.errors.filter((e) => e.card === 0).length >= 8);
});

test('buildWorkout refuses a third work set, unknown and repeated exercises, and work-less cards', () => {
  const three = card('Supino reto', [{ kg: '80', reps: '8' }, { kg: '80', reps: '8' }, { kg: '80', reps: '8' }]);
  let r = C.buildWorkout({ date: TODAY, session: 'Push A', cards: [three] }, CAT, { today: TODAY });
  assert.ok(r.errors.some((e) => /no máximo 2 séries/.test(e.message)));
  r = C.buildWorkout({ date: TODAY, session: 'Push A', cards: [card('Supino inventado', [{ kg: '1', reps: '1' }])] }, CAT, { today: TODAY });
  assert.ok(r.errors.some((e) => /não está no catálogo/.test(e.message)));
  r = C.buildWorkout({ date: TODAY, session: 'Push A', cards: [card('Supino reto', [{ kg: '1', reps: '1' }]), card('Supino reto', [{ kg: '2', reps: '2' }])] }, CAT, { today: TODAY });
  assert.ok(r.errors.some((e) => /repetido/.test(e.message) && e.card === 1));
  r = C.buildWorkout({ date: TODAY, session: 'Push A', cards: [card('Supino reto', [C.newSet()], { note: 'só nota' })] }, CAT, { today: TODAY });
  assert.ok(r.errors.some((e) => /ao menos uma série/.test(e.message)));
});

test('buildWorkout: nothing filled needs complete=true; 16 exercises is too many', () => {
  let r = C.buildWorkout({ date: TODAY, session: 'Push A', cards: [card('Supino reto', [C.newSet()])] }, CAT, { today: TODAY });
  assert.ok(r.errors.some((e) => e.path === 'exercises'));
  r = C.buildWorkout({ date: TODAY, session: 'Push A', complete: true, cards: [] }, CAT, { today: TODAY });
  assert.deepEqual(r.args, { date: TODAY, session: 'Push A', complete: true, exercises: [] });
  const names = Array.from({ length: 16 }, (_, i) => `Ex ${i}`);
  const cat = C.normalizeCatalog({ ...SPEC_CATALOG, ex: names.map((n) => [n, '']) });
  r = C.buildWorkout({ date: TODAY, session: 'Push A', cards: names.map((n) => card(n, [{ kg: '10', reps: '10' }])) }, cat, { today: TODAY });
  assert.ok(r.errors.some((e) => /No máximo 15/.test(e.message)));
});

test('planCards follows the plan of the chosen session; cardIsEmpty', () => {
  const cards = C.planCards(CAT, 'Push A');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].p, '2×6–8 RIR 1');
  assert.equal(cards[0].l, '80×8, 80×7');
  assert.ok(C.cardIsEmpty(cards[0]));
  cards[0].pain = '0';
  assert.ok(!C.cardIsEmpty(cards[0]));
  assert.deepEqual(C.planCards(CAT, 'Pull A'), []);
});

/* food ----------------------------------------------------------------------------------------- */

test('buildFood produces exactly the spec args', () => {
  const state = {
    date: TODAY, meal: 'Almoço',
    items: [
      { kind: 'food', food: 'Arroz branco cozido', qty: '150', unit: 'g', measure: 'Pesada' },
      { kind: 'favorite', favorite: 'Café da manhã padrão', portions: '1' },
      { kind: 'description', description: ' pastel de feira ', qty: '1', unit: 'un' },
    ],
  };
  const r = C.buildFood(state, CAT, { today: TODAY });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.args, {
    date: '2026-11-09', meal: 'Almoço', items: [
      { food: 'Arroz branco cozido', qty: 150, unit: 'g', measure: 'Pesada' },
      { favorite: 'Café da manhã padrão', portions: 1 },
      { description: 'pastel de feira', qty: 1, unit: 'un' },
    ],
  });
  for (const it of r.args.items) {
    assert.equal(['food', 'favorite', 'description'].filter((k) => k in it).length, 1, 'exactly one form per item');
  }
});

test('buildFood mirrors the sheet limits and never invents catalog names', () => {
  const r = C.buildFood({
    date: TODAY, meal: '',
    items: [
      { kind: 'food', food: 'Pizza inventada', qty: '0', unit: 'g', measure: 'Chute' },
      { kind: 'favorite', favorite: 'Não existe', portions: '51' },
      { kind: 'description', description: '', qty: '1,5', unit: 'x'.repeat(21) },
      { kind: 'food', food: 'Arroz branco cozido', qty: '' },
    ],
  }, CAT, { today: TODAY });
  const msgs = r.errors.map((e) => e.message).join('\n');
  for (const frag of ['Escolha a refeição', 'Item 1: alimento fora do catálogo', 'Item 1: quantidade: entre 0,001 e 100000', 'Item 1: medição',
    'Item 2: favorita fora do catálogo', 'Item 2: porções: entre 0,01 e 50', 'Item 3: descrição: obrigatório', 'Item 3: unidade: máximo 20',
    'Item 4: quantidade: obrigatório']) {
    assert.ok(msgs.includes(frag), `missing "${frag}" in\n${msgs}`);
  }
  assert.equal(r.args, null);
});

test('buildFood accepts free food names only when the catalog dropped `foods`', () => {
  const dropped = C.normalizeCatalog({ ...SPEC_CATALOG, foods: undefined });
  const state = { date: TODAY, meal: 'Almoço', items: [{ kind: 'food', food: 'Feijão preto', qty: '100', unit: 'g' }] };
  assert.deepEqual(C.buildFood(state, dropped, { today: TODAY }).errors, []);
  assert.ok(C.buildFood(state, CAT, { today: TODAY }).errors.length > 0);
});

test('buildFood item count 1..20 and meal ≤ 60', () => {
  const item = { kind: 'favorite', favorite: 'Café da manhã padrão' };
  let r = C.buildFood({ date: TODAY, meal: 'Almoço', items: [] }, CAT, { today: TODAY });
  assert.ok(r.errors.some((e) => e.path === 'items'));
  r = C.buildFood({ date: TODAY, meal: 'Almoço', items: Array(21).fill(item) }, CAT, { today: TODAY });
  assert.ok(r.errors.some((e) => /No máximo 20/.test(e.message)));
  r = C.buildFood({ date: TODAY, meal: 'x'.repeat(61), items: [item] }, CAT, { today: TODAY });
  assert.ok(r.errors.some((e) => /máximo 60/.test(e.message)));
  r = C.buildFood({ date: TODAY, meal: 'Almoço', items: Array(20).fill(item) }, CAT, { today: TODAY });
  assert.equal(r.args.items.length, 20);
});

/* payload & draft ------------------------------------------------------------------------------ */

test('serializePayload enforces 4096 UTF-8 bytes', () => {
  const small = C.serializePayload('food', { date: TODAY, meal: 'Almoço', items: [{ description: 'ção' }] });
  assert.equal(small.bytes, Buffer.byteLength(small.json, 'utf8'));
  assert.ok(small.ok);
  const items = Array.from({ length: 20 }, () => ({ description: 'ã'.repeat(110) }));
  const big = C.serializePayload('food', { date: TODAY, meal: 'Almoço', items });
  assert.ok(big.json.length < 4096 && big.bytes > 4096, 'characters fit, bytes do not');
  assert.equal(big.ok, false);
});

test('submission ids: 32 lowercase hex, random, and in the payload', () => {
  const a = C.newSubmissionId();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, C.newSubmissionId());
  assert.equal(C.newSubmissionId((b) => b.fill(10)), '0a'.repeat(16));
  assert.ok(C.isSubmissionId(a) && !C.isSubmissionId(a.toUpperCase()) && !C.isSubmissionId(a.slice(1)) && !C.isSubmissionId(undefined));
  const p = C.serializePayload('food', { date: TODAY, meal: 'Almoço', items: [{ description: 'x' }] }, a);
  assert.deepEqual(Object.keys(JSON.parse(p.json)), ['v', 't', 'id', 'args']);
  assert.equal(JSON.parse(p.json).id, a);
});

test('drafts and the last-sent history keep the submission id', () => {
  const s = C.draftStore(fakeStorage(), 'Prévia');
  const id = C.newSubmissionId();
  s.saveFood({ id, date: TODAY, meal: 'Almoço', items: [{ kind: 'description', description: 'pastel' }] });
  s.saveWorkout({ id, date: TODAY, session: 'Push A', complete: true, cards: [] });
  assert.equal(s.loadFood(TODAY).id, id);
  assert.equal(s.loadWorkouts(TODAY)[0].id, id);
  s.recordSent({ t: 'food', label: 'Almoço', json: '{}', form: { id, date: TODAY, meal: 'Almoço', items: [] } }, 1);
  assert.equal(s.sent('food')[0].form.id, id);
});

test('draftUsable keeps drafts only for today or yesterday', () => {
  assert.ok(C.draftUsable({ v: 1, workout: { date: TODAY } }, TODAY));
  assert.ok(C.draftUsable({ v: 1, workout: { date: '2026-11-08' }, food: { date: TODAY } }, TODAY));
  assert.ok(!C.draftUsable({ v: 1, workout: { date: '2026-11-07' } }, TODAY));
  assert.ok(!C.draftUsable({ v: 2, workout: { date: TODAY } }, TODAY));
  assert.ok(!C.draftUsable(null, TODAY));
});

/* review fixes: internal spaces, formula-like text, per-form drafts ----------------------------- */

test('parseDecimal trims only the ends and refuses spaces inside the number', () => {
  assert.equal(C.parseDecimal(' 82,5\n'), 82.5, 'pasted with a trailing newline');
  assert.equal(C.parseDecimal('\t80\t'), 80, 'tabs at the ends');
  assert.equal(C.parseDecimal('\r\n7,5 \r\n'), 7.5, 'pasted CRLF');
  for (const bad of ['1 5', '8 0', '8\t0', '82, 5', '8 0', '1\n5', '1 000']) {
    assert.ok(Number.isNaN(C.parseDecimal(bad)), JSON.stringify(bad));
  }
});

test('a space inside a number gets a clear message and blocks the payload', () => {
  const r = C.buildWorkout({ date: TODAY, session: 'Push A', cards: [card('Supino reto', [{ kg: '8 0', reps: '1\t0', rir: '' }])] }, CAT, { today: TODAY });
  assert.equal(r.args, null);
  const msgs = r.errors.map((e) => e.message).join('\n');
  assert.match(msgs, /kg: tire o espaço de dentro do número \("8 0"\)/);
  assert.match(msgs, /reps: tire o espaço de dentro do número \("1 0"\)/);
  const f = C.buildFood({ date: TODAY, meal: 'Almoço', items: [{ kind: 'food', food: 'Arroz branco cozido', qty: '1 50', unit: 'g' }] }, CAT, { today: TODAY });
  assert.ok(f.errors.some((e) => /quantidade: tire o espaço/.test(e.message)));
});

test('formulaProblem: free text must not start with = + - or @ (after trimming)', () => {
  for (const bad of ['=SOMA(A1)', '+55 11', '-ok', '@ombro', '  =1+1', '\t@x']) assert.ok(C.formulaProblem(bad), JSON.stringify(bad));
  for (const ok of ['ombro ok', 'ombro = ok', 'carga +2,5 na próxima', 'e-mail', '', null]) assert.equal(C.formulaProblem(ok), '', JSON.stringify(ok));
});

test('note, description and meal starting with = + - @ are refused', () => {
  const w = C.buildWorkout({ date: TODAY, session: 'Push A', cards: [card('Supino reto', [{ kg: '80', reps: '8' }], { note: ' =HYPERLINK("x")' })] }, CAT, { today: TODAY });
  assert.ok(w.errors.some((e) => /nota: não pode começar com = \+ - ou @/.test(e.message)));
  const f = C.buildFood({ date: TODAY, meal: '@Almoço', items: [{ kind: 'description', description: '-pastel' }] }, CAT, { today: TODAY });
  const msgs = f.errors.map((e) => e.message).join('\n');
  assert.match(msgs, /Refeição: não pode começar/);
  assert.match(msgs, /Item 1: descrição: não pode começar/);
  const ok = C.buildFood({ date: TODAY, meal: 'Almoço', items: [{ kind: 'description', description: 'pastel - feira' }] }, CAT, { today: TODAY });
  assert.deepEqual(ok.errors, []);
});

function fakeStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}
const filled = (name) => [Object.assign(C.newCard(name, ''), { sets: [{ kg: '80', reps: '8', rir: '' }] })];

test('drafts are per form: one workout per date+session, and the meal on its own', () => {
  const s = C.draftStore(fakeStorage(), 'Prévia');
  s.saveWorkout({ date: TODAY, session: 'Push A', complete: false, cards: filled('Supino reto') });
  s.saveWorkout({ date: '2026-11-08', session: 'Pull A', complete: false, cards: filled('Remada') });
  s.saveWorkout({ date: TODAY, session: 'Legs A', complete: false, cards: [C.newCard('Agachamento', '')] }); // empty: not stored
  s.saveFood({ date: TODAY, meal: 'Almoço', items: [{ kind: 'favorite', favorite: 'X', portions: '1' }] });
  const ws = s.loadWorkouts(TODAY);
  assert.deepEqual(ws.map((d) => d.date + ' ' + d.session).sort(), ['2026-11-08 Pull A', '2026-11-09 Push A']);
  assert.equal(s.loadFood(TODAY).meal, 'Almoço');
});

test('sending one form clears only that form and keeps it in the last-sent history', () => {
  const s = C.draftStore(fakeStorage(), 'Prévia');
  s.saveWorkout({ date: TODAY, session: 'Push A', complete: true, cards: filled('Supino reto') });
  s.saveWorkout({ date: TODAY, session: 'Pull A', complete: false, cards: filled('Remada') });
  s.saveFood({ date: TODAY, meal: 'Almoço', items: [{ kind: 'description', description: 'pastel' }] });
  // what app.js does on sendData for the Push A workout
  s.recordSent({ t: 'workout', label: 'Push A', json: '{"v":1}', form: { date: TODAY, session: 'Push A', complete: true, cards: filled('Supino reto') } }, 1000);
  s.clearWorkout(TODAY, 'Push A');
  assert.deepEqual(s.loadWorkouts(TODAY).map((d) => d.session), ['Pull A'], 'the other workout survives');
  assert.equal(s.loadFood(TODAY).meal, 'Almoço', 'the meal survives');
  const sent = s.sent('workout');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].at, 1000);
  assert.equal(sent[0].form.session, 'Push A');
  assert.equal(sent[0].form.cards[0].sets[0].kg, '80', 'restorable as it was');
  assert.deepEqual(s.sent('food'), []);
  // sending the meal clears only the meal
  s.recordSent({ t: 'food', label: 'Almoço', json: '{}', form: { date: TODAY, meal: 'Almoço', items: [] } }, 2000);
  s.clearFood();
  assert.equal(s.loadFood(TODAY), null);
  assert.deepEqual(s.loadWorkouts(TODAY).map((d) => d.session), ['Pull A']);
  assert.deepEqual(s.sent().map((e) => e.t), ['food', 'workout'], 'newest first');
});

test('last-sent history keeps the 5 newest', () => {
  const s = C.draftStore(fakeStorage(), 'Prévia');
  for (let i = 1; i <= 7; i++) s.recordSent({ t: 'food', label: 'm' + i, json: '{}', form: {} }, i);
  assert.deepEqual(s.sent('food').map((e) => e.label), ['m7', 'm6', 'm5', 'm4', 'm3']);
  assert.deepEqual(C.pushSent(null, { a: 1 }), [{ a: 1 }]);
});

test('stale drafts are dropped; other clients are not touched; broken storage never throws', () => {
  const st = fakeStorage();
  const a = C.draftStore(st, 'A');
  const b = C.draftStore(st, 'B');
  a.saveWorkout({ date: '2026-11-07', session: 'Push A', complete: false, cards: filled('Supino reto') });
  a.saveFood({ date: '2026-11-07', meal: 'Jantar', items: [{ kind: 'description', description: 'x' }] });
  b.saveWorkout({ date: TODAY, session: 'Push A', complete: false, cards: filled('Supino reto') });
  assert.deepEqual(a.loadWorkouts(TODAY), []);
  assert.equal(a.loadFood(TODAY), null);
  assert.equal(b.loadWorkouts(TODAY).length, 1);
  assert.equal([...st._map.keys()].filter((k) => k.includes(':A')).length, 0, 'stale keys removed');
  st.setItem(b.foodKey, '{not json');
  assert.equal(b.loadFood(TODAY), null);
  const deny = () => { throw new Error('denied'); };
  const throwing = { get length() { return deny(); }, key: deny, getItem: deny, setItem: deny, removeItem: deny };
  for (const storage of [null, throwing]) {
    const s = C.draftStore(storage, 'X');
    s.saveWorkout({ date: TODAY, session: 'Push A', complete: true, cards: [] });
    s.saveFood({ date: TODAY, meal: 'Almoço', items: [] });
    assert.deepEqual(s.loadWorkouts(TODAY), []);
    assert.equal(s.loadFood(TODAY), null);
    assert.equal(s.recordSent({ t: 'food', label: 'x', json: '{}', form: {} }).length, 1);
    assert.deepEqual(s.sent('food'), []);
  }
});

test('drafts keep each form\'s own edit time, so the app reopens on the last edited one', () => {
  const s = C.draftStore(fakeStorage(), 'Prévia');
  s.saveWorkout({ date: TODAY, session: 'Push A', complete: false, cards: filled('Supino reto'), savedAt: 2000 });
  s.saveWorkout({ date: TODAY, session: 'Pull A', complete: false, cards: filled('Remada'), savedAt: 1000 });
  const latest = s.loadWorkouts(TODAY).sort((a, b) => b.savedAt - a.savedAt)[0];
  assert.equal(latest.session, 'Push A');
});

test('parseRestSeconds extracts valid intervals and ignores non-rest tokens and out-of-range durations', () => {
  assert.equal(C.parseRestSeconds('2×6–10 · RIR 0–1 · 150 s · alt.: Supino'), 150);
  assert.equal(C.parseRestSeconds('90s'), 90);
  assert.equal(C.parseRestSeconds('60 seg'), 60);
  assert.equal(C.parseRestSeconds('60 seg.'), 60);
  assert.equal(C.parseRestSeconds('2 min'), 120);
  assert.equal(C.parseRestSeconds('1,5 min'), 90);
  assert.equal(C.parseRestSeconds('2–3 min'), 120);
  assert.equal(C.parseRestSeconds('2 a 3 min'), 120);
  assert.equal(C.parseRestSeconds('5 séries'), null);
  assert.equal(C.parseRestSeconds('5 séries · 90 s'), 90);
  assert.equal(C.parseRestSeconds('2×6–8 RIR 1'), null);
  assert.equal(C.parseRestSeconds('3 s'), null);
  assert.equal(C.parseRestSeconds('900 s'), null);
  assert.equal(C.parseRestSeconds(''), null);
  assert.equal(C.parseRestSeconds(null), null);
});

test('restPresetsFor, formatRestClock, formatRestChip and restProgress behave deterministically', () => {
  assert.deepEqual(C.restPresetsFor('2×6–8 RIR 1'), {
    prescribed: null,
    suggested: 90,
    presets: [60, 90, 120],
  });
  assert.deepEqual(C.restPresetsFor('2×6–10 · RIR 0–1 · 150 s · alt.: X'), {
    prescribed: 150,
    suggested: 150,
    presets: [60, 90, 120, 150],
  });
  assert.deepEqual(C.restPresetsFor('3×12 · 45 s'), {
    prescribed: 45,
    suggested: 45,
    presets: [45, 60, 90, 120],
  });
  assert.deepEqual(C.restPresetsFor('3×10 · 90 s'), {
    prescribed: 90,
    suggested: 90,
    presets: [60, 90, 120],
  });

  assert.equal(C.formatRestClock(150), '2:30');
  assert.equal(C.formatRestClock(90), '1:30');
  assert.equal(C.formatRestClock(9), '0:09');
  assert.equal(C.formatRestClock(0), '0:00');
  assert.equal(C.formatRestClock(-5), '0:00');

  assert.equal(C.formatRestChip(90), '90s');
  assert.equal(C.formatRestChip(150.4), '150s');

  assert.equal(C.restProgress(90000, 90000), 1);
  assert.equal(C.restProgress(45000, 90000), 0.5);
  assert.equal(C.restProgress(-100, 90000), 0);
  assert.equal(C.restProgress(120000, 90000), 1);
  assert.equal(C.restProgress(1000, 0), 0);
  assert.equal(C.restProgress(NaN, 90000), 0);
});

test('normalizeCatalog parses goal and day intake and rejects malformed or invalid numbers', () => {
  const cat = C.normalizeCatalog({
    v: 1,
    goal: { k: 2400, p: 160, c: 260, g: 70, w: 3 },
    day: { k: 920.5, p: 72, c: 0, g: 26, w: 1.25 },
  });
  assert.deepEqual(cat.goal, { kcal: 2400, protein: 160, carbs: 260, fat: 70, water: 3 });
  assert.deepEqual(cat.day, { kcal: 920.5, protein: 72, carbs: 0, fat: 26, water: 1.25 });

  const bad = C.normalizeCatalog({
    v: 1,
    goal: { k: 0, p: -10, c: Infinity, g: '20' },
    day: { k: -5, p: NaN },
  });
  assert.equal(bad.goal, null);
  assert.equal(bad.day, null);
  assert.equal(C.normalizeCatalog({ v: 1 }).goal, null);
  assert.equal(C.normalizeCatalog({ v: 1 }).day, null);
});

test('dailyBalance, formatLiters, formatWaterDelta and buildWater compute targets and validate limits', () => {
  const ownName = 'Ovo cozido fit';
  const cat = C.normalizeCatalog({
    v: 1,
    foods: [ownName],
    fv: [[0, 0, 100, 150, 13, 1, 10, null, null]],
    fu: ['g'],
    goal: { k: 2000, p: 150, c: 200, g: 60 },
    day: { k: 1200, p: 90, c: 120, g: 35, w: 1.5 },
  });
  const plateItems = [{ kind: 'food', food: ownName, qty: '200', unit: 'g' }]; // +300 kcal, +26P, +2C, +20G

  const todayBal = C.dailyBalance(cat, plateItems, { isToday: true, waterAddL: 0.5 });
  assert.equal(todayBal.isToday, true);
  assert.equal(todayBal.hasLoggedFood, true);
  assert.deepEqual(todayBal.total, { kcal: 1500, protein: 116, carbs: 122, fat: 55, water: 2 });
  assert.equal(todayBal.targets.water, 2.5);
  assert.equal(todayBal.ratio.kcal, 0.75);
  assert.equal(todayBal.over.kcal, false);
  assert.equal(todayBal.over.water, false);

  const yestBal = C.dailyBalance(cat, plateItems, { isToday: false, waterAddL: 0.75 });
  assert.equal(yestBal.isToday, false);
  assert.equal(yestBal.hasLoggedFood, false);
  assert.deepEqual(yestBal.total, { kcal: 300, protein: 26, carbs: 2, fat: 20, water: 0.75 });

  // Water cap at 20 L
  const capped = C.dailyBalance(cat, [], { isToday: true, waterAddL: 25 });
  assert.equal(capped.total.water, 20);
  assert.equal(capped.over.water, true);

  assert.equal(C.formatLiters(0), '0 L');
  assert.equal(C.formatLiters(1.25), '1,25 L');
  assert.equal(C.formatWaterDelta(0.25), '+250 ml');
  assert.equal(C.formatWaterDelta(1.5), '+1,5 L');

  const okW = C.buildWater({ date: TODAY, baseWaterL: 1.5, addWaterL: 0.5 }, { today: TODAY });
  assert.deepEqual(okW, { args: { date: TODAY, waterDeltaL: 0.5 }, errors: [] });
  assert.deepEqual(C.buildWater({ date: '2026-11-08', baseWaterL: null, addWaterL: 0.25 }, { today: TODAY }), {
    args: { date: '2026-11-08', waterDeltaL: 0.25 },
    errors: [],
  });

  assert.ok(C.buildWater({ date: TODAY, baseWaterL: 1.5, addWaterL: 0 }, { today: TODAY }).errors.length);
  assert.ok(C.buildWater({ date: TODAY, baseWaterL: 19.75, addWaterL: 0.5 }, { today: TODAY }).errors.length);
  assert.ok(C.buildWater({ date: TODAY, baseWaterL: null, addWaterL: 20.5 }, { today: TODAY }).errors.length);
  assert.ok(C.buildWater({ date: '2026-11-10', baseWaterL: 0, addWaterL: 0.5 }, { today: TODAY }).errors.length);
  assert.equal(C.pulsoSummary({ view: 'water', waterTotal: 1.75 }), 'Água pronta para conferir: 1,75 L.');
  assert.equal(C.pulsoSummary({ view: 'water', waterDeltaL: 0.5, waterTotal: 2.5 }), 'Água pronta para conferir: +0,5 L (total estimado: 2,5 L).');
  assert.equal(C.pulsoSummary({ view: 'water', waterDeltaL: 0.5, waterTotal: null }), 'Água pronta para conferir: +0,5 L para somar na planilha.');
  assert.doesNotMatch(C.pulsoSummary({ view: 'water', waterDeltaL: 0.5, waterTotal: 2.5 }), /gravado|salvo/i);
  assert.doesNotMatch(C.pulsoSummary({ view: 'water', waterDeltaL: 0.5, waterTotal: null }), /gravado|salvo/i);
});

test('defaultSwapCriterion, computeSwap and swapSuggestions match Equivalences.swap', () => {
  assert.equal(C.defaultSwapCriterion({ kcal: 192, protein: 3.8, carbs: 42.1, fat: 0.3 }), 'carbs');
  assert.equal(C.defaultSwapCriterion({ kcal: 163, protein: 31.5, carbs: 0, fat: 3.2 }), 'protein');
  assert.equal(C.defaultSwapCriterion({ kcal: 200, protein: 5, carbs: 5, fat: 18 }), 'fat');
  assert.equal(C.defaultSwapCriterion({ kcal: 146, protein: 13.3, carbs: 0.6, fat: 9.5 }), 'fat');
  assert.equal(C.defaultSwapCriterion({ kcal: 200, protein: 20, carbs: 20, fat: 5 }), 'kcal');
  assert.equal(C.defaultSwapCriterion(null), 'kcal');

  const { FOODS, bootFood } = require('../../sheet4/test/food_helpers');
  const { Equivalences } = bootFood();

  // Catalog matching FOODS (rice, chicken, bread, egg, oats, milk)
  const names = FOODS.slice(0, 7).map((f) => f.name);
  const units = ['g', 'ml', 'un', 'fatia'];
  const idx = (u) => (u ? units.indexOf(u) : null);
  const fv = FOODS.slice(0, 7).map((f, i) => [
    i,
    idx(f.baseUnit),
    f.baseQty,
    f.kcal,
    f.protein,
    f.carbs,
    f.fat,
    idx(f.householdUnit || null),
    f.perHousehold || null,
  ]);
  const cat = C.normalizeCatalog({ v: 1, foods: names, fv, fu: units });

  // Mass item: Arroz branco cozido 150 g -> Pão integral (by carbs), check parity with sheet Equivalences.swap
  const riceItem = { kind: 'food', food: 'Arroz branco cozido', qty: '150', unit: 'g' };
  const swapBread = C.computeSwap(riceItem, 'Pão integral', 'carbs', cat);
  const sheetBread = Equivalences.swap('Arroz branco cozido', 150, 'Carboidrato', 'Pão integral');
  assert.equal(swapBread.ok, true);
  assert.equal(swapBread.target.qty, sheetBread.equivQty);
  assert.equal(swapBread.target.unit, sheetBread.unit);
  assert.deepEqual(
    swapBread.target.nutrition,
    C.foodNutrition({ kind: 'food', food: 'Pão integral', qty: swapBread.target.qtyText, unit: 'g' }, cat),
  );
  assert.ok(Math.abs(swapBread.target.nutrition.kcal - sheetBread.kcalAlt) < 0.2);

  // Household unit: Ovo inteiro cozido 2 un (= 100 g) -> Peito de frango cozido (by protein)
  const eggItem = { kind: 'food', food: 'Ovo inteiro cozido', qty: '2', unit: 'un' };
  const swapChicken = C.computeSwap(eggItem, 'Peito de frango cozido', 'protein', cat);
  const sheetChicken = Equivalences.swap('Ovo inteiro cozido', 100, 'Proteína', 'Peito de frango cozido');
  assert.equal(swapChicken.ok, true);
  assert.equal(swapChicken.target.qty, sheetChicken.equivQty);
  assert.equal(swapChicken.target.unit, 'g');

  // All 4 criteria work when target supplies that nutrient (Aveia em flocos supplies all 4)
  for (const crit of C.SWAP_CRITERIA) {
    const res = C.computeSwap(riceItem, 'Aveia em flocos', crit, cat);
    assert.equal(res.ok, true, `criterion ${crit} should succeed`);
    assert.ok(res.target.qty > 0);
  }

  // Zero-nutrient refusal, same-food refusal, out-of-range refusal, and non-catalog refusal
  const zeroCarb = C.computeSwap(riceItem, 'Peito de frango cozido', 'carbs', cat);
  assert.equal(zeroCarb.ok, false);
  assert.match(zeroCarb.error, /carbo/i);
  assert.equal(C.computeSwap(riceItem, 'Arroz branco cozido', 'kcal', cat).ok, false);
  assert.equal(C.computeSwap({ kind: 'food', food: 'Arroz branco cozido', qty: '100000', unit: 'g' }, 'Leite desnatado', 'kcal', cat).ok, false);
  assert.equal(C.computeSwap({ kind: 'description', description: 'pastel' }, 'Pão integral', 'kcal', cat).ok, false);

  // Smart suggestions exclude current food and zero-nutrient substitutes, sorted by closeness
  const suggestions = C.swapSuggestions(riceItem, 'carbs', cat, 4);
  assert.ok(suggestions.length >= 2 && suggestions.length <= 4);
  assert.equal(suggestions.some((s) => s.target.food === 'Arroz branco cozido'), false);
  assert.equal(suggestions.some((s) => s.target.food === 'Peito de frango cozido'), false);
});

test('parsePrefillFood and normalizeCatalog unpack compact df food drafts safely', () => {
  assert.equal(C.parsePrefillFood(null), null);
  assert.equal(C.parsePrefillFood({ d: '2026-11-20', m: 'Almoço', i: [] }), null);
  assert.equal(C.parsePrefillFood({ d: '2026-11-20', m: 'Almoço', i: [{ f: 'Arroz', q: 0 }] }), null);

  const parsed = C.parsePrefillFood({
    d: '2026-11-20',
    m: 'Almoço',
    i: [
      { f: 'Arroz branco cozido', q: 150.5, u: 'g', ms: 'Estimada' },
      { f: 'Feijão carioca cozido', q: 80, u: 'g', ms: 'Inventada' },
      { fav: 'Café da manhã básico', p: 1.5 },
      { fav: 'Lanche', p: 'invalid' },
      { ds: 'bife grelhado', q: 120, u: 'g' },
      { ds: 'salada verde' },
      { f: 'Ignorado', q: -5 },
    ],
  });
  assert.deepEqual(parsed, {
    date: '2026-11-20',
    meal: 'Almoço',
    items: [
      { kind: 'food', food: 'Arroz branco cozido', qty: '150,5', unit: 'g', measure: 'Estimada' },
      { kind: 'food', food: 'Feijão carioca cozido', qty: '80', unit: 'g', measure: '' },
      { kind: 'favorite', favorite: 'Café da manhã básico', portions: '1,5' },
      { kind: 'favorite', favorite: 'Lanche', portions: '1' },
      { kind: 'description', description: 'bife grelhado', qty: '120', unit: 'g' },
      { kind: 'description', description: 'salada verde', qty: '', unit: '' },
    ],
  });

  const invalidDateParsed = C.parsePrefillFood({
    d: '2026-99-01',
    m: 'X'.repeat(100),
    i: [{ ds: 'suco natural' }],
  });
  assert.equal(invalidDateParsed.date, '');
  assert.equal(invalidDateParsed.meal.length, C.LIMITS.MEAL_MAX);

  const cat = C.normalizeCatalog({
    v: 1,
    foods: ['Pão integral'],
    df: { d: '2026-11-20', m: 'Café', i: [{ f: 'Pão integral', q: 50, u: 'g', ms: 'Estimada' }] },
  });
  assert.deepEqual(cat.prefillFood, {
    date: '2026-11-20',
    meal: 'Café',
    items: [{ kind: 'food', food: 'Pão integral', qty: '50', unit: 'g', measure: 'Estimada' }],
  });
  assert.equal(C.normalizeCatalog({ v: 1 }).prefillFood, null);
});
