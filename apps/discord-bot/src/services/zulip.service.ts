import { DateTime } from 'luxon';
import { Constants } from '../constants.js';
import type { HolidayDto, IHolidaysInterface } from '../interfaces/holidays.interface.js';
import type { IZulipInterface, ZulipConfig } from '../interfaces/zulip.interface.js';

const isRelevantHoliday = (holiday: HolidayDto) =>
  holiday.types?.includes('Public') && (holiday.global || holiday.counties?.includes('US-TX'));

export class ZulipService {
  constructor(
    private holidays: IHolidaysInterface,
    private zulip: IZulipInterface,
  ) {}

  init(config: ZulipConfig) {
    if (config.bot.apiKey !== 'dev' && config.user.apiKey !== 'dev') {
      this.zulip.init(config);
    }
  }

  async notifyHoliday() {
    const tomorrow = DateTime.now().plus({ days: 1 });
    const holidays = await this.holidays.getHolidays('US', tomorrow.year);

    const holiday = holidays.find((h) => h.date === tomorrow.toISODate() && isRelevantHoliday(h));

    if (!holiday) {
      return;
    }

    await this.zulip.sendMessage({
      stream: Constants.Zulip.Streams.FUTOStaff,
      topic: 'Holidays',
      content: `Tomorrow is a federal holiday: ${holiday.name}. There won't be any meetings tomorrow.`,
    });
  }
}
