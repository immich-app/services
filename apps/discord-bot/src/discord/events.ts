import { MessageFlags, ThreadChannel } from 'discord.js';
import { type ArgsOf, Discord, On, Once, type RestArgsOf } from 'discordx';
import _ from 'lodash';
import { Constants } from '../constants.js';
import type { DiscordService } from '../services/discord.service.js';
import { createLogger } from '../util.js';

const logger = createLogger('DiscordEvents');

const shortenMessage = (message: string | null) => {
  if (!message) {
    return message;
  }

  return message.length > 50 ? `${message.slice(0, 40)}...` : message;
};

// Service reference set by the DO during initialization
let discordService: DiscordService;

export const setEventServices = (services: { discord: DiscordService }) => {
  discordService = services.discord;
};

@Discord()
export class DiscordEvents {
  @On.rest({ event: 'restDebug' })
  onDebug([message]: RestArgsOf<'restDebug'>) {
    logger.debug(message);
  }

  @Once({ event: 'ready' })
  async onReady() {
    await discordService.onReady();
  }

  @On({ event: 'error' })
  async onError([error]: ArgsOf<'error'>) {
    await discordService.onError(error);
  }

  @On({ event: 'messageCreate' })
  async onMessageCreate([message]: ArgsOf<'messageCreate'>) {
    if (message.author.bot) {
      return;
    }

    const [messageParts, twitterLinks] = await Promise.all([
      discordService.handleGithubReferences(message.content),
      Promise.resolve(discordService.handleTwitterReferences(message.content)),
    ]);

    if (messageParts.length > 0) {
      await message.reply({
        content: messageParts.join('\n'),
        flags: [MessageFlags.SuppressEmbeds, MessageFlags.SuppressNotifications],
      });
    }

    if (twitterLinks.length > 0) {
      await message.reply({
        content: twitterLinks.join('\n'),
        flags: [MessageFlags.SuppressEmbeds, MessageFlags.SuppressNotifications],
      });
    }
  }

  @On({ event: 'messageUpdate' })
  async onMessageUpdate([oldMessage, newMessage]: ArgsOf<'messageUpdate'>) {
    logger.verbose(
      `DiscordBot.onMessageUpdate [${oldMessage.author?.username || 'Unknown'}] => ${shortenMessage(newMessage.content)}`,
    );
    if (oldMessage.author?.bot) {
      return;
    }

    if (_.isEqual(oldMessage.embeds, newMessage.embeds)) {
      logger.verbose('Skipping, no embeds');
    } else {
      logger.verbose('Removing embeds', oldMessage.embeds, newMessage.embeds);
      const urls = newMessage.embeds.map((embed) => embed.url).filter((url): url is string => !!url);
      if (discordService.hasBlacklistUrl(urls)) {
        await newMessage.suppressEmbeds(true);
      }
    }
  }

  @On({ event: 'messageDelete' })
  onMessageDelete([message]: ArgsOf<'messageDelete'>) {
    logger.verbose(
      `DiscordBot.onMessageDelete [${message.author?.username || 'Unknown'}] => ${shortenMessage(message.content)}`,
    );
  }

  @On({ event: 'threadCreate' })
  async onThreadCreate([thread]: ArgsOf<'threadCreate'>) {
    if (!thread.isTextBased()) {
      return;
    }

    const starterMessage = await thread.fetchStarterMessage();
    const link = await discordService.createOutlineDoc({
      threadParentId: thread.parentId ?? undefined,
      threadTags: thread.appliedTags,
      title: thread.name,
      text: starterMessage?.content,
    });

    if (link) {
      await this.sendAndPinOutlineLink(thread, link);
    }
  }

  @On({ event: 'threadUpdate' })
  async onThreadUpdate([oldThread, newThread]: ArgsOf<'threadUpdate'>) {
    const tagDiff = _.difference(newThread.appliedTags, oldThread.appliedTags);

    if (tagDiff.length === 0) {
      return;
    }

    const starterMessage = await newThread.fetchStarterMessage();
    const link = await discordService.createOutlineDoc({
      threadParentId: newThread.parentId ?? undefined,
      threadTags: tagDiff,
      title: newThread.name,
      text: starterMessage?.content,
    });

    if (link) {
      await this.sendAndPinOutlineLink(newThread, link);
    }
  }

  private async sendAndPinOutlineLink(thread: ThreadChannel, link: string) {
    const role =
      thread.parentId === Constants.Discord.Channels.YuccaFocusTopic
        ? Constants.Discord.Roles.Yucca
        : Constants.Discord.Roles.Team;

    const message = await thread.send({
      content: `<@&${role}> ${link}`,
      flags: [MessageFlags.SuppressEmbeds],
    });
    await message.pin();
  }
}
