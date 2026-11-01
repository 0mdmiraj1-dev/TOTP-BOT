// Read-only operator diagnostics. No webhook changes; never prints the token.
const token = process.env.BOT_TOKEN,
  channel = process.env.CHANNEL_ID;
if (!token || !channel)
  throw Error(
    "Load BOT_TOKEN and CHANNEL_ID privately, e.g. node --env-file=.env --import tsx scripts/telegram-check.ts",
  );
async function call(method: string, body: unknown = {}) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const p = (await r.json()) as any;
  if (!r.ok || !p.ok)
    throw Error(
      "Telegram check failed; check token/channel/permissions privately",
    );
  return p.result;
}
try {
  const me = await call("getMe");
  const chat = await call("getChat", { chat_id: channel });
  const member = await call("getChatMember", {
    chat_id: channel,
    user_id: me.id,
  });
  const permissions = {
    administrator:
      member.status === "administrator" || member.status === "creator",
    canPost: !!member.can_post_messages || member.status === "creator",
    canEdit: !!member.can_edit_messages || member.status === "creator",
  };
  console.log(
    JSON.stringify(
      {
        botUsername: me.username,
        channelId: String(chat.id),
        channelType: chat.type,
        ...permissions,
      },
      null,
      2,
    ),
  );
  if (
    chat.type !== "channel" ||
    !permissions.administrator ||
    !permissions.canPost ||
    !permissions.canEdit
  )
    process.exitCode = 1;
} catch {
  console.error(
    "Telegram check failed. No secrets or raw API responses were printed.",
  );
  process.exitCode = 1;
}
