/*CMD
  command: /vault
  help: Handle opaque vault menu buttons
  need_reply: false
CMD*/
if (!user || !chat || chat.chat_type !== "private" || !tgUpdate) {
  return;
}
var callback = tgUpdate.callback_query;
if (
  !callback ||
  !callback.from ||
  !callback.message ||
  String(callback.from.id) !== String(user.telegramid) ||
  String(callback.message.chat.id) !== String(user.telegramid)
) {
  return;
}
Api.answerCallbackQuery({ callback_query_id: callback.id });
if (!/^[a-f0-9]{32}$/.test(params || "")) {
  Bot.sendMessage("Button expired. Send /start.");
  return;
}
var endpoint = Bot.getProp("vault:origin");
var secret = Bot.getProp("vault:forward_key");
if (!endpoint || !secret) {
  Bot.sendMessage("Vault integration is not configured.");
  return;
}
var payload = JSON.stringify({
  actor: String(callback.from.id),
  event: String(tgUpdate.update_id),
  timestamp: Date.now(),
  action: "callback",
  callback: params,
  message: callback.message.message_id,
});
HTTP.post({
  url: endpoint + "/api/bot",
  headers: {
    "Content-Type": "application/json",
    "X-Vault-Signature": CryptoJS.HmacSHA256(payload, secret).toString(
      CryptoJS.enc.Hex,
    ),
  },
  body: payload,
  folow_redirects: false,
  success: "/vault-response",
  error: "/vault-error",
});
