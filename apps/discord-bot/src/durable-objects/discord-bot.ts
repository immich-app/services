import { DurableObject } from 'cloudflare:workers';
import { getConfig, type AppConfig } from '../config.js';
import { setCommandServices } from '../discord/commands.js';
import { setEventServices } from '../discord/events.js';
import { DatabaseRepository } from '../repositories/database.repository.js';
import { DiscordRepository } from '../repositories/discord.repository.js';
import { FourthwallRepository } from '../repositories/fourthwall.repository.js';
import { GithubRepository } from '../repositories/github.repository.js';
import { HolidaysRepository } from '../repositories/holidays.repository.js';
import { OutlineRepository } from '../repositories/outline.repository.js';
import { RSSRepository } from '../repositories/rss.repository.js';
import { ZulipRepository } from '../repositories/zulip.repository.js';
import { DiscordService } from '../services/discord.service.js';
import { GithubService } from '../services/github.service.js';
import { RSSService } from '../services/rss.service.js';
import { ScheduleService } from '../services/schedule.service.js';
import { ScheduledMessageService } from '../services/scheduled-message.service.js';
import { WebhookService } from '../services/webhook.service.js';
import { ZulipService } from '../services/zulip.service.js';
import { createLogger } from '../util.js';

// Import discordx classes so decorators are registered
import '../discord/commands.js';
import '../discord/context-menus.js';
import '../discord/events.js';
import '../discord/help-desk.js';

const logger = createLogger('DiscordBotDO');

export class DiscordBotDO extends DurableObject<Env> {
  private config: AppConfig;
  private discordService!: DiscordService;
  private webhookService!: WebhookService;
  private scheduleService!: ScheduleService;
  private rssService!: RSSService;
  private scheduledMessageService!: ScheduledMessageService;
  private zulipService!: ZulipService;
  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = getConfig(env);

    // Run migrations synchronously in constructor
    const database = new DatabaseRepository(ctx.storage.sql);
    database.runMigrations();

    // Create repositories
    const discordRepo = new DiscordRepository();
    const githubRepo = new GithubRepository();
    const outlineRepo = new OutlineRepository();
    const fourthwallRepo = new FourthwallRepository();
    const rssRepo = new RSSRepository();
    const zulipRepo = new ZulipRepository();
    const holidaysRepo = new HolidaysRepository();

    // Create services
    this.discordService = new DiscordService(
      database,
      discordRepo,
      fourthwallRepo,
      githubRepo,
      outlineRepo,
      zulipRepo,
      this.config,
    );

    this.webhookService = new WebhookService(database, discordRepo, fourthwallRepo, githubRepo, zulipRepo, this.config);

    this.scheduleService = new ScheduleService(database, discordRepo, outlineRepo, this.config);

    this.rssService = new RSSService(database, discordRepo, rssRepo);

    this.scheduledMessageService = new ScheduledMessageService(database, discordRepo);

    const githubService = new GithubService(githubRepo);

    this.zulipService = new ZulipService(holidaysRepo, zulipRepo);

    // Wire up discordx command/event classes to services
    setCommandServices({
      discord: this.discordService,
      rss: this.rssService,
      scheduledMessage: this.scheduledMessageService,
      github: githubService,
      webhook: this.webhookService,
    });

    setEventServices({
      discord: this.discordService,
    });
  }

  private async initialize() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;

    try {
      await this.discordService.init();
      this.zulipService.init(this.config.zulip);
      this.scheduledMessageService.init();

      // Set up the alarm for scheduled messages (every minute)
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (!currentAlarm) {
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
      }

      logger.log('DiscordBotDO initialized successfully');
    } catch (error) {
      this.initialized = false;
      logger.error('Failed to initialize DiscordBotDO', error);
      throw error;
    }
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialize();

    const url = new URL(request.url);

    try {
      switch (url.pathname) {
        case '/webhooks/github': {
          const slug = url.searchParams.get('slug') ?? '';
          const body = (await request.json()) as import('@octokit/webhooks-types').WebhookEvent;
          await this.webhookService.onGithub(body, slug);
          return new Response('OK');
        }

        case '/webhooks/github-status': {
          const slug = url.searchParams.get('slug') ?? '';
          const body = (await request.json()) as
            | import('../dtos/webhook.dto.js').GithubStatusIncident
            | import('../dtos/webhook.dto.js').GithubStatusComponent;
          await this.webhookService.onGithubStatus(body, slug);
          return new Response('OK');
        }

        case '/webhooks/stripe': {
          const slug = url.searchParams.get('slug') ?? '';
          const body = (await request.json()) as import('../dtos/webhook.dto.js').StripeBase;
          this.webhookService.onStripePayment(body, slug);
          return new Response('OK');
        }

        case '/webhooks/fourthwall': {
          const slug = url.searchParams.get('slug') ?? '';
          const body = (await request.json()) as
            | import('../interfaces/fourthwall.interface.js').FourthwallOrderCreateWebhook
            | import('../interfaces/fourthwall.interface.js').FourthwallOrderUpdateWebhook;
          this.webhookService.onFourthwallOrder(body, slug);
          return new Response('OK');
        }

        case '/cron': {
          const cron = url.searchParams.get('cron') ?? '';
          await this.handleCron(cron);
          return new Response('OK');
        }

        default: {
          return new Response('Not Found', { status: 404 });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Error handling ${url.pathname}: ${message}`);

      if (message === 'Unauthorized') {
        return new Response('Unauthorized', { status: 401 });
      }

      return new Response('Internal Server Error', { status: 500 });
    }
  }

  async alarm(): Promise<void> {
    try {
      await this.initialize();
      await this.scheduledMessageService.executeScheduledMessages();
    } catch (error) {
      logger.error('Alarm error', error);
    }

    // Re-schedule the alarm for the next minute
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  private async handleCron(cron: string) {
    logger.log(`Running cron: ${cron}`);

    switch (cron) {
      case '*/15 * * * *': {
        // RSS feed updates
        await this.rssService.onFeedUpdates();
        break;
      }

      case '36 4 3 2 *': {
        // Immich birthday
        await this.discordService.onBirthday();
        break;
      }

      case '0 12 * * *': {
        // Daily report
        await this.scheduleService.onDailyReport();
        break;
      }

      case '0 12 * * 4': {
        // Weekly report
        await this.scheduleService.onWeeklyReport();
        break;
      }

      case '0 12 19 * *': {
        // Monthly report
        await this.scheduleService.onMonthlyReport();
        break;
      }

      case '0 22 * * *': {
        // Holiday notification
        await this.zulipService.notifyHoliday();
        break;
      }

      case '0 0 * * *': {
        // Monthly summary creation
        await this.scheduleService.onCreateMonthlySummary();
        break;
      }

      default: {
        logger.warn(`Unknown cron: ${cron}`);
      }
    }
  }
}
