import type { IZulipInterface, MessagePayload, ZulipConfig } from '../interfaces/zulip.interface.js';
import { createLogger } from '../util.js';

const logger = createLogger('ZulipRepository');

export class ZulipRepository implements IZulipInterface {
  private realm = '';
  private botAuth = '';
  private userAuth = '';
  private userApiUrl = '';

  init({ realm, bot, user }: ZulipConfig) {
    this.realm = realm;
    this.botAuth = `Basic ${btoa(`${bot.username}:${bot.apiKey}`)}`;
    this.userAuth = `Basic ${btoa(`${user.username}:${user.apiKey}`)}`;
    this.userApiUrl = `${realm}/api/v1`;
  }

  async sendMessage({ stream, content, topic }: MessagePayload) {
    const params = new URLSearchParams({
      type: 'stream',
      to: String(stream),
      content,
    });
    if (topic) {
      params.set('topic', topic);
    }

    const response = await fetch(`${this.realm}/api/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: this.botAuth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await response.json();
    logger.debug('sendMessage response:', data);
  }

  async createEmote(name: string, emoteUrl: string) {
    const emote = await fetch(emoteUrl).then((response) => response.blob());

    const form = new FormData();
    form.append('filename', emote);

    await fetch(`${this.userApiUrl}/realm/emoji/${name.toLowerCase()}`, {
      method: 'POST',
      headers: { Authorization: this.userAuth },
      body: form,
    });
  }
}
