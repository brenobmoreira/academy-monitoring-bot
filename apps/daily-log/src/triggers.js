/**
 * Scheduled reminder (F2). Run `setupTriggers` once from the editor after deploying.
 */
const REMINDER_HANDLER = 'sendDailyReminder';

function setupTriggers() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === REMINDER_HANDLER)
    .forEach((t) => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger(REMINDER_HANDLER)
    .timeBased()
    .everyDays(1)
    .atHour(Config.reminderHour())
    .create();
}

function sendDailyReminder() {
  Config.allowedChatIds().forEach((chatId) => {
    Telegram.sendMessage(chatId, 'How was today? weight, sleep, load, trained?');
  });
}
