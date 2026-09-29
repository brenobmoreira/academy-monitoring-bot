'use strict';
/**
 * Migration 3.0 → 4.0 on the real exports (fixtures breno_3_0 / zoio_3_0) with the owner's client
 * files (clients/*.json): every §1 finding resolved, no row lost, idempotent, undoable.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, plain } = require('./harness');
const { snapshot } = require('./fakes');

const NOW = '2026-09-29T15:00:00-03:00';
const CLIENTS = path.join(__dirname, '..', '..', '..', 'clients');
const client = (name) => JSON.parse(fs.readFileSync(path.join(CLIENTS, `${name}.json`), 'utf8'));
const boot = (name) => load({ fixture: `${name}_3_0`, now: NOW });
const OTHER = { breno: 'Zoio', zoio: 'Breno' };

/** Snapshot without the Log tab and without cached formula values (lost when a formula is rewritten). */
function comparable(ctx) {
  const snap = snapshot(ctx);
  snap.sheets = snap.sheets.filter((s) => s.name !== 'Log');
  snap.sheets.forEach((s) => { s.values = s.values.map((r) => r.map((v) => (v && v.$formula ? { $formula: v.$formula } : v))); });
  return JSON.stringify(snap);
}

/** Data rows with typed content (formulas ignored) per sheet, from row 6. */
function contentRows(ctx) {
  const out = {};
  snapshot(ctx).sheets.forEach((s) => {
    out[s.name] = s.values.slice(5).filter((r) => r.some((v) => v !== null && !(v && v.$formula))).length;
  });
  return out;
}

function allCells(ctx, pred) {
  const hits = [];
  snapshot(ctx).sheets.forEach((s) => s.values.forEach((r, i) => r.forEach((v, j) => { if (pred(v, s.name)) hits.push(`${s.name}!${i + 1}:${j + 1}`); })));
  return hits;
}

const codes = (findings) => findings.map((f) => f.code);

['breno', 'zoio'].forEach((name) => {
  test(`${name}: the audit of the 3.0 export lists the known problems`, () => {
    const ctx = boot(name);
    const f = plain(ctx.Audit.findings({ otherNames: [OTHER[name]] }));
    const has = (code, tab, cell) => f.some((x) => x.code === code && (!tab || x.tab === tab) && (!cell || x.cell === cell));
    assert.ok(has('technical_date', 'Histórico de metas', 'A6'), 'M001 1900');
    assert.ok(has('technical_date', 'Histórico de fichas', 'B6'), 'F001 1900');
    assert.ok(has('fixed_range', 'Diário') && has('fixed_range', 'Semanas'));
    assert.ok(has('validation_named_range', 'Hoje', 'A27:A38') && has('validation_named_range', 'Registro de treino', 'C6'));
    assert.ok(has('stale_text', 'Hoje', 'E5') && has('stale_text', 'Macros e perfil', 'B29'));
    assert.ok(has('stale_plan_status', 'Macros e perfil', 'B27'));
    assert.ok(has('tab_missing', 'Objetivos') && has('tab_missing', 'Evolução'));
    ['Histórico de metas', 'Histórico de fichas', 'Macros e perfil', 'Guia e fontes'].forEach((t) => assert.ok(has('tab_legacy_name', t), t));
    assert.ok(has('columns_missing', 'Diário') && has('columns_missing', 'Revisões'));
    assert.ok(has('text_date', 'Revisões', 'A10'));
    if (name === 'breno') ['C17', 'B21', 'C21'].forEach((c) => assert.ok(has('cross_client', 'Guia e fontes', c), c));
    else assert.ok(has('cross_client', 'Revisões', 'D7') && has('cross_client', 'Guia e fontes', 'B21'));
    assert.equal(f.filter((x) => x.code === 'cross_client').length, name === 'breno' ? 3 : 2);
  });

  test(`${name}: migration resolves every §1 finding`, () => {
    const ctx = boot(name);
    const cfg = client(name);
    const r = plain(ctx.Migrate.run(cfg));
    assert.equal(r.ok, true);
    assert.equal(r.alreadyMigrated, false);
    assert.deepEqual(r.findingsAfter, [], 'the audit after migration is clean');
    assert.deepEqual(r.postSteps.map((s) => s.step), ['Recalcular semanas', 'Aplicar layout']);
    assert.equal(r.postSteps[0].status, typeof ctx.Weeks !== 'undefined' ? 'ok' : 'ausente');
    assert.equal(r.postSteps[1].status, typeof ctx.Setup !== 'undefined' && ctx.Setup.apply ? 'ok' : 'ausente');

    // Tabs renamed in place, new ones created.
    const names = ctx.__spreadsheet.getSheets().map((s) => s.getName());
    ['Config', 'Metas', 'Fichas', 'Guia', 'Objetivos', 'Evolução', 'Auditoria', 'Log'].forEach((t) => assert.ok(names.includes(t), t));
    ['Macros e perfil', 'Histórico de metas', 'Histórico de fichas', 'Guia e fontes'].forEach((t) => assert.ok(!names.includes(t), t));

    // No technical date left anywhere (Log/Auditoria quote them as text).
    const technical = allCells(ctx, (v) => v && (v.$date || v.$datetime) && String(v.$date || v.$datetime) < '2000');
    assert.deepEqual(technical, []);

    // Versions valid, dates and statuses derived.
    assert.deepEqual(plain(ctx.Objectives.validate()), []);
    assert.deepEqual(plain(ctx.Goals.validate()), []);
    assert.deepEqual(plain(ctx.Plans.validate()), []);
    const key = (d) => ctx.Dates.key(d);
    const f001 = ctx.Plans.get('F001');
    assert.equal(key(f001.start), '2026-09-15');
    assert.equal(key(f001.end), '2026-09-27');
    assert.ok(f001.rows.every((row) => row.status === 'Encerrada' && key(row.legacyStart) === '2026-09-15'), 'F001 rows read as closed');
    assert.equal(ctx.Plans.current().id, 'F002');
    assert.equal(key(ctx.Plans.current().start), '2026-09-28');
    assert.ok(ctx.Plans.current().rows.every((row) => row.status === 'Vigente'));
    assert.equal(ctx.Plans.on('2026-09-20').id, 'F001');

    const o = ctx.Objectives.current();
    assert.equal(o.id, 'O001');
    assert.equal(o.fields.name, 'Recomposição corporal');
    assert.equal(o.fields.analysisType, 'recomposicao');
    assert.equal(key(o.start), '2026-09-28');
    assert.equal(o.fields.status, 'Vigente');
    assert.equal(o.fields.goal, 'M001');
    assert.equal(o.fields.plan, 'F002');
    assert.equal(o.fields.reviewer, 'Luan');

    const m = ctx.Goals.current().fields;
    assert.equal(m.id, 'M001');
    assert.equal(key(m.start), '2026-09-28');
    assert.equal(m.status, 'Vigente');
    assert.equal(m.objective, 'O001');
    const expected = name === 'breno'
      ? { kcal: 2400, protein: 140, proteinMin: 135, proteinMax: 145, fat: 65, carbs: 313.75, strengthPerWeek: 3, cardioPerWeek: 0, activitiesPerWeek: 2, bmr: 1673.75, startWeightKg: 67 }
      : { kcal: 2650, protein: 170, proteinMin: 160, proteinMax: 180, fat: 70, carbs: 335, strengthPerWeek: 5, cardioPerWeek: 2, activitiesPerWeek: 0, bmr: 1886.25, startWeightKg: 85 };
    ['kcal', 'protein', 'proteinMin', 'proteinMax', 'fat', 'carbs', 'strengthPerWeek', 'cardioPerWeek', 'activitiesPerWeek', 'bmr'].forEach((k) => assert.equal(m[k], expected[k], `M001.${k}`));
    assert.equal(m.kcalTolerance, 0.05);
    assert.equal(m.fatTolerance, 0.15);
    assert.equal(m.bmrMethod, 'Mifflin-St Jeor');
    assert.equal(m.activityFactor, 1.55);
    assert.equal(m.tdee, Math.round(expected.bmr * 1.55 * 100) / 100);
    assert.equal(o.fields.kcal, expected.kcal);
    assert.equal(o.fields.carbs, expected.carbs);
    assert.equal(o.fields.startWeightKg, expected.startWeightKg);

    // Config from the client file (height in cm), 3.0 profile rows gone from the tab.
    const C = ctx.Config;
    assert.equal(C.get('client.name'), name === 'breno' ? 'Breno' : 'Zoio');
    assert.equal(C.get('client.sex'), 'M');
    assert.equal(C.get('client.heightCm'), name === 'breno' ? 179 : 185);
    assert.equal(C.get('client.age'), name === 'breno' ? 24 : 25);
    assert.equal(key(C.get('client.startDate')), name === 'breno' ? '2026-09-21' : '2026-09-28');
    assert.equal(C.get('routine.rotationMode'), 'continuous');
    assert.deepEqual(plain(C.getList('system.otherClientNames')), [OTHER[name]]);
    assert.equal(C.get('system.schemaVersion'), '4.0');
    assert.equal(ctx.Energy.fromConfig({ date: '2026-09-28' }).bmr, expected.bmr);
    if (name === 'zoio') assert.match(C.get('client.notes'), /Creatina: 5 g\/dia/);
    const configText = JSON.stringify(snapshot(ctx).sheets.find((s) => s.name === 'Config').values);
    assert.ok(!configText.includes('Status da ficha') && !configText.includes('Revisar novamente'), 'typed plan status removed');

    // No residue of the other client outside Auditoria/Log.
    const other = OTHER[name];
    const residues = allCells(ctx, (v, tab) => tab !== 'Auditoria' && tab !== 'Log' && tab !== 'Config' && typeof v === 'string' && v.includes(other));
    assert.deepEqual(residues, []);
    const guide = ctx.__spreadsheet.getSheetByName('Guia').getRange('B21').getValue();
    assert.ok(guide.startsWith(name === 'breno' ? 'Breno:' : 'Zoio:'), guide);

    // Stale 3.0 texts replaced, Painel formulas gone, named range restored.
    assert.equal(ctx.__spreadsheet.getSheetByName('Hoje').getRange('E5').getValue(), ctx.Migrate.STATUS_TEXT);
    assert.deepEqual(ctx.__spreadsheet.getSheetByName('Painel').getDataRange().getFormulas().flat().filter(Boolean), []);
    assert.equal(ctx.__spreadsheet.getSheetByName('Painel').getRange('B32').getValue(), 'kcal ±5%; gordura ±15%; proteína pela faixa individual.', 'typed text kept');
    assert.ok(ctx.__spreadsheet.getRangeByName('ListaExercicios'));
    assert.deepEqual(ctx.__spreadsheet.getSheetByName('Diário').getDataRange().getFormulas().flat().filter(Boolean), []);

    // Headers by key: every spec column present on every table tab.
    ctx.Tabs.invalidate();
    ctx.Tabs.ids().filter((id) => ctx.Tabs.get(id).kind === 'table').forEach((id) => assert.deepEqual(plain(ctx.Tabs.missingColumns(id)), [], id));

    // Review rows stamped by date; text date fixed.
    const reviews = ctx.Tabs.read('reviews');
    assert.equal(reviews[0].plan, 'F001');
    assert.equal(reviews[0].objective, null);
    assert.deepEqual([reviews[4].objective, reviews[4].goal, reviews[4].plan], ['O001', 'M001', 'F002']);
    assert.ok(ctx.__spreadsheet.getSheetByName('Revisões').getRange('A10').getValue() instanceof Date);
  });

  test(`${name}: no data row is lost; archived 3.0 content is quoted in Auditoria`, () => {
    const ctx = boot(name);
    const before = contentRows(ctx);
    const legacyRows = ctx.Migrate.legacyProfile().rows.length;
    ctx.Migrate.run(client(name));
    const after = contentRows(ctx);
    const renamed = { 'Histórico de metas': 'Metas', 'Histórico de fichas': 'Fichas', 'Guia e fontes': 'Guia' };
    Object.keys(before).forEach((tab) => {
      if (tab === 'Macros e perfil' || tab === 'Progressão' || tab === 'Painel' || tab === 'Hoje') return; // layout / rebuilt, checked below
      const now = after[renamed[tab] || tab];
      assert.ok(now >= before[tab], `${tab}: ${before[tab]} → ${now}`);
    });
    const audit = ctx.Tabs.read('audit');
    assert.equal(audit.filter((r) => r.code === 'profile_archived').length, legacyRows, 'every 3.0 profile row quoted');
    assert.equal(audit.filter((r) => r.code === 'layout_archived' && r.tab === 'Progressão').length, 3);
    assert.ok(audit.some((r) => r.code === 'profile_archived' && /Status da ficha/.test(r.before)));
    const cross = audit.filter((r) => r.code === 'cross_client');
    assert.equal(cross.length, name === 'breno' ? 3 : 2);
    cross.forEach((r) => assert.ok(r.before.includes(OTHER[name]), 'the removed sentence is quoted'));
    const tech = audit.find((r) => r.code === 'version_technical_date' && r.tab === 'Metas');
    assert.match(tech.before, /01\/01\/1900/);
    assert.ok(audit.every((r) => r.state && r.severity && r.finding));
    assert.ok(audit.some((r) => r.state === 'Revisar' && /Fator de atividade/.test(r.finding)));
    if (name === 'zoio') assert.ok(audit.some((r) => r.state === 'Revisar' && /160–180/.test(r.finding)));
  });

  test(`${name}: second run is a no-op (identical snapshot, nothing logged)`, () => {
    const ctx = boot(name);
    ctx.Migrate.run(client(name));
    const once = JSON.stringify(snapshot(ctx));
    const r = ctx.Migrate.run(client(name));
    assert.equal(r.alreadyMigrated, true);
    assert.equal(JSON.stringify(snapshot(ctx)), once);
  });

  test(`${name}: undo of the migration restores the 3.0 spreadsheet`, () => {
    const ctx = boot(name);
    const original = comparable(ctx);
    ctx.Migrate.run(client(name));
    assert.notEqual(comparable(ctx), original);
    const u = plain(ctx.Undo.last());
    assert.equal(u.action, 'Migrar 3.0 → 4.0');
    assert.equal(comparable(ctx), original);
    assert.equal(ctx.Migrate.isMigrated(), false);
  });
});

test('a failing step rolls the whole migration back (renames and new tabs too)', () => {
  const ctx = boot('breno');
  const original = comparable(ctx);
  ctx.Days.restampAll = () => { throw new Error('falha simulada'); };
  assert.throws(() => ctx.Migrate.run(client('breno')), /falha simulada/);
  assert.equal(comparable(ctx), original);
});

test('post steps run inside the migration action: one undo returns to 3.0, a failing step is reported', () => {
  const ctx = boot('zoio');
  const original = comparable(ctx);
  const calls = [];
  const recompute = ctx.Weeks.recomputeAll;
  ctx.Weeks.recomputeAll = () => { calls.push('weeks'); return recompute(); };
  ctx.Setup = {
    apply: () => {
      calls.push('setup');
      ctx.Tabs.setCells('dashboard', { A1: 'parcial' }); // written before failing: part of the action
      throw new Error('layout quebrado');
    },
  };
  const r = plain(ctx.Migrate.run(client('zoio')));
  assert.deepEqual(calls, ['weeks', 'setup']);
  assert.deepEqual(r.postSteps.map((s) => s.status), ['ok', 'erro']);
  assert.match(r.postSteps[1].message, /layout quebrado/);
  assert.equal(ctx.Migrate.isMigrated(), true, 'the migration itself stays applied');
  const weeks = ctx.Tabs.read('weeks');
  assert.deepEqual(plain(weeks.map((w) => ctx.Dates.key(w.start))), ['2026-09-14', '2026-09-21', '2026-09-28'], 'weeks since F001, no data');
  assert.ok(weeks.every((w) => w.status === 'Dados insuficientes' && w.objective === (ctx.Dates.key(w.start) === '2026-09-28' ? 'O001' : null)));
  assert.ok(ctx.Tabs.read('audit').some((a) => a.code === 'post_step' && a.severity === 'Erro' && /layout quebrado/.test(a.finding)));
  assert.deepEqual(plain(ctx.ChangeLog.actions().map((a) => a.label)), ['Migrar 3.0 → 4.0'], 'a single undoable action');
  ctx.Undo.last();
  assert.equal(comparable(ctx), original);
});

test('initial setup of an empty spreadsheet creates every tab and the first versions', () => {
  const ctx = load({ sheets: [{ name: 'Página1', rows: [] }], now: NOW });
  const r = plain(ctx.Migrate.run(client('zoio')));
  ctx.Tabs.ids().forEach((id) => assert.ok(ctx.Tabs.findSheet(id), id));
  assert.equal(ctx.Objectives.current().id, 'O001');
  assert.equal(ctx.Goals.current().fields.kcal, 2650);
  assert.equal(ctx.Config.get('client.heightCm'), 185);
  assert.ok(r.report.some((x) => x.code === 'plan_missing_rows' && x.cell === 'F001'));
  assert.ok(r.findingsAfter.some((x) => x.code === 'version_none_current' && x.tab === 'Fichas'), 'no plan yet');
  assert.equal(ctx.Migrate.run(client('zoio')).alreadyMigrated, true);
});

test('without a client file the 3.0 profile and dates are used; missing starts are flagged', () => {
  const ctx = boot('breno');
  const r = plain(ctx.Migrate.run());
  assert.equal(ctx.Config.get('client.heightCm'), 179, 'metres → cm');
  assert.equal(ctx.Dates.key(ctx.Config.get('client.startDate')), '2026-09-21');
  assert.equal(ctx.Config.get('client.sex'), null, 'sex is never assumed');
  assert.equal(ctx.Dates.key(ctx.Plans.get('F002').start), '2026-09-28', 'F002 from its 3.0 Vigência');
  assert.equal(ctx.Dates.key(ctx.Plans.get('F001').start), '2026-09-21', 'first plan falls back to client.startDate');
  assert.ok(r.report.some((x) => x.code === 'version_start_guessed' && x.state === 'Revisar'));
  assert.ok(r.findingsAfter.some((x) => x.code === 'config_missing' && x.cell === 'client.sex'));
  assert.ok(r.findingsAfter.some((x) => x.code === 'version_none_current' && x.tab === 'Objetivos'));
});

test('parseClient rejects unknown keys, bad ids and carbs that do not match kcal/P/G', () => {
  const ctx = load({ now: NOW });
  const { errors } = ctx.Migrate.parseClient({
    config: { 'client.nome': 'x', 'client.sex': 'X' },
    history: { goals: [{ id: 'G1', start: '2026-09-28' }, { id: 'M002', start: '2026-13-01', kcal: 2000, protein: 100, fat: 50, carbs: 10 }] },
  });
  assert.equal(errors.length, 5, errors.join('\n'));
  assert.match(ctx.Migrate.parseClient('{nope').errors[0], /JSON inválido/);
  assert.deepEqual(plain(ctx.Migrate.parseClient(client('breno')).errors), []);
  assert.deepEqual(plain(ctx.Migrate.parseClient(client('zoio')).errors), []);
});

test('client files hold the client data; the code does not', () => {
  const src = path.join(__dirname, '..', 'src');
  fs.readdirSync(src).filter((f) => /\.(js|html)$/.test(f)).forEach((f) => {
    const text = fs.readFileSync(path.join(src, f), 'utf8');
    ['Breno', 'Zoio', 'Luan', 'Muay'].forEach((n) => assert.ok(!text.includes(n), `${f} mentions ${n}`));
  });
});
