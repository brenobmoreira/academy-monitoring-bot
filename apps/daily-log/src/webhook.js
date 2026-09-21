/**
 * Web App entry point. Telegram POSTs every update here.
 *
 * Auth: Apps Script exposes no request headers, so Telegram's secret_token cannot be
 * verified. Instead the webhook URL carries ?secret=... and the sender's chat id must be
 * allowlisted. Anything that fails auth is silently acknowledged so Telegram stops retrying.
 */
function doPost(e) {
  try {
    if (!Webhook.isAuthorizedRequest_(e)) return Webhook.ok_();

    const update = JSON.parse(e.postData.contents);
    const message = update.message;
    if (!message || !message.text) return Webhook.ok_();

    const chatId = String(message.chat.id);
    if (!Webhook.isAllowedChat_(chatId)) return Webhook.ok_();

    Webhook.handleMessage_(chatId, message.text);
  } catch (err) {
    console.error(err);
  }
  return Webhook.ok_();
}

const Webhook = {
  isAuthorizedRequest_(e) {
    const given = e && e.parameter && e.parameter.secret;
    return Boolean(given) && given === Config.webhookSecret();
  },

  isAllowedChat_(chatId) {
    return Config.allowedChatIds().includes(chatId);
  },

  /**
   * F0: prove the round trip works by writing a fixed row and echoing back.
   * F1 replaces this with Parser.parse -> SheetRepo.upsert -> confirmation.
   */
  handleMessage_(chatId, text) {
    const entry = Parser.parse(text);
    SheetRepo.upsert(entry);
    Telegram.sendMessage(chatId, Telegram.formatConfirmation(entry));
  },

  ok_() {
    return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
  },
};
