/**
 * Client-configuration wizard (spec §9): "Configuração inicial" and "Migrar 3.0 → 4.0" open the same
 * dialog (wizard.html). It shows the values the migration will write, read from the 3.0 profile tab
 * and from a pasted client JSON (clients/<name>.json), lets the person confirm or edit sex, age,
 * height, routine and the initial targets, then runs Migrate.run.
 *
 * The logic is here and testable without the dialog:
 *   Wizard.proposal(json?) → JSON-safe proposal (dates as yyyy-MM-dd)
 *   Wizard.confirm(values) → Migrate.run result; values = {json?, config?: {key: value},
 *                            goal?: {kcal, protein, proteinMin, proteinMax, fat, start?},
 *                            objective?: {name, analysisType, start?}}
 */
const Wizard = {
  /** Config sections the dialog shows (Análise keeps its defaults; edit on Config later). */
  SECTIONS: ['Perfil', 'Rotina', 'Energia'],
  EXTRA_KEYS: ['system.otherClientNames'],
  GOAL_FIELDS: ['kcal', 'protein', 'proteinMin', 'proteinMax', 'fat'],
  OBJECTIVE_FIELDS: ['name', 'analysisType'],
  HEIGHT_CM: [100, 250],

  /**
   * What the migration would write.
   * @param {Object|string=} json client JSON
   * @returns {{errors: string[], migrated: boolean, hasLegacyProfile: boolean, fields: Object[],
   *   goal: Object, objective: Object, plans: Object[], energy: {bmr, tdee}, review: Object[],
   *   otherClientNames: string[]}}
   */
  proposal(json) {
    const parsed = Migrate.parseClient(json);
    const cc = parsed.client || Migrate.parseClient({}).client;
    const legacy = Migrate.legacyProfile();
    const cfg = Migrate.resolveConfig(cc, legacy);
    const keys = Config.keys().filter((k) => Wizard.SECTIONS.indexOf(Config.DEFAULTS[k].section) >= 0).concat(Wizard.EXTRA_KEYS);
    const fields = keys.map((k) => {
      const def = Config.DEFAULTS[k];
      return {
        key: k, section: def.section, label: def.label, unit: def.unit, type: def.type, options: def.options || null,
        value: Wizard.plain_(cfg[k].value), source: cfg[k].source, legacy: Wizard.plain_(cfg[k].legacy),
      };
    });

    const sheetGoal = Wizard.sheetVersion_('goals');
    const jsonGoal = cc.history.goals[0] || null;
    const goal = { id: jsonGoal ? jsonGoal.id : sheetGoal ? sheetGoal.id : 'M001', start: null, source: jsonGoal ? 'json' : sheetGoal ? 'planilha' : '3.0' };
    Wizard.GOAL_FIELDS.forEach((k) => {
      let v = null;
      if (jsonGoal && jsonGoal.fields[k] !== undefined) v = jsonGoal.fields[k];
      else if (sheetGoal && sheetGoal.fields[k] !== null && sheetGoal.fields[k] !== undefined) v = sheetGoal.fields[k];
      else if (legacy && legacy.goal[k] !== undefined) v = legacy.goal[k];
      goal[k] = v;
    });
    goal.start = Dates.key((jsonGoal && jsonGoal.start) || (sheetGoal && sheetGoal.start)) || null;
    goal.carbs = Energy.carbs(goal.kcal, goal.protein, goal.fat);

    const jsonObj = cc.history.objectives[0] || null;
    const objective = {
      id: jsonObj ? jsonObj.id : 'O001',
      name: (jsonObj && jsonObj.fields.name) || (legacy && legacy.objective.name) || null,
      analysisType: (jsonObj && jsonObj.fields.analysisType) || null,
      start: Dates.key(jsonObj && jsonObj.start) || goal.start,
      source: jsonObj ? 'json' : legacy && legacy.objective.name ? '3.0' : 'vazio',
    };
    const plans = cc.history.plans.length
      ? cc.history.plans.map((p) => ({ id: p.id, start: Dates.key(p.start) || null, end: p.end ? Dates.key(p.end) : null, source: 'json' }))
      : Wizard.sheetPlans_();

    const v = (k) => cfg[k].value;
    const bmr = Energy.bmr({ sex: v('client.sex'), weightKg: v('client.startWeightKg'), heightCm: v('client.heightCm'), age: v('client.age') });
    return {
      errors: parsed.errors, migrated: Migrate.isMigrated(), hasLegacyProfile: !!legacy, fields, goal, objective, plans,
      energy: { bmr, tdee: Energy.tdee(bmr, v('energy.activityFactor')) },
      review: cc.review, otherClientNames: cfg['system.otherClientNames'].value || [],
      analysisTypes: Tabs.ENUMS.ANALYSIS_TYPES.slice(),
    };
  },

  /**
   * Applies the person's edits to the client JSON and runs the migration.
   * @throws Error with every validation message (Portuguese) when a value is missing or wrong
   */
  confirm(values) {
    const vals = values || {};
    let raw = vals.json;
    if (typeof raw === 'string') {
      if (!raw.trim()) raw = {};
      else {
        try { raw = JSON.parse(raw); } catch (err) { throw new Error(`JSON inválido: ${err.message}`); }
      }
    }
    raw = JSON.parse(JSON.stringify(raw || {}));
    raw.config = raw.config || {};
    raw.history = raw.history || {};
    const cfg = vals.config || {};
    Object.keys(cfg).forEach((k) => {
      if (k === 'system.otherClientNames') {
        const list = Array.isArray(cfg[k]) ? cfg[k] : String(cfg[k] || '').split(',');
        raw.otherClientNames = list.map((s) => String(s).trim()).filter(Boolean);
        return;
      }
      raw.config[k] = cfg[k] === '' ? null : cfg[k];
    });

    // Fill from the proposal (3.0 profile) what the JSON and the edits leave empty.
    const base = Wizard.proposal(raw);
    if (base.errors.length) throw new Error(`Configuração do cliente inválida: ${base.errors.join(' ')}`);
    base.fields.forEach((f) => {
      if (f.key === 'system.otherClientNames') {
        if (!raw.otherClientNames && f.value && f.value.length) raw.otherClientNames = f.value;
      } else if (!(f.key in raw.config) && f.source === '3.0') raw.config[f.key] = f.value;
    });

    const goalEdits = Wizard.numbers_(vals.goal || {}, Wizard.GOAL_FIELDS);
    const objEdits = vals.objective || {};
    const start = objEdits.start || (vals.goal && vals.goal.start) || base.goal.start || base.objective.start || raw.config['client.startDate'] || null;
    raw.history.goals = raw.history.goals || [];
    raw.history.objectives = raw.history.objectives || [];
    if (Object.keys(goalEdits).length || (!raw.history.goals.length && base.goal.kcal !== null)) {
      let g = raw.history.goals[0];
      if (!g) { g = { id: base.goal.id, start }; raw.history.goals.push(g); }
      Wizard.GOAL_FIELDS.forEach((k) => { if (goalEdits[k] !== undefined) g[k] = goalEdits[k]; else if (g[k] === undefined && base.goal[k] !== null) g[k] = base.goal[k]; });
      if (!g.start && start) g.start = start;
      delete g.carbs;
    }
    if (objEdits.name || objEdits.analysisType || (!raw.history.objectives.length && base.objective.name)) {
      let o = raw.history.objectives[0];
      if (!o) { o = { id: base.objective.id, start }; raw.history.objectives.push(o); }
      Wizard.OBJECTIVE_FIELDS.forEach((k) => { if (objEdits[k]) o[k] = objEdits[k]; else if (o[k] === undefined && base.objective[k]) o[k] = base.objective[k]; });
      if (!o.analysisType) o.analysisType = 'personalizado';
      if (!o.start && start) o.start = start;
    }

    const errors = Wizard.validate_(raw);
    if (errors.length) throw new Error(errors.join(' '));
    return Migrate.run(raw);
  },

  /** Values the migration needs before writing anything (sex is asked, never assumed). */
  validate_(raw) {
    const parsed = Migrate.parseClient(raw);
    const errors = parsed.errors.slice();
    if (!parsed.client) return errors;
    const c = parsed.client.config;
    if (!c['client.name']) errors.push('Informe o nome.');
    if (c['client.sex'] !== 'M' && c['client.sex'] !== 'F') errors.push('Informe o sexo (M ou F), usado só na TMB.');
    if (typeof c['client.age'] !== 'number' && !c['client.birthDate']) errors.push('Informe a idade ou a data de nascimento.');
    const h = c['client.heightCm'];
    if (typeof h !== 'number' || h < Wizard.HEIGHT_CM[0] || h > Wizard.HEIGHT_CM[1]) errors.push(`Altura em centímetros entre ${Wizard.HEIGHT_CM[0]} e ${Wizard.HEIGHT_CM[1]} (ex.: 179).`);
    if (typeof c['client.startWeightKg'] !== 'number' || c['client.startWeightKg'] <= 0) errors.push('Informe o peso inicial em kg.');
    const goal = parsed.client.history.goals[0];
    if (goal) {
      if (typeof goal.fields.kcal !== 'number' || goal.fields.kcal <= 0) errors.push('Meta: informe as kcal.');
      if (typeof goal.fields.protein !== 'number' || goal.fields.protein <= 0) errors.push('Meta: informe a proteína.');
      if (!goal.start) errors.push('Meta: informe o início.');
    }
    return errors;
  },

  /** Numbers from form strings ("2.400", "313,75" → 2400, 313.75); empty keys are left out. */
  numbers_(obj, keys) {
    const out = {};
    keys.forEach((k) => {
      const v = obj[k];
      if (v === undefined || v === null || v === '') return;
      const n = typeof v === 'number' ? v : Number(String(v).trim().replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
      if (!isFinite(n)) throw new Error(`Valor inválido para ${k}: ${v}`);
      out[k] = n;
    });
    return out;
  },

  /** The latest version of an entity on the sheet (4.0 tab name), or null. */
  sheetVersion_(id) {
    if (!Tabs.findSheet(id)) return null;
    const repo = { goals: Goals, objectives: Objectives, plans: Plans }[id];
    const list = repo.list();
    return list.length ? list[list.length - 1] : null;
  },

  /** Plan versions on the sheet (4.0 or 3.0 tab) with their dates as read (technical = null). */
  sheetPlans_() {
    const { sheet } = Audit.locate_('plans');
    if (!sheet) return [];
    const m = Audit.headerMatch(sheet, 'plans');
    const lastRow = sheet.getLastRow();
    const spec = Tabs.get('plans');
    if (lastRow < spec.firstDataRow || !m.map.id) return [];
    const values = sheet.getRange(spec.firstDataRow, 1, lastRow - spec.firstDataRow + 1, m.lastCol).getValues();
    const out = [];
    values.forEach((line) => {
      const id = String(line[m.map.id - 1] || '').trim();
      if (!id || out.some((p) => p.id === id)) return;
      const start = (m.map.start && Dates.key(line[m.map.start - 1])) || (m.map.legacyStart && Dates.key(line[m.map.legacyStart - 1])) || null;
      out.push({ id, start, end: m.map.end ? Dates.key(line[m.map.end - 1]) || null : null, source: 'planilha' });
    });
    return out;
  },

  plain_(v) {
    if (v instanceof Date) return Dates.key(v) || null;
    if (Array.isArray(v)) return v.slice();
    return v === undefined ? null : v;
  },

  /** Opens the dialog. */
  show(mode) {
    const t = HtmlService.createTemplateFromFile('wizard');
    t.mode = mode === 'setup' ? 'setup' : 'migrate';
    const title = t.mode === 'setup' ? 'Configuração inicial' : 'Migrar 3.0 → 4.0';
    SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(760).setHeight(680), title);
    return null;
  },
};

/* Called by wizard.html through google.script.run. */
function wizardProposal(jsonText) {
  return Wizard.proposal(jsonText || null);
}

function wizardConfirm(values) {
  const r = Wizard.confirm(values);
  return {
    ok: r.ok, alreadyMigrated: r.alreadyMigrated, message: r.message, changes: r.changes,
    open: (r.findingsAfter || []).map((f) => `${f.severity}: ${f.tab} ${f.cell} — ${f.finding}`),
    postSteps: r.postSteps || [],
  };
}

Actions.register({
  id: 'setupWizard', label: 'Configuração inicial', group: 'system', order: 10, logged: false, locked: false,
  run: () => Wizard.show('setup'),
});

Actions.register({
  id: 'migrate', label: 'Migrar 3.0 → 4.0', group: 'system', order: 20, logged: false, locked: false,
  run: () => Wizard.show('migrate'),
});

Actions.register({
  id: 'audit', label: 'Auditoria', group: 'system', order: 30,
  run: () => {
    const r = Audit.run();
    return { message: r.message, findings: r.findings.length };
  },
});
