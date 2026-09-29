/**
 * Day rows of the Diário tab, shared by every module that writes something about a day.
 *
 * Food writes its totals, Workout its session count, Hoje the measures: all through `patch`, which
 * creates the day's row when it is missing and stamps the objective, goal and plan in force on that
 * date (never the current ones). Writes go through Tabs, so they join the running undoable action.
 */
const Days = {
  /** Keys a caller may patch; ids and the date are owned by this module. */
  OWNED: ['date', 'objective', 'goal', 'plan'],

  /** @returns {Object|null} the Diário row of `date` (objects keyed by column key), or null. */
  get(date) {
    return Tabs.findByDate('diary', Dates.require(date, 'data'))[0] || null;
  },

  /** Ids in force on `date`: {objective, goal, plan}, null where no version covers the date. */
  idsOn(date) {
    const pick = (repo) => { const v = repo.on(date); return v ? v.id : null; };
    return { objective: pick(Objectives), goal: pick(Goals), plan: pick(Plans) };
  },

  /**
   * Writes `fields` on the row of `date`, creating it when needed, and re-stamps the ids.
   * Only the given keys change; a key with value null clears the cell (não informado).
   * @returns {number} the row written
   */
  patch(date, fields) {
    const day = Dates.require(date, 'data');
    const bad = Object.keys(fields || {}).filter((k) => Days.OWNED.includes(k));
    if (bad.length) throw new Error(`Campos controlados pelo sistema: ${bad.join(', ')}`);
    const values = Object.assign({}, fields, Days.idsOn(day));
    const row = Days.get(day);
    if (row) {
      Tabs.update('diary', row._row, values);
      return row._row;
    }
    return Tabs.append('diary', Object.assign({ date: day }, values));
  },

  /** Re-stamps the ids of every existing day (after a transition or when recalculating). */
  restampAll() {
    let changed = 0;
    Tabs.read('diary').forEach((row) => {
      if (!row.date) return;
      const ids = Days.idsOn(row.date);
      if (ids.objective !== row.objective || ids.goal !== row.goal || ids.plan !== row.plan) {
        Tabs.update('diary', row._row, ids);
        changed += 1;
      }
    });
    return changed;
  },
};
