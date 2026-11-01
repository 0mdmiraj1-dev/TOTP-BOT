# Bots.Business — four complete commands

Use the same bot whose token is configured on Vercel. In the command editor set Wait for answer OFF and leave Answer/Keyboard empty. Configure `/start` aliases `/home` and `/cancel` in the editor. Bot properties: `vault:origin` (String, your HTTPS origin) and `vault:forward_key` (String, same value as private `BB_FORWARD_SECRET`). No secret is embedded in this source.

These are the complete current files. Headers are comments in a manual BJS paste. For Git import, copy **the contents of bots-business/** into a dedicated repository root (`bot.json`, `commands/`); mobile import uses that repository’s default branch and replaces the destination commands/libraries. The full-stack root is not a BB import package.

## /start

```javascript
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
```

## /vault

```javascript
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
```

## /vault-response

```javascript
/*CMD
  command: /vault-response
  need_reply: false
CMD*/
// HTTP transport does not verify TLS certificates. Never act on its response body,
// never store response values, and never render secret or menu data from it.
// The backend sends authenticated Telegram API menus directly.
```

## /vault-error

```javascript
/*CMD
  command: /vault-error
  need_reply: false
CMD*/
// No automatic retry: a timeout can follow a completed side effect.
Bot.sendMessage(
  "The vault request could not be confirmed. Open Vault to check status, or send /start. Do not send passwords in chat.",
);
```
