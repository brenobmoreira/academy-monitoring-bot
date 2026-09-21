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
   * The confirmation is how the user notices a misparse (82.4 read as 8.24),
   * so it echoes exactly what was written, field by field.
   */
  formatConfirmation(entry, result) {
    const day = Utilities.formatDate(entry.date, Session.getScriptTimeZone(), 'dd/MM');
    if (result.written.length === 0) return `${day}: nothing recognized`;
    const parts = result.written.map((field) => {
      const header = Schema.FIELDS[field].header;
      return `${header} ${Schema.toCell(field, entry[field])}`;
    });
    return `${day} · ${parts.join(' · ')}`;
  },
};
