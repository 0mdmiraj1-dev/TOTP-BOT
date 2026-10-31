/*CMD
  command: /start
  aliases: /home, /cancel
  help: Open the vault home menu
  need_reply: false
CMD*/
if (!user || !chat || chat.chat_type !== "private" || !tgUpdate) {
  return;
}
var original = tgUpdate.message;
if (
  !original ||
  !original.from ||
  String(original.from.id) !== String(user.telegramid) ||
  String(original.chat.id) !== String(user.telegramid)
) {
  return;
}
var endpoint = Bot.getProp("vault:origin");
var secret = Bot.getProp("vault:forward_key");
if (!endpoint || !secret) {
  Bot.sendMessage("Vault integration is not configured.");
  return;
}
var payload = JSON.stringify({
  actor: String(original.from.id),
  event: String(tgUpdate.update_id),
  timestamp: Date.now(),
  action: "home",
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
