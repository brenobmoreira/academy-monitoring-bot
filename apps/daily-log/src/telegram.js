/**
 * Outbound Telegram Bot API calls and message formatting.
 */
const Telegram = {
  sendMessage(chatId, text) {
    const url = `https://api.telegram.org/bot${Config.telegramBotToken()}/sendMessage`;
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chatId, text }),
      muteHttpExceptions: true,
    });
    if (response.getResponseCode() !== 200) {
      console.error(`sendMessage failed: ${response.getContentText()}`);
    }
  },

  /**
   * The confirmation is how the user notices a misparse (82.4 read as 8.24), so it echoes
   * exactly what was written, field by field, one line per part.
   */
  formatConfirmation(entry, result) {
    const day = Utilities.formatDate(entry.date, Session.getScriptTimeZone(), 'dd/MM');
    const lines = [];
    if (result.diary && result.diary.written.length) {
      const parts = result.diary.written.map((field) => {
        const header = Schema.DIARY_FIELDS[field].header.replace(/ \d–\d$/, '');
        return `${header} ${Telegram.cell_(Schema.toCell(field, entry.diary[field]))}`;
      });
      lines.push(`${day} · ${parts.join(' · ')}`);
    }
    if (result.workout) {
      lines.push(`${day} · ${entry.workout.session}${entry.workout.phase ? ` (${entry.workout.phase})` : ''}:`);
      result.workout.exercises.forEach((ex) => {
        const sets = ex.sets.map((s) => `${Telegram.cell_(s.kg)}×${s.reps}`).join(' ');
        const extras = [];
        const src = entry.workout.exercises.find((e) => WorkoutPlan.normalize(e.name) === WorkoutPlan.normalize(ex.name))
          || entry.workout.exercises[result.workout.exercises.indexOf(ex)];
        if (src && src.rir !== undefined) extras.push(`RIR ${src.rir}`);
        if (src && src.pain !== undefined) extras.push(`dor ${src.pain}`);
        const flag = ex.known ? '' : ' ⚠ não está no cadastro';
        lines.push(`• ${ex.name} ${sets}${extras.length ? ` (${extras.join(', ')})` : ''}${flag}`);
      });
    }
    if (!lines.length) return `${day}: nada reconhecido`;
    if (entry.warning) lines.push(`⚠ ${entry.warning}`);
    return lines.join('\n');
  },

  cell_(v) {
    return typeof v === 'number' ? String(v).replace('.', ',') : String(v);
  },
};
