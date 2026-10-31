/*CMD
  command: /vault-response
  need_reply: false
CMD*/
// HTTP transport does not verify TLS certificates. Never act on its response body,
// never store response values, and never render secret or menu data from it.
// The backend sends authenticated Telegram API menus directly.
