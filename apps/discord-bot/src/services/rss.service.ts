import { EmbedBuilder } from 'discord.js';
import type { IDatabaseRepository } from '../interfaces/database.interface.js';
import type { IDiscordInterface } from '../interfaces/discord.interface.js';
import type { FeedItem, IRSSInterface, PostItem } from '../interfaces/rss.interface.js';
import { shorten } from '../util.js';

export class RSSService {
  constructor(
    private database: IDatabaseRepository,
    private discord: IDiscordInterface,
    private rss: IRSSInterface,
  ) {}

  async createRSSFeed(url: string, channelId: string) {
    this.database.createRSSFeed({ url, channelId });
    await this.initFeed(url, channelId);
  }

  removeRSSFeed(url: string, channelId: string) {
    this.database.removeRSSFeed(url, channelId);
  }

  searchRSSFeeds(url: string, channelId: string) {
    let feeds = this.database.getRSSFeeds(channelId);
    if (url) {
      const query = url.toLowerCase();
      feeds = feeds.filter(({ url }) => url.toLowerCase().includes(query));
    }

    return feeds.map(({ url }) => ({
      name: shorten(url, 40),
      value: url,
    }));
  }

  async initFeed(url: string, channelId: string) {
    const { feed: fetchedFeed, posts } = await this.rss.getFeed(url, null);
    const post = posts.at(0);

    if (!post) {
      throw new Error(`Could not fetch posts from ${url}`);
    }

    await this.processPosts(fetchedFeed, [post], url, channelId);
    this.database.updateRSSFeed({
      url,
      channelId,
      lastId: post.id,
      profileImageUrl: fetchedFeed.profileImageUrl,
      title: fetchedFeed.title,
    });
  }

  async onFeedUpdates() {
    const feeds = this.database.getRSSFeeds();

    for (const feed of feeds) {
      await this.updateFeed(feed);
    }
  }

  private async updateFeed(feed: { url: string; lastId: string | null; channelId: string }) {
    const { feed: fetchedFeed, posts } = await this.rss.getFeed(feed.url, feed.lastId);
    const newLastId = posts.at(0)?.id;

    await this.processPosts(fetchedFeed, posts, feed.url, feed.channelId);

    this.database.updateRSSFeed({
      url: feed.url,
      channelId: feed.channelId,
      lastId: newLastId,
      profileImageUrl: fetchedFeed.profileImageUrl,
      title: fetchedFeed.title,
    });
  }

  private async processPosts(feed: FeedItem, posts: PostItem[], url: string, channelId: string) {
    for (const post of posts.toReversed()) {
      await this.discord.sendMessage({
        channelId,
        message: {
          embeds: [
            new EmbedBuilder()
              .setAuthor(feed.title ? { name: feed.title, iconURL: feed.profileImageUrl, url } : null)
              .setTitle(post.title ?? null)
              .setDescription(post.summary ?? null)
              .setTimestamp(post.pubDate ? new Date(post.pubDate) : null)
              .setURL(post.link ?? null),
          ],
        },
      });
    }
  }
}
