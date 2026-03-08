export { DiscordBotDO } from './durable-objects/discord-bot.js';

const DO_ID = 'discord-bot-singleton';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.DISCORD_BOT.idFromName(DO_ID);
    const stub = env.DISCORD_BOT.get(id);
    return stub.fetch(request);
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const id = env.DISCORD_BOT.idFromName(DO_ID);
    const stub = env.DISCORD_BOT.get(id);
    await stub.fetch(new Request(`https://internal/cron?cron=${encodeURIComponent(event.cron)}`));
  },
};
