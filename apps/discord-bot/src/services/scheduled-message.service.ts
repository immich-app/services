import { inlineCode } from 'discord.js';
import type { IDatabaseRepository, NewScheduledMessage } from '../interfaces/database.interface.js';
import type { IDiscordInterface } from '../interfaces/discord.interface.js';
import { createLogger, shorten } from '../util.js';

const logger = createLogger('ScheduledMessageService');

export class ScheduledMessageService {
  constructor(
    private database: IDatabaseRepository,
    private discord: IDiscordInterface,
  ) {}

  init() {
    logger.log('ScheduledMessageService initialized');
  }

  async executeScheduledMessages() {
    const messages = this.database.getScheduledMessages();
    const now = new Date();

    for (const message of messages) {
      if (this.shouldExecute(message.cronExpression, now)) {
        try {
          await this.discord.sendMessage({ channelId: message.channelId, message: { content: message.message } });
        } catch (error) {
          logger.error(`Failed to send scheduled message ${message.id}: ${error}`);
        }
      }
    }
  }

  createScheduledMessage(entity: NewScheduledMessage) {
    // Basic cron validation
    const parts = entity.cronExpression.trim().split(/\s+/);
    if (parts.length < 5 || parts.length > 6) {
      throw new Error(`Invalid cron expression ${entity.cronExpression}: expected 5-6 parts`);
    }

    return this.database.createScheduledMessage(entity);
  }

  removeScheduledMessage(name: string) {
    const message = this.database.getScheduledMessage(name);
    if (!message) {
      return 'Scheduled message not found';
    }

    this.database.removeScheduledMessage(message.id);
    return `Removed scheduled message ${inlineCode(message.name)}`;
  }

  getScheduledMessages(value?: string) {
    let messages = this.database.getScheduledMessages();
    if (value) {
      const query = value.toLowerCase();
      messages = messages.filter(({ name }) => name.toLowerCase().includes(query));
    }

    return messages
      .map(({ name, cronExpression, message }) => ({
        name: shorten(`${name} — ${cronExpression} — ${message}`, 100),
        value: name,
      }))
      .slice(0, 25);
  }

  listScheduledMessages() {
    return this.database.getScheduledMessages();
  }

  private shouldExecute(cronExpression: string, now: Date): boolean {
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length < 5) {
      return false;
    }

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    return (
      this.matchField(minute!, now.getUTCMinutes()) &&
      this.matchField(hour!, now.getUTCHours()) &&
      this.matchField(dayOfMonth!, now.getUTCDate()) &&
      this.matchField(month!, now.getUTCMonth() + 1) &&
      this.matchField(dayOfWeek!, now.getUTCDay())
    );
  }

  private matchField(field: string, value: number): boolean {
    if (field === '*') {
      return true;
    }

    // Handle */n syntax
    if (field.startsWith('*/')) {
      const step = Number.parseInt(field.slice(2), 10);
      return value % step === 0;
    }

    // Handle comma-separated values
    const values = field.split(',');
    return values.some((v) => Number.parseInt(v, 10) === value);
  }
}
