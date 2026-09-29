/**
 * Client configuration (spec §3.2): the Config tab, a key/value table (Chave | Parâmetro | Valor |
 * Unidade | Descrição) grouped by section title rows (rows with no Chave). Keys are English ids;
 * labels, units and descriptions are Portuguese and come from Config.DEFAULTS, which Setup renders.
 *
 * Config.get(key) returns the typed sheet value, or the default when the cell is empty or the tab
 * or row is missing. An unparseable value throws a Portuguese message naming the parameter.
 * Secrets (SHEET_API_KEY) live in Script Properties, never in the sheet.
 *
 * The objective, goal and plan in force are not keys: they come from the entities.
 */
const Config = {
  SCHEMA_VERSION: '4.0',

  SECTIONS: ['Perfil', 'Rotina', 'Energia', 'Análise', 'Sistema'],

  /**
   * key → {section, label, type, default, unit, description, options?}
   * type: 'text' | 'enum' | 'date' | 'number' | 'integer' | 'list' (comma-separated)
   * No client data here: defaults are empty or generic thresholds.
   */
  DEFAULTS: {
    'client.name': { section: 'Perfil', label: 'Nome', type: 'text', default: null, unit: '', description: 'Nome exibido nos títulos e no Painel.' },
    'client.sex': { section: 'Perfil', label: 'Sexo (TMB)', type: 'enum', options: ['M', 'F'], default: null, unit: 'M/F', description: 'Usado só na equação de TMB (Mifflin-St Jeor).' },
    'client.birthDate': { section: 'Perfil', label: 'Data de nascimento', type: 'date', default: null, unit: 'data', description: 'Se preenchida, a idade é calculada na data de cada meta.' },
    'client.age': { section: 'Perfil', label: 'Idade', type: 'integer', default: null, unit: 'anos', description: 'Usada quando a data de nascimento não foi informada.' },
    'client.heightCm': { section: 'Perfil', label: 'Altura', type: 'number', default: null, unit: 'cm', description: 'Altura em centímetros.' },
    'client.startWeightKg': { section: 'Perfil', label: 'Peso inicial', type: 'number', default: null, unit: 'kg', description: 'Peso no início do acompanhamento (referência, não medição datada).' },
    'client.startDate': { section: 'Perfil', label: 'Início do acompanhamento', type: 'date', default: null, unit: 'data', description: 'Data do primeiro registro.' },
    'client.reviewer': { section: 'Perfil', label: 'Revisor', type: 'text', default: null, unit: '', description: 'Quem revisa metas, fichas e fases.' },

    'routine.strengthPerWeek': { section: 'Rotina', label: 'Musculação', type: 'integer', default: null, unit: 'sessões/semana', description: 'Treinos de musculação planejados por semana.' },
    'routine.cardioPerWeek': { section: 'Rotina', label: 'Cardio', type: 'integer', default: null, unit: 'sessões/semana', description: 'Sessões de cardio planejadas por semana.' },
    'routine.activities': { section: 'Rotina', label: 'Atividades', type: 'text', default: null, unit: '', description: 'Outras atividades (ex.: luta, corrida).' },
    'routine.activitiesPerWeek': { section: 'Rotina', label: 'Atividades por semana', type: 'integer', default: null, unit: 'sessões/semana', description: 'Sessões das outras atividades por semana.' },
    'routine.sessionRotation': { section: 'Rotina', label: 'Rotação de sessões', type: 'list', default: [], unit: 'lista', description: 'Sessões da ficha em ordem, separadas por vírgula.' },
    'routine.rotationMode': { section: 'Rotina', label: 'Modo da rotação', type: 'enum', options: ['continuous', 'weekly'], default: 'continuous', unit: '', description: 'continuous = próxima sessão após a última concluída; weekly = recomeça toda semana.' },
    'routine.adaptationWeeks': { section: 'Rotina', label: 'Semanas de adaptação', type: 'integer', default: 0, unit: 'semanas', description: 'Semanas, a partir do início de cada ficha, em que valem as colunas de adaptação (séries e RIR). 0 = sempre regular.' },
    'routine.loadIncrementKg': { section: 'Rotina', label: 'Incremento de carga sugerido', type: 'number', default: 2.5, unit: 'kg', description: 'Aumento proposto pelas sugestões de progressão. Nunca aplicado automaticamente.' },

    'energy.bmrMethod': { section: 'Energia', label: 'Método da TMB', type: 'enum', options: ['mifflin'], default: 'mifflin', unit: '', description: 'Equação usada para a taxa metabólica basal.' },
    'energy.activityFactor': { section: 'Energia', label: 'Fator de atividade', type: 'number', default: 1.55, unit: '×', description: 'Multiplica a TMB para o gasto estimado. Estimativa: revisar.' },

    'analysis.weightTrendDays': { section: 'Análise', label: 'Dias da média de peso', type: 'integer', default: 7, unit: 'dias', description: 'Janela da média móvel de peso.' },
    'analysis.minWeighInsPerWeek': { section: 'Análise', label: 'Pesagens mínimas', type: 'integer', default: 3, unit: 'por semana', description: 'Abaixo disso a tendência de peso é dados insuficientes.' },
    'analysis.minCompleteFoodDays': { section: 'Análise', label: 'Dias completos mínimos', type: 'integer', default: 4, unit: 'por semana', description: 'Dias com alimentação completa para avaliar a dieta.' },
    'analysis.kcalTolerance': { section: 'Análise', label: 'Tolerância kcal', type: 'number', default: 0.05, unit: 'fração', description: 'Faixa aceita em torno da meta de kcal (0,05 = ±5%).' },
    'analysis.fatTolerance': { section: 'Análise', label: 'Tolerância gordura', type: 'number', default: 0.15, unit: 'fração', description: 'Faixa aceita em torno da meta de gordura.' },
    'analysis.waistNoiseCm': { section: 'Análise', label: 'Ruído da cintura', type: 'number', default: 0.5, unit: 'cm', description: 'Variações menores são tratadas como estáveis.' },
    'analysis.weightNoisePctPerWeek': { section: 'Análise', label: 'Ruído do peso', type: 'number', default: 0.25, unit: '%/semana', description: 'Variações menores são tratadas como peso estável.' },
    'analysis.sleepMinH': { section: 'Análise', label: 'Sono mínimo', type: 'number', default: 7, unit: 'h', description: 'Média abaixo disso gera sinal de sono baixo.' },
    'analysis.fatigueHigh': { section: 'Análise', label: 'Cansaço alto', type: 'number', default: 4, unit: '1–5', description: 'Média a partir disso gera sinal de fadiga alta.' },
    'analysis.hungerHigh': { section: 'Análise', label: 'Fome alta', type: 'number', default: 4, unit: '1–5', description: 'Média a partir disso gera sinal de fome alta.' },
    'analysis.painHigh': { section: 'Análise', label: 'Dor alta', type: 'number', default: 4, unit: '0–10', description: 'Máximo a partir disso gera sinal de dor alta.' },
    'analysis.reviewEveryDays': { section: 'Análise', label: 'Intervalo de revisão', type: 'integer', default: 7, unit: 'dias', description: 'Próxima revisão sugerida após uma decisão.' },
    'analysis.minWeeksForPhaseReview': { section: 'Análise', label: 'Semanas mínimas por fase', type: 'integer', default: 8, unit: 'semanas', description: 'Antes disso não se sugere revisar objetivo/fase por sucesso.' },
    'analysis.progressionSessions': { section: 'Análise', label: 'Sessões para sugerir progressão', type: 'integer', default: 2, unit: 'sessões', description: 'Sessões seguidas no topo da faixa de reps (ou em queda) antes de gerar uma sugestão.' },
    'analysis.weightFastPctPerWeek': { section: 'Análise', label: 'Peso rápido', type: 'number', default: 0.5, unit: '%/semana', description: 'Variação acima disso é descrita como rápida (sinais peso_*_rapido); até ela, lenta.' },
    'analysis.adherenceMin': { section: 'Análise', label: 'Aderência mínima', type: 'number', default: 0.7, unit: 'fração', description: 'Fração dos dias completos dentro da meta (kcal, proteína) abaixo da qual há sinal de aderência baixa.' },
    'analysis.phaseReviewStreak': { section: 'Análise', label: 'Semanas seguidas p/ revisar fase', type: 'integer', default: 3, unit: 'semanas', description: 'Semanas seguidas no caminho (com a expectativa atendida) ou fora do esperado para sugerir revisar objetivo/fase.' },

    'system.schemaVersion': { section: 'Sistema', label: 'Versão do esquema', type: 'text', default: null, unit: '', description: 'Gravada pela migração/configuração inicial. Não editar.' },
    'system.timezone': { section: 'Sistema', label: 'Fuso horário', type: 'text', default: null, unit: '', description: 'Vazio = fuso do projeto do Apps Script.' },
  },

  /** Script Properties holding secrets. */
  SECRETS: { SHEET_API_KEY: 'SHEET_API_KEY' },

  cache_: null,

  /** Forgets the values read in this execution. */
  invalidate() {
    Config.cache_ = null;
  },

  keys() {
    return Object.keys(Config.DEFAULTS);
  },

  def_(key) {
    const def = Config.DEFAULTS[key];
    if (!def) throw new Error(`Unknown config key: ${key}`);
    return def;
  },

  /** {key: {value, row}} of the rows present on the Config tab (empty when the tab is missing). */
  read_() {
    if (Config.cache_) return Config.cache_;
    const out = {};
    if (Tabs.findSheet('config')) {
      Tabs.read('config').forEach((r) => {
        if (r.key === null) return;
        const key = String(r.key).trim();
        if (key && !(key in out)) out[key] = { value: r.value, row: r._row };
      });
    }
    Config.cache_ = out;
    return out;
  },

  /** Raw cell value of a key, or null. */
  raw(key) {
    Config.def_(key);
    const entry = Config.read_()[key];
    return entry ? entry.value : null;
  },

  /** Typed value; the default when empty. Throws a Portuguese message when the value is invalid. */
  get(key) {
    const def = Config.def_(key);
    const raw = Config.raw(key);
    if (raw === null || raw === undefined || raw === '') return Config.copy_(def.default);
    const value = Config.coerce_(def, raw);
    if (value === undefined) throw new Error(`Config: valor inválido para "${def.label}" (${key}): ${JSON.stringify(raw instanceof Date ? String(raw) : raw)}`);
    return value;
  },

  /** True when the key has a non-empty value on the sheet. */
  has(key) {
    const raw = Config.raw(key);
    return raw !== null && raw !== undefined && raw !== '';
  },

  getNumber(key) {
    const v = Config.get(key);
    return v === null ? null : Number(v);
  },

  getString(key) {
    const v = Config.get(key);
    return v === null ? null : String(v);
  },

  getDate(key) {
    return Config.get(key);
  },

  getList(key) {
    const v = Config.get(key);
    return Array.isArray(v) ? v : (v === null ? [] : [v]);
  },

  /** {key: typed value} for every key. */
  all() {
    const out = {};
    Config.keys().forEach((k) => { out[k] = Config.get(k); });
    return out;
  },

  /** Converts a raw cell value; undefined means invalid. */
  coerce_(def, raw) {
    switch (def.type) {
      case 'number':
      case 'integer': {
        let n = raw;
        if (typeof raw === 'string') {
          const s = raw.trim().replace(/\s/g, '');
          const pct = s.endsWith('%');
          n = Number((pct ? s.slice(0, -1) : s).replace(',', '.'));
          if (pct) n /= 100;
        }
        if (typeof n !== 'number' || !isFinite(n)) return undefined;
        if (def.type === 'integer' && Math.round(n) !== n) return undefined;
        return n;
      }
      case 'date': {
        const d = Dates.parse(raw);
        return d || undefined;
      }
      case 'enum': {
        const s = String(raw).trim();
        const match = def.options.find((o) => o.toLowerCase() === s.toLowerCase());
        return match === undefined ? undefined : match;
      }
      case 'list':
        return String(raw).split(',').map((s) => s.trim()).filter((s) => s !== '');
      default:
        return raw instanceof Date ? raw : String(raw);
    }
  },

  copy_(v) {
    return Array.isArray(v) ? v.slice() : v;
  },

  /** Cell value for a typed value (lists joined with ", "). */
  toCell_(def, value) {
    if (value === null || value === undefined) return '';
    if (def.type === 'list') return (Array.isArray(value) ? value : [value]).join(', ');
    if (def.type === 'date') return Dates.require(value, def.label);
    return value;
  },

  /**
   * Writes a value (validated) to the key's row, appending the row when missing. Goes through
   * Tabs, so it is logged when an action is running.
   */
  set(key, value) {
    const def = Config.def_(key);
    const cell = Config.toCell_(def, value);
    if (cell !== '' && Config.coerce_(def, cell) === undefined) {
      throw new Error(`Config: valor inválido para "${def.label}" (${key}): ${JSON.stringify(value)}`);
    }
    const entry = Config.read_()[key];
    if (entry) Tabs.update('config', entry.row, { value: cell });
    else Tabs.append('config', { key, label: def.label, value: cell, unit: def.unit, description: def.description });
    Config.invalidate();
  },

  /**
   * Rows Setup renders, grouped by section: [{section, items: [{key, label, type, unit,
   * description, default, options?}]}].
   */
  sections() {
    return Config.SECTIONS.map((section) => ({
      section,
      items: Config.keys().filter((k) => Config.DEFAULTS[k].section === section).map((k) => Object.assign({ key: k }, Config.DEFAULTS[k])),
    }));
  },

  /** Age on a date: from birthDate when set, else client.age; null when neither. */
  ageOn(date) {
    const birth = Config.get('client.birthDate');
    if (birth) return Dates.age(birth, date);
    return Config.get('client.age');
  },

  /** Script time zone unless system.timezone overrides it (display only). */
  timezone() {
    return Config.get('system.timezone') || Session.getScriptTimeZone();
  },

  /* Script Properties ------------------------------------------------------------------------ */

  secret(name, fallback) {
    const v = PropertiesService.getScriptProperties().getProperty(name);
    if (v === null || v === '') {
      if (fallback !== undefined) return fallback;
      throw new Error(`Script Property ausente: ${name}`);
    }
    return v;
  },

  setSecret(name, value) {
    PropertiesService.getScriptProperties().setProperty(name, value);
  },

  sheetApiKey() {
    return Config.secret(Config.SECRETS.SHEET_API_KEY);
  },
};
