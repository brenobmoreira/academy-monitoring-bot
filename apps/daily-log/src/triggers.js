/**
 * Scheduled reminder. Run `setupTriggers` once from the editor after deploying.
 */
const REMINDER_HANDLER = 'sendDailyReminder';
const REMINDER_TEXT = 'Como foi hoje? peso, sono, passos, cardio, muay, dieta, fome, cansaço… e o treino, se teve.';

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
    Telegram.sendMessage(chatId, REMINDER_TEXT);
  });
}
