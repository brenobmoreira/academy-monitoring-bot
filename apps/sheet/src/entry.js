/**
 * Applies an Entry to the spreadsheet. Both adapters (chat, sheet menu) end here.
 */
const EntryService = {
  /**
   * @param {{date: Date, diary?: Object, workout?: Object}} entry
   * @returns {{date: Date, diary?: {row, written}, workout?: {rows, exercises}}}
   */
  apply(entry) {
    const result = { date: entry.date };
    if (entry.diary && Object.keys(entry.diary).length) {
      result.diary = DiaryRepo.upsert(entry.date, entry.diary);
    }
    if (entry.workout) {
      result.workout = WorkoutRepo.saveSession(entry.date, entry.workout);
    }
    return result;
  },

  isEmpty(entry) {
    return !(entry.diary && Object.keys(entry.diary).length) && !entry.workout;
  },
};
