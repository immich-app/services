import { IntentsBitField, MessageCreateOptions, MessageFlags, Partials } from 'discord.js';
import { Client } from 'discordx';
import type { DiscordChannel, IDiscordInterface } from '../interfaces/discord.interface.js';
import { createLogger } from '../util.js';

const logger = createLogger('DiscordBot');

const DiscordLogger = {
  info: (...messages: string[]) => logger.debug(messages.join('\n')),
  log: (...messages: string[]) => logger.log(messages.join('\n')),
  warn: (...messages: string[]) => logger.warn(messages.join('\n')),
  error: (...messages: string[]) => logger.error(messages.join('\n')),
};

const bot = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.MessageContent,
    IntentsBitField.Flags.GuildMessageReactions,
  ],
  silent: false,
  logger: DiscordLogger,
  simpleCommand: {
    prefix: '/',
  },
  partials: [Partials.Message, Partials.Reaction],
});

export class DiscordRepository implements IDiscordInterface {
  constructor() {
    bot
      .once('ready', () => {
        void bot.initApplicationCommands();
      })
      .on('interactionCreate', (interaction) => void bot.executeInteraction(interaction))
      .on('messageCreate', (message) => void bot.executeCommand(message));
  }

  async login(token: string) {
    await bot.login(token);
  }

  async sendMessage({
    channelId,
    threadId,
    message,
    crosspost = false,
    pin = false,
  }: {
    channelId: DiscordChannel | string;
    threadId?: string;
    message: string | MessageCreateOptions;
    crosspost?: boolean;
    pin?: boolean;
  }): Promise<void> {
    let channel = await bot.channels.fetch(channelId);

    if (threadId && channel?.isThreadOnly()) {
      channel = await channel.threads.fetch(threadId);
    }

    if (channel?.isSendable()) {
      const sentMessage = await channel.send(typeof message === 'string' ? { content: message } : message);

      if (crosspost) {
        await sentMessage.crosspost();
      }

      if (pin) {
        await sentMessage.pin();
      }
    }
  }

  async createEmote(name: string, emote: string | Buffer, guildId: string) {
    return bot.guilds.cache.get(guildId)?.emojis.create({ name, attachment: emote });
  }

  async getEmotes(guildId: string) {
    const emotes = await bot.guilds.cache.get(guildId)?.emojis.fetch();
    const result = [];

    for (const emote of emotes?.values() ?? []) {
      result.push({
        identifier: emote.identifier,
        name: emote.name,
        url: emote.imageURL(),
        animated: emote.animated ?? false,
      });
    }
    return result;
  }

  async createThread(
    channelId: string,
    { name, message, appliedTags }: { name: string; message: string; appliedTags?: string[] },
  ) {
    const channel = await bot.channels.fetch(channelId);
    if (!channel?.isThreadOnly()) {
      return {};
    }

    const { id } = await channel.threads.create({
      name,
      message: { content: message, flags: [MessageFlags.SuppressEmbeds] },
      appliedTags,
    });
    return { threadId: id };
  }

  async updateThread(
    { channelId, threadId }: { channelId: string; threadId: string },
    { name, message, appliedTags }: { name: string; message: string; appliedTags?: string[] },
  ) {
    const channel = await bot.channels.fetch(channelId);
    if (!channel?.isThreadOnly()) {
      return;
    }

    const thread = await channel.threads.fetch(threadId);
    if (!thread) {
      return;
    }

    const initialMessage = await thread.fetchStarterMessage();

    await thread.setName(name);
    await thread.setAppliedTags(appliedTags ?? []);
    await initialMessage?.edit(message);
  }

  async setThreadArchived({ channelId, threadId }: { channelId: string; threadId: string }, archived: boolean) {
    const channel = await bot.channels.fetch(channelId);
    if (!channel?.isThreadOnly()) {
      return;
    }

    const thread = await channel.threads.fetch(threadId);
    await thread?.setArchived(archived);
  }
}
