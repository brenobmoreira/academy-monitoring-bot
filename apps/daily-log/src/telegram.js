/**
 * Outbound Telegram Bot API calls.
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
   * The confirmation is how the user notices a misparse (82.4 read as 8.24).
   * F0: echoes the raw text. F1 renders the parsed fields.
   */
  formatConfirmation(entry) {
    return `Logged for ${entry.date}: ${entry.raw}`;
  },
};
