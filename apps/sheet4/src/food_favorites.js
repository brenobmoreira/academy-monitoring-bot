/**
 * Favourite meals: Favoritas (one row per version) + Ingredientes (one row per food of a version).
 *
 * Favourites start empty (3.0 rule) and are created only from a meal already registered in
 * Alimentação ("Criar favorita da refeição"): creating one never logs consumption. Saving the same
 * name again creates the next version (v1, v2…); older versions are kept, so the
 * `Favorita / versão` of past Alimentação rows still points at what was eaten. Launching uses the
 * latest version. Saving ingredients identical to the latest version is refused.
 *
 * Ingredient quantities are in the food's base unit. `Conferência` of an ingredient keeps the
 * Cálculo of the row it came from (Calculado | Estimado | Sem cálculo), so a household-measure
 * estimate stays an estimate when the favourite is launched again.
 */
const Favorites = {
  VERSION_PREFIX: 'v',
  LABEL_SEP: ' · ',

  versionNumber_(v) {
    const m = /^\s*v?\s*(\d+)\s*$/i.exec(String(v === null || v === undefined ? '' : v));
    return m ? Number(m[1]) : 1; // 3.0 rows without a version are v1
  },

  versionText_(n) {
    return `${Favorites.VERSION_PREFIX}${n}`;
  },

  /** "Name · v2", as written in Alimentação `Favorita / versão`. */
  label(fav) {
    return `${String(fav.name).trim()}${Favorites.LABEL_SEP}${Favorites.versionText_(Favorites.versionNumber_(fav.version))}`;
  },

  /** Every version row of Favoritas. */
  all() {
    return Tabs.read('favorites').filter((f) => f.name !== null && String(f.name).trim() !== '');
  },

  /** Versions of one favourite, oldest first. */
  versions(name) {
    const k = Tabs.normalize_(name);
    return Favorites.all().filter((f) => Tabs.normalize_(f.name) === k)
      .sort((a, b) => Favorites.versionNumber_(a.version) - Favorites.versionNumber_(b.version));
  },

  /** Latest version of a favourite, or null. */
  latest(name) {
    if (!Tabs.normalize_(name)) return null;
    const v = Favorites.versions(name);
    return v.length ? v[v.length - 1] : null;
  },

  /**
   * Latest version of every favourite, in first-creation order, with its ingredients.
   * @returns {Object[]} favourite rows + {versionNumber, label, ingredients}
   */
  list() {
    const seen = [];
    Favorites.all().forEach((f) => { if (seen.indexOf(Tabs.normalize_(f.name)) < 0) seen.push(Tabs.normalize_(f.name)); });
    return seen.map((k) => {
      const fav = Favorites.latest(k);
      return Object.assign({}, fav, {
        versionNumber: Favorites.versionNumber_(fav.version),
        label: Favorites.label(fav),
        ingredients: Favorites.ingredients(fav.name, fav.version),
      });
    });
  },

  /** Names for the Hoje validation list (latest versions). */
  names() {
    return Favorites.list().map((f) => String(f.name).trim());
  },

  /** Ingredient rows of one version. */
  ingredients(name, version) {
    const k = Tabs.normalize_(name);
    const n = Favorites.versionNumber_(version);
    return Tabs.read('ingredients').filter((i) => Tabs.normalize_(i.favorite) === k && Favorites.versionNumber_(i.version) === n);
  },

  /**
   * Creates a favourite (or its next version) from the rows of a meal on a date.
   * @param {{date, meal: string, name: string, note?: string}} args
   * @returns {{name, version: string, label: string, ingredients: number, message: string}}
   */
  create(args) {
    const a = args || {};
    const name = a.name === null || a.name === undefined ? '' : String(a.name).trim();
    if (!name) throw new Error('Informe o nome da favorita.');
    const date = Dates.require(a.date || Dates.today(), 'Data');
    const meal = a.meal === null || a.meal === undefined ? '' : String(a.meal).trim();
    if (!meal || meal === FoodLog.ALL_MEALS) throw new Error('Informe a refeição que vira favorita.');
    const rows = FoodLog.rows(date).filter((r) => Tabs.same_(r.meal, meal));
    if (!rows.length) throw new Error(`Nenhum alimento em ${meal} de ${Dates.format(date)}. Registre a refeição antes de criar a favorita.`);
    const ings = rows.map((r) => {
      const kind = FoodLog.kind(r);
      const ing = { food: r.food, qty: r.qty, unit: r.unit, check: kind };
      Foods.MACROS.forEach((k) => { ing[k] = kind === FoodLog.CALC.NO_CALC ? null : r[k]; });
      return ing;
    });
    const latest = Favorites.latest(name);
    if (latest && Favorites.sameIngredients_(Favorites.ingredients(latest.name, latest.version), ings)) {
      throw new Error(`A favorita "${Favorites.label(latest)}" já tem exatamente esses ingredientes.`);
    }
    const n = latest ? Favorites.versionNumber_(latest.version) + 1 : 1;
    const version = Favorites.versionText_(n);
    const favName = latest ? String(latest.name).trim() : name;
    const fav = { name: favName, version, note: a.note || `Criada de ${meal} de ${Dates.format(date)}` };
    Foods.MACROS.forEach((k) => {
      const nums = ings.filter((i) => i.check !== FoodLog.CALC.NO_CALC).map((i) => i[k]).filter((v) => typeof v === 'number');
      fav[k] = nums.length ? Units.round(nums.reduce((x, y) => x + y, 0), 1) : null;
    });
    Tabs.append('favorites', fav);
    Tabs.appendMany('ingredients', ings.map((i) => Object.assign({ favorite: favName, version }, i)));
    const label = Favorites.label(fav);
    return {
      name: favName, version, label, ingredients: ings.length,
      message: `Favorita criada: ${label} (${ings.length} itens de ${meal} de ${Dates.format(date)}). Nada foi lançado.`,
    };
  },

  sameIngredients_(a, b) {
    const sig = (list) => list.map((i) => [Tabs.normalize_(i.food), i.qty === null ? '' : Units.round(i.qty, 4), Units.normalize(i.unit)].join('|')).sort().join('#');
    return sig(a) === sig(b);
  },
};

Actions.register({
  id: 'foodCreateFavorite', label: 'Criar favorita da refeição', group: 'food', order: 70,
  run: () => {
    const s = FoodScreen.read();
    const ui = SpreadsheetApp.getUi();
    const hint = s.favorite ? ` Vazio = nova versão de "${s.favorite}".` : '';
    const res = ui.prompt('Criar favorita', `Nome da favorita para ${s.meal || 'a refeição'} de ${Dates.format(s.date || Dates.today())}.${hint}`, ui.ButtonSet.OK_CANCEL);
    if (res.getSelectedButton() !== ui.Button.OK) return { message: 'Criação cancelada.' };
    const name = String(res.getResponseText() || '').trim() || s.favorite;
    return Favorites.create({ date: s.date, meal: s.meal, name });
  },
});
