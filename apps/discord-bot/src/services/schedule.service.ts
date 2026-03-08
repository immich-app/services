import { Colors, EmbedBuilder, roleMention } from 'discord.js';
import { DateTime } from 'luxon';
import type { AppConfig } from '../config.js';
import { Constants } from '../constants.js';
import type { IDatabaseRepository } from '../interfaces/database.interface.js';
import { DiscordChannel, type IDiscordInterface } from '../interfaces/discord.interface.js';
import type { IOutlineInterface } from '../interfaces/outline.interface.js';
import { getTotal, makeLicenseFields, makeOrderFields } from '../util.js';

export class ScheduleService {
  constructor(
    private database: IDatabaseRepository,
    private discord: IDiscordInterface,
    private outline: IOutlineInterface,
    private config: AppConfig,
  ) {}

  async onDailyReport() {
    const endOfYesterday = DateTime.now().minus({ days: 1 }).endOf('day');
    const { server, client } = this.database.getTotalLicenseCount({ day: endOfYesterday });
    const { revenue, profit } = this.database.getTotalFourthwallOrders({ day: endOfYesterday });

    await this.discord.sendMessage({
      channelId: DiscordChannel.Stripe,
      message: {
        embeds: [
          new EmbedBuilder()
            .setTitle(`Daily licenses report for ${endOfYesterday.toLocaleString(DateTime.DATE_FULL)}`)
            .setDescription(`Total: ${getTotal({ server, client })}`)
            .setColor(Colors.Purple)
            .setFields(makeLicenseFields({ server, client })),
        ],
      },
    });

    await this.discord.sendMessage({
      channelId: DiscordChannel.Stripe,
      message: {
        embeds: [
          new EmbedBuilder()
            .setTitle(`Daily orders report for ${endOfYesterday.toLocaleString(DateTime.DATE_FULL)}`)
            .setDescription(`Revenue: ${revenue.toLocaleString()} USD; Profit: ${profit.toLocaleString()} USD`)
            .setColor(Colors.DarkPurple)
            .setFields(makeOrderFields({ revenue, profit })),
        ],
      },
    });
  }

  async onWeeklyReport() {
    const endOfYesterday = DateTime.now().minus({ days: 1 }).endOf('day');
    const lastWeek = endOfYesterday.minus({ weeks: 1 });
    const { server, client } = this.database.getTotalLicenseCount({ week: endOfYesterday });
    const { revenue, profit } = this.database.getTotalFourthwallOrders({ week: endOfYesterday });

    await this.discord.sendMessage({
      channelId: DiscordChannel.Stripe,
      message: {
        embeds: [
          new EmbedBuilder()
            .setTitle(
              `Weekly licenses report for ${lastWeek.toFormat('MMMM dd')} - ${endOfYesterday.toFormat('MMMM dd')}`,
            )
            .setDescription(`Total: ${getTotal({ server, client })}`)
            .setColor(Colors.Purple)
            .setFields(makeLicenseFields({ server, client })),
        ],
      },
    });

    await this.discord.sendMessage({
      channelId: DiscordChannel.Stripe,
      message: {
        embeds: [
          new EmbedBuilder()
            .setTitle(
              `Weekly orders report for ${lastWeek.toFormat('MMMM dd')} - ${endOfYesterday.toFormat('MMMM dd')}`,
            )
            .setDescription(`Revenue: ${revenue.toLocaleString()} USD; Profit: ${profit.toLocaleString()} USD`)
            .setColor(Colors.DarkPurple)
            .setFields(makeOrderFields({ revenue, profit })),
        ],
      },
    });
  }

  async onMonthlyReport() {
    const endOfYesterday = DateTime.now().minus({ days: 1 }).endOf('day');
    const lastMonth = endOfYesterday.minus({ months: 1 });
    const { server, client } = this.database.getTotalLicenseCount({ month: endOfYesterday });
    const { revenue, profit } = this.database.getTotalFourthwallOrders({ month: endOfYesterday });

    await this.discord.sendMessage({
      channelId: DiscordChannel.Stripe,
      message: {
        embeds: [
          new EmbedBuilder()
            .setTitle(
              `Monthly licenses report for ${lastMonth.toFormat('MMMM dd')} - ${endOfYesterday.toFormat('MMMM dd')}`,
            )
            .setDescription(`Total: ${getTotal({ server, client })}`)
            .setColor(Colors.Purple)
            .setFields(makeLicenseFields({ server, client })),
        ],
      },
    });

    await this.discord.sendMessage({
      channelId: DiscordChannel.Stripe,
      message: {
        embeds: [
          new EmbedBuilder()
            .setTitle(
              `Monthly orders report for ${lastMonth.toFormat('MMMM dd')} - ${endOfYesterday.toFormat('MMMM dd')}`,
            )
            .setDescription(`Revenue: ${revenue.toLocaleString()} USD; Profit: ${profit.toLocaleString()} USD`)
            .setColor(Colors.DarkPurple)
            .setFields(makeOrderFields({ revenue, profit })),
        ],
      },
    });
  }

  async onCreateMonthlySummary() {
    const endOfMonth = DateTime.now().endOf('month');

    if (endOfMonth.diffNow('days').days !== 7) {
      return;
    }

    const apiKey = this.config.outline.apiKey;
    const name = `${endOfMonth.monthLong} ${endOfMonth.year} recap`;
    const response = await this.outline.createDocument({
      apiKey,
      collectionId: Constants.Outline.Collections.SupportCrew,
      parentDocumentId: Constants.Outline.Documents.SupportCrewAnnouncements,
      title: name,
      icon: 'pencil',
      iconColor: '#00D084',
      text: `
---

description: A recap of ${endOfMonth.monthLong}, ${endOfMonth.year}, including an update on upcoming features, releases, developer updates, and more.

publishedAt: ${endOfMonth.toFormat('yyyy-LL-dd')}

slug: ${endOfMonth.year}-${endOfMonth.monthLong?.toLowerCase()}-recap

authors: [Immich Team]

coverAttribution: Photo by <a href="https://unsplash.com/@v2osk" class="underline">v2osk</a> on <a href="https://unsplash.com/photos/foggy-mountain-summit-1Z2niiBPg5A" class="underline">Unsplash</a>

---

![](https://outline.immich.cloud/api/attachments.redirect?id=7f44c5e3-8f91-4149-aeab-39243c313816" =5299x2981")

Hello everyone!


## Roadmap update


## Releases


## Developers update - from the labyrinth

*Our team members' unfiltered thoughts on the good, the bad, and the frustration about the current tasks they are working on.*

### @alextran1502

### @jrasm91

### @bwees


## Upcoming goals


\\
Well, that's it for this month. As always, if you find the project helpful, you can support us at <https://buy.immich.app/>.
`,
    });
    const thread = await this.discord.createThread(Constants.Discord.Channels.SupportCrewDraftAnnouncements, {
      name,
      message: response.url,
    });

    if (thread) {
      await this.discord.sendMessage({
        channelId: Constants.Discord.Channels.SupportCrewDraftAnnouncements,
        threadId: thread.threadId,
        message: `${roleMention(Constants.Discord.Roles.SupportCrew)} ${roleMention(Constants.Discord.Roles.Team)} let's start with this month's recap! 🚀`,
      });
    }
  }
}
