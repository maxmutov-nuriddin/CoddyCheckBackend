const env = require("../config/env");

async function sendTelegramMessage({ telegramId, text, replyMarkup }) {
  if (!env.telegramBotToken || !telegramId) {
    return { skipped: true, reason: "Missing telegram token or chat id" };
  }

  const url = `${env.telegramApiBase}/bot${env.telegramBotToken}/sendMessage`;
  const body = {
    chat_id: telegramId,
    text,
    parse_mode: "HTML"
  };

  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const json = await response.json();

  if (!response.ok || !json.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(json)}`);
  }

  return json;
}

module.exports = {
  sendTelegramMessage
};
