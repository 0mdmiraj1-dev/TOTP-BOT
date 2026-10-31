/*CMD
  command: /vault-error
  need_reply: false
CMD*/
// No automatic retry: a timeout can follow a completed side effect.
Bot.sendMessage(
  "The vault request could not be confirmed. Open Vault to check status, or send /start. Do not send passwords in chat.",
);
