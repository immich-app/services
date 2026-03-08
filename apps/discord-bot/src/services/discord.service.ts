import { ChannelType, CommandInteraction, GuildMember, TextChannel } from 'discord.js';
import { DateTime } from 'luxon';
import type { AppConfig } from '../config.js';
import { Constants, GithubOrg, GithubRepo } from '../constants.js';
import type { IDatabaseRepository } from '../interfaces/database.interface.js';
import { DiscordChannel, type IDiscordInterface } from '../interfaces/discord.interface.js';
import type { IFourthwallRepository } from '../interfaces/fourthwall.interface.js';
import type { IGithubInterface } from '../interfaces/github.interface.js';
import type { IOutlineInterface } from '../interfaces/outline.interface.js';
import type { IZulipInterface } from '../interfaces/zulip.interface.js';
import { createLogger, formatCommand, shorten } from '../util.js';

const PREVIEW_BLACKLIST = [Constants.Urls.GitHub, Constants.Urls.MyImmich, Constants.Urls.ImmichDocs];
const LINK_NOT_FOUND = { message: 'Link not found', isPrivate: true };

const _star_history: Record<string, number | undefined> = {};
const _fork_history: Record<string, number | undefined> = {};

type GithubLink = {
  org: GithubOrg | string;
  repo: GithubRepo | string;
  id: number;
  type?: LinkType;
};
type LinkType = 'issues' | 'pull' | 'discussions';

type GithubCodeSnippet = {
  lines: string[];
  extension: string;
};

type SevenTVResponse = {
  id: string;
  name: string;
  host: {
    url: string;
    files: {
      name: string;
      static_name: string;
      width: number;
      height: number;
      frame_count: number;
      size: number;
      format: string;
    }[];
  };
};

type BetterTTVResponse = {
  id: string;
  code: string;
  imageType: string;
  animated: string;
};

const GITHUB_PAGE_REGEX =
  /https:\/\/github\.com\/(?<orgPage>[\w\-.,_]*)\/(?<repoPage>[\w\-.,_]+)\/(?<category>(pull|issues|discussions))\/(?<numPage>\d+)/g;
const GITHUB_QUICK_REF_REGEX = /(((?<org>[\w\-.,_]*)\/)?(?<repo>[\w\-.,_]+))?#(?<num>\d+)/g;
const GITHUB_THREAD_REGEX = new RegExp(`(${GITHUB_PAGE_REGEX.source})|(${GITHUB_QUICK_REF_REGEX.source})`, 'g');
const GITHUB_FILE_REGEX =
  /https:\/\/github.com\/(?<org>[\w\-.,]+)\/(?<repo>[\w\-.,]+)\/blob\/(?<ref>[\w\-.,]+)\/(?<path>[\w\-.,/%\d]+)(#L(?<lineFrom>\d+)(-L(?<lineTo>\d+))?)?/g;

const logger = createLogger('DiscordService');

export class DiscordService {
  constructor(
    private database: IDatabaseRepository,
    private discord: IDiscordInterface,
    private fourthwall: IFourthwallRepository,
    private github: IGithubInterface,
    private outline: IOutlineInterface,
    private zulip: IZulipInterface,
    private config: AppConfig,
  ) {}

  async init() {
    if (this.config.botToken !== 'dev') {
      await this.discord.login(this.config.botToken);
    }

    if (this.config.github.appId !== 'dev') {
      await this.github.init(
        this.config.github.appId,
        this.config.github.privateKey,
        this.config.github.installationId,
      );
    }

    if (this.config.zulip.bot.apiKey !== 'dev' && this.config.zulip.user.apiKey !== 'dev') {
      this.zulip.init(this.config.zulip);
    }
  }

  async onBirthday() {
    await this.discord.sendMessage({
      channelId: DiscordChannel.General,
      message: `"Happy birthday my other child" - Alex`,
    });
  }

  async onReady() {
    logger.verbose('DiscordBot.onReady');
    logger.log('Bot started');

    await this.discord.sendMessage({
      channelId: DiscordChannel.BotSpam,
      message: `I'm alive!`,
    });
  }

  async onError(error: Error) {
    if (error.name === 'DiscordAPIError[10008]') {
      return;
    }

    logger.verbose(`DiscordBot.onError - ${error}`);
    logger.error('Discord bot error', error);
    try {
      await this.discord.sendMessage({ channelId: DiscordChannel.BotSpam, message: `Discord bot error: ${error}` });
    } catch (sendError) {
      logger.error('Failed to send error message', sendError);
    }
  }

  getLink(name: string, message: string | null) {
    const item = this.database.getDiscordLink(name);
    if (!item) {
      return LINK_NOT_FOUND;
    }

    this.database.updateDiscordLink({ id: item.id, usageCount: item.usageCount + 1 });

    return {
      message: (message ? `${message} - ` : '') + item.link,
      isPrivate: false,
    };
  }

  getLinks(value?: string) {
    let links = this.database.getDiscordLinks();
    if (value) {
      const query = value.toLowerCase();
      links = links.filter(
        ({ name, link }) => name.toLowerCase().includes(query) || link.toLowerCase().includes(query),
      );
    }

    return links
      .map(({ name, link }) => ({
        name: shorten(`${name} — ${link}`),
        value: name,
      }))
      .slice(0, 25);
  }

  addLink({ name, link, author }: { name: string; link: string; author: string }) {
    this.database.addDiscordLink({ name, link, author });
    return `Successfully added ${link}: ${formatCommand('link', name, '[message]')}`;
  }

  removeLink({ name }: { name: string }) {
    const link = this.database.getDiscordLink(name);
    if (!link) {
      return LINK_NOT_FOUND;
    }

    this.database.removeDiscordLink(link.id);

    return { message: `Removed ${link.name} - ${link.link}`, isPrivate: false };
  }

  getAge() {
    const age = DateTime.now()
      .diff(DateTime.fromObject({ year: 2022, month: 2, day: 3, hour: 15, minute: 56 }, { zone: 'UTC' }), [
        'years',
        'months',
        'days',
        'hours',
        'minutes',
        'seconds',
      ])
      .toHuman({ listStyle: 'long', maximumFractionDigits: 0 });

    return `Immich is ${age} old. ${Constants.Icons.Immich}`;
  }

  getReleaseNotes() {
    return `Please make sure you have read and followed the release notes: ${Constants.Urls.Release}`;
  }

  async getStarsMessage(channelId: string) {
    const lastStarsCount = _star_history[channelId];

    try {
      const starsCount = await this.github.getStarCount(GithubOrg.ImmichApp, GithubRepo.Immich);
      const delta = lastStarsCount && starsCount - lastStarsCount;
      const formattedDelta = delta && Intl.NumberFormat(undefined, { signDisplay: 'always' }).format(delta);

      _star_history[channelId] = starsCount;
      return `Stars ⭐: ${starsCount}${
        formattedDelta ? ` (${formattedDelta} stars since the last call in this channel)` : ''
      }`;
    } catch {
      return 'Could not fetch stars count from the GitHub API';
    }
  }

  async getForksMessage(channelId: string) {
    const lastForksCount = _fork_history[channelId];

    try {
      const forksCount = await this.github.getForkCount(GithubOrg.ImmichApp, GithubRepo.Immich);
      const delta = lastForksCount && forksCount - lastForksCount;
      const formattedDelta = delta && Intl.NumberFormat(undefined, { signDisplay: 'always' }).format(delta);

      _fork_history[channelId] = forksCount;

      return `Forks: ${forksCount}${formattedDelta ? ` (${formattedDelta} forks since the last call in this channel)` : ''}`;
    } catch {
      return 'Could not fetch forks count from the GitHub API';
    }
  }

  async handleSearchAutocompletion(value: string) {
    if (!value) {
      return [];
    }

    try {
      const result = await this.github.search({
        query: `repo:immich-app/immich in:title ${value}`,
        per_page: 5,
        page: 1,
        sort: 'updated',
        order: 'desc',
      });

      return result.items.map((item) => ({
        name: shorten(`${item.pull_request ? '[PR]' : '[Issue]'} (${item.number}) ${item.title}`),
        value: String(item.number),
      }));
    } catch {
      logger.log('Could not fetch search results from GitHub');
      return [];
    }
  }

  handleTwitterReferences(content: string) {
    const links: string[] = [];
    content = content.replaceAll(/```.*```/gs, '');

    const matches = content.matchAll(/https:\/\/x\.com\/(?<path>[^ ]+)/g);

    for (const match of matches) {
      if (!match?.groups) {
        continue;
      }

      const { path } = match.groups;
      links.push(`https://nitter.net/${path}`);
    }

    return links;
  }

  async handleGithubReferences(content: string) {
    const codeSnippets = await this.handleGithubFileReferences(content);
    const links = await this.handleGithubThreadReferences(content);

    return [...codeSnippets, ...links].filter((e) => e !== undefined);
  }

  async handleGithubThreadReferences(content: string) {
    const links: GithubLink[] = [];

    content = content.replaceAll(/```.*```/gs, '');

    const matches = content.matchAll(GITHUB_THREAD_REGEX);

    for (const match of matches) {
      if (!match?.groups) {
        continue;
      }

      const { org, orgPage, repo, repoPage, category, num, numPage } = match.groups;
      const id = Number(num ?? numPage);
      if (Number.isNaN(id)) {
        continue;
      }

      if (!org && !orgPage && !repo && !repoPage && id < 1000) {
        continue;
      }

      links.push({
        id,
        org: org || orgPage || GithubOrg.ImmichApp,
        repo: repo || repoPage || GithubRepo.Immich,
        type: category as LinkType,
      });
    }

    const keys = new Set<string>();
    const requests: GithubLink[] = [];

    for (const { id, org, repo, type } of links) {
      const key = id + org + repo;
      if (keys.has(key)) {
        continue;
      }

      requests.push({ id, org, repo, type });
      keys.add(key);
    }

    const results = await Promise.all(
      requests.map(async ({ org, repo, id, type }) => {
        switch (type) {
          case 'issues':
          case 'pull': {
            return this.github.getIssueOrPr(org, repo, id);
          }

          case 'discussions': {
            return this.github.getDiscussion(org, repo, id);
          }

          default: {
            return (await this.github.getIssueOrPr(org, repo, id)) || (await this.github.getDiscussion(org, repo, id));
          }
        }
      }),
    );

    return results;
  }

  async handleGithubFileReferences(content: string) {
    const snippets: GithubCodeSnippet[] = [];

    const matches = content.matchAll(GITHUB_FILE_REGEX);

    for (const match of matches) {
      if (!match?.groups) {
        continue;
      }

      const { org, repo, ref, path, lineFrom, lineTo } = match.groups;

      const extension = path.split('/').pop()?.split('.').pop();
      if (!extension) {
        continue;
      }

      const file = await this.github.getRepositoryFileContent(org, repo, ref, decodeURIComponent(path));
      if (!file || file.length === 0) {
        continue;
      }

      const from = lineFrom ? Number(lineFrom) - 1 : 0;
      let to;
      if (lineTo) {
        to = Number(lineTo);
      } else if (lineFrom) {
        to = from + 1;
      } else {
        to = file.length;
      }

      if (to - from > 20) {
        continue;
      }

      const lines = file.slice(from, to);

      if (lines.length === 0) {
        continue;
      }

      snippets.push({ lines, extension });
    }

    return snippets.map(({ lines, extension }) => {
      const code = lines.join('\n');
      const formattedCode = code.replaceAll('`', '\\`');
      return `\`\`\`${extension === 'svelte' ? 'tsx' : extension}
${formattedCode}
\`\`\``;
    });
  }

  hasBlacklistUrl(urls: string[]) {
    for (const url of urls) {
      if (PREVIEW_BLACKLIST.some((blacklist) => url.startsWith(blacklist))) {
        return true;
      }
    }

    return false;
  }

  getPrOrIssue(id: number) {
    return this.github.getIssueOrPr(GithubOrg.ImmichApp, GithubRepo.Immich, id);
  }

  getMessages(value?: string) {
    let messages = this.database.getDiscordMessages();
    if (value) {
      const query = value.toLowerCase();
      messages = messages.filter(({ name }) => name.toLowerCase().includes(query));
    }

    return messages
      .map(({ name, content }) => ({
        name: shorten(`${name} — ${content}`, 40),
        value: name,
      }))
      .slice(0, 25);
  }

  getMessage(name: string, increaseUsageCount: boolean = true) {
    const item = this.database.getDiscordMessage(name);
    if (!item) {
      return;
    }

    if (increaseUsageCount) {
      this.database.updateDiscordLink({ id: item.id, usageCount: item.usageCount + 1 });
    }

    return item;
  }

  removeMessage(name: string) {
    const message = this.database.getDiscordMessage(name);
    if (!message) {
      return LINK_NOT_FOUND;
    }

    this.database.removeDiscordMessage(message.id);

    return { message: shorten(`Successfully deleted ${message.name} - ${message.content}`), isPrivate: false };
  }

  addOrUpdateMessage({ name, content, author }: { name: string; content: string; author: string }) {
    const message = this.database.getDiscordMessage(name);
    if (message) {
      this.database.updateDiscordMessage({ id: message.id, name, content, lastEditedBy: author });
      return `Successfully updated ${name}: ${formatCommand('messages', name)}`;
    }
    this.database.addDiscordMessage({ name, content, lastEditedBy: author });
    return `Successfully added ${name}: ${formatCommand('messages', name)}`;
  }

  async createEmote(name: string, emote: string, guildId: string | null) {
    if (!guildId) {
      return;
    }

    try {
      await this.zulip.createEmote(name, emote);
    } catch {
      logger.error(`Could not create emote ${name} - ${emote} on Zulip`);
    }
    return this.discord.createEmote(name, emote, guildId);
  }

  async create7TvEmote(id: string, guildId: string | null, name: string | null) {
    if (!guildId) {
      return;
    }

    const rawResponse = await fetch(`https://7tv.io/v3/emotes/${id}`);
    if (rawResponse.status !== 200) {
      return;
    }

    const response = (await rawResponse.json()) as SevenTVResponse;
    const gif = response.host.files.findLast((file) => file.format === 'GIF' && file.size < 256_000);
    const file = gif || response.host.files.findLast((file) => file.format === 'WEBP' && file.size < 256_000)!;

    return this.createEmote(name || response.name, `https:${response.host.url}/${file.name}`, guildId);
  }

  async createBttvEmote(id: string, guildId: string | null, name: string | null) {
    if (!guildId) {
      return;
    }

    const rawResponse = await fetch(`https://api.betterttv.net/3/emotes/${id}`);
    if (rawResponse.status !== 200) {
      return;
    }

    const response = (await rawResponse.json()) as BetterTTVResponse;

    return this.createEmote(name || response.code, `https://cdn.betterttv.net/emote/${id}/3x`, guildId);
  }

  async createEmoteFromExistingOne(emote: string, guildId: string | null, name: string | null) {
    if (!guildId) {
      return;
    }

    const groups = emote.match(/<:(?<name>\w+):(?<id>\d+)>/)?.groups;

    if (!groups?.id || !groups?.name) {
      return;
    }

    return this.createEmote(name || groups.name, `https://cdn.discordapp.com/emojis/${groups.id}.png`, guildId);
  }

  async createOutlineDoc({
    threadParentId,
    threadTags,
    title,
    text,
  }: {
    threadParentId?: string;
    threadTags: string[];
    title: string;
    text?: string;
  }) {
    const { Urls, Discord, Outline } = Constants;
    const apiKey = this.config.outline.apiKey;

    switch (threadParentId) {
      case Discord.Channels.DevFocusTopic: {
        if (!threadTags.includes(Discord.Tags.DevOutline)) {
          return;
        }

        const { url } = await this.outline.createDocument({
          title,
          text,
          collectionId: Outline.Collections.Dev,
          parentDocumentId: Outline.Documents.DevFocusTopic,
          apiKey,
          icon: 'hammer',
          iconColor: '#0366D6',
        });
        return Urls.Outline + url;
      }
      case Discord.Channels.TeamFocusTopic: {
        if (!threadTags.includes(Discord.Tags.TeamOutline)) {
          return;
        }

        const { url } = await this.outline.createDocument({
          title,
          text,
          collectionId: Outline.Collections.Team,
          parentDocumentId: Outline.Documents.TeamFocusTopic,
          apiKey,
          icon: 'hammer',
          iconColor: '#FF5C80',
        });
        return Urls.Outline + url;
      }
      case Discord.Channels.YuccaFocusTopic: {
        if (!threadTags.includes(Discord.Tags.YuccaOutline)) {
          return;
        }

        const { url } = await this.outline.createDocument({
          title,
          text,
          collectionId: Outline.Collections.Yucca,
          parentDocumentId: Outline.Documents.YuccaFocusTopic,
          apiKey,
          icon: 'hammer',
          iconColor: '#FF825C',
        });
        return Urls.Outline + url;
      }
    }
  }

  async updateFourthwallOrders(id?: string | null) {
    const { user, password } = this.config.fourthwall;

    if (id) {
      await this.updateOrder({ id, user, password });
      return;
    }

    for (const { id } of this.database.getFourthwallOrderIds()) {
      await this.updateOrder({ id, user, password });
    }
  }

  async syncEmotes(interaction: CommandInteraction) {
    if (!interaction.guildId) {
      return;
    }

    const deferredInteraction = await interaction.deferReply();

    for (const emote of await this.discord.getEmotes(interaction.guildId)) {
      const url = emote.animated ? emote.url.replace(/\.(?<extension>[a-zA-Z]+?)$/, '.gif') : emote.url;
      await this.zulip.createEmote(emote.name ?? emote.identifier, url);
    }

    await deferredInteraction.edit('Done syncing');
  }

  async pruneMessagesInChannel(channel: TextChannel, userId: string, deleteAfter: DateTime) {
    const messages = await channel.messages.fetch();

    for (const [, message] of messages.filter(({ author }) => author.id === userId)) {
      if (deleteAfter < DateTime.fromJSDate(message.createdAt)) {
        await message.delete();
      }
    }
  }

  async pruneMessages(interaction: CommandInteraction, member: GuildMember, minutes: number) {
    const deleteAfter = DateTime.now().minus({ minutes });
    const channels = interaction
      .guild!.channels.cache.filter((channel) => channel.type === ChannelType.GuildText)
      .filter((channel) => channel.permissionsFor(member).has('SendMessages'));

    const promises: Promise<void>[] = [];
    for (const [, channel] of channels) {
      promises.push(this.pruneMessagesInChannel(channel as TextChannel, member.id, deleteAfter));
    }

    await Promise.all(promises);
  }

  private async updateOrder({ id, user, password }: { id: string; user: string; password: string }) {
    const order = await this.fourthwall.getOrder({ id, user, password });

    this.database.updateFourthwallOrder({
      id,
      discount: order.discount ?? undefined,
      status: order.status,
      total: order.totalPrice.value,
      profit: order.profit.value,
      shipping: order.currentAmounts.shipping.value,
      tax: order.currentAmounts.tax.value,
    });
  }
}
