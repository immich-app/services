import type {
  DiscordLink,
  DiscordLinkUpdate,
  DiscordMessage,
  IDatabaseRepository,
  NewDiscordLink,
  NewDiscordMessage,
  NewFourthwallOrder,
  NewPayment,
  NewPullRequest,
  NewRSSFeed,
  NewScheduledMessage,
  PullRequestRecord,
  RSSFeed,
  ReportOptions,
  ScheduledMessage,
  UpdateDiscordMessage,
  UpdateFourthwallOrder,
  UpdateRSSFeed,
} from '../interfaces/database.interface.js';

export class DatabaseRepository implements IDatabaseRepository {
  constructor(private sql: SqlStorage) {}

  runMigrations() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS discord_link (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        createdAt TEXT DEFAULT (datetime('now')),
        author TEXT NOT NULL,
        link TEXT NOT NULL,
        name TEXT NOT NULL UNIQUE,
        usageCount INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS discord_message (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        createdAt TEXT DEFAULT (datetime('now')),
        lastEditedBy TEXT NOT NULL,
        name TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        usageCount INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS payment (
        event_id TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        description TEXT NOT NULL,
        created INTEGER NOT NULL,
        livemode INTEGER NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fourthwall_order (
        id TEXT PRIMARY KEY,
        discount REAL,
        tax REAL,
        shipping REAL,
        subtotal REAL,
        total REAL,
        revenue REAL,
        profit REAL,
        username TEXT,
        message TEXT,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        testMode INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS rss_feed (
        url TEXT NOT NULL,
        channelId TEXT NOT NULL,
        lastId TEXT,
        title TEXT,
        profileImageUrl TEXT,
        PRIMARY KEY (url, channelId)
      );

      CREATE TABLE IF NOT EXISTS scheduled_message (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        channelId TEXT NOT NULL,
        message TEXT NOT NULL,
        cronExpression TEXT NOT NULL,
        createdBy TEXT NOT NULL,
        name TEXT NOT NULL UNIQUE,
        createdAt TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS pull_request (
        id INTEGER PRIMARY KEY,
        discordThreadId TEXT NOT NULL,
        closedAt TEXT
      );

      CREATE TABLE IF NOT EXISTS sponsor (
        username TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        total INTEGER NOT NULL,
        claimed INTEGER DEFAULT 0,
        license_type TEXT NOT NULL,
        licenses TEXT NOT NULL
      );
    `);
  }

  createPayment(entity: NewPayment) {
    this.sql.exec(
      `INSERT INTO payment (event_id, id, amount, currency, status, description, created, livemode, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entity.event_id,
      entity.id,
      entity.amount,
      entity.currency,
      entity.status,
      entity.description,
      entity.created,
      entity.livemode ? 1 : 0,
      entity.data,
    );
  }

  getTotalLicenseCount(options?: ReportOptions): { server: number; client: number } {
    let query = `SELECT description, COUNT(*) as product_count FROM payment WHERE livemode = 1 AND status = 'succeeded'`;
    const params: (string | number)[] = [];

    if (options?.day) {
      query += ` AND created BETWEEN ? AND ?`;
      params.push(options.day.minus({ days: 1 }).toUnixInteger(), options.day.toUnixInteger());
    }
    if (options?.week) {
      query += ` AND created BETWEEN ? AND ?`;
      params.push(options.week.minus({ weeks: 1 }).toUnixInteger(), options.week.toUnixInteger());
    }
    if (options?.month) {
      query += ` AND created BETWEEN ? AND ?`;
      params.push(options.month.minus({ months: 1 }).toUnixInteger(), options.month.toUnixInteger());
    }

    query += ` GROUP BY description`;

    const results = this.sql.exec(query, ...params).toArray() as unknown as {
      description: string;
      product_count: number;
    }[];

    return {
      server: results.find((r) => r.description === 'immich-server')?.product_count || 0,
      client: results.find((r) => r.description === 'immich-client')?.product_count || 0,
    };
  }

  getDiscordLinks(): DiscordLink[] {
    return this.sql.exec(`SELECT * FROM discord_link`).toArray() as unknown as DiscordLink[];
  }

  getDiscordLink(name: string): DiscordLink | undefined {
    const results = this.sql.exec(`SELECT * FROM discord_link WHERE name = ?`, name).toArray();
    return (results[0] as unknown as DiscordLink) ?? undefined;
  }

  addDiscordLink(link: NewDiscordLink) {
    this.sql.exec(`INSERT INTO discord_link (author, link, name) VALUES (?, ?, ?)`, link.author, link.link, link.name);
  }

  removeDiscordLink(id: string) {
    this.sql.exec(`DELETE FROM discord_link WHERE id = ?`, id);
  }

  updateDiscordLink({ id, usageCount }: DiscordLinkUpdate) {
    if (usageCount !== undefined) {
      this.sql.exec(`UPDATE discord_link SET usageCount = ? WHERE id = ?`, usageCount, id);
    }
  }

  getDiscordMessages(): DiscordMessage[] {
    return this.sql.exec(`SELECT * FROM discord_message`).toArray() as unknown as DiscordMessage[];
  }

  getDiscordMessage(name: string): DiscordMessage | undefined {
    const results = this.sql.exec(`SELECT * FROM discord_message WHERE name = ?`, name).toArray();
    return (results[0] as unknown as DiscordMessage) ?? undefined;
  }

  addDiscordMessage(message: NewDiscordMessage) {
    this.sql.exec(
      `INSERT INTO discord_message (lastEditedBy, name, content) VALUES (?, ?, ?)`,
      message.lastEditedBy,
      message.name,
      message.content,
    );
  }

  updateDiscordMessage({ id, name, content, lastEditedBy }: UpdateDiscordMessage) {
    this.sql.exec(
      `UPDATE discord_message SET name = ?, content = ?, lastEditedBy = ? WHERE id = ?`,
      name,
      content,
      lastEditedBy,
      id,
    );
  }

  removeDiscordMessage(id: string) {
    this.sql.exec(`DELETE FROM discord_message WHERE id = ?`, id);
  }

  createFourthwallOrder(entity: NewFourthwallOrder) {
    this.sql.exec(
      `INSERT OR IGNORE INTO fourthwall_order (id, discount, tax, shipping, subtotal, total, revenue, profit, username, message, status, createdAt, testMode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entity.id,
      entity.discount,
      entity.tax,
      entity.shipping,
      entity.subtotal,
      entity.total,
      entity.revenue,
      entity.profit,
      entity.username ?? null,
      entity.message ?? null,
      entity.status,
      entity.createdAt.toISOString(),
      entity.testMode ? 1 : 0,
    );
  }

  updateFourthwallOrder({ id, ...entity }: UpdateFourthwallOrder) {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    for (const [key, value] of Object.entries(entity)) {
      if (value !== undefined) {
        sets.push(`${key} = ?`);
        values.push(value instanceof Date ? value.toISOString() : (value as string | number | null));
      }
    }

    if (sets.length === 0) {
      return;
    }

    values.push(id);
    this.sql.exec(`UPDATE fourthwall_order SET ${sets.join(', ')} WHERE id = ?`, ...values);
  }

  getTotalFourthwallOrders(options?: ReportOptions): { revenue: number; profit: number } {
    let query = `SELECT SUM(revenue) as revenue, SUM(profit) as profit FROM fourthwall_order WHERE testMode = 0`;
    const params: (string | number)[] = [];

    if (options?.day) {
      query += ` AND createdAt BETWEEN ? AND ?`;
      params.push(options.day.minus({ days: 1 }).toISO()!, options.day.toISO()!);
    }
    if (options?.week) {
      query += ` AND createdAt BETWEEN ? AND ?`;
      params.push(options.week.minus({ weeks: 1 }).toISO()!, options.week.toISO()!);
    }
    if (options?.month) {
      query += ` AND createdAt BETWEEN ? AND ?`;
      params.push(options.month.minus({ months: 1 }).toISO()!, options.month.toISO()!);
    }

    const results = this.sql.exec(query, ...params).toArray();
    const result = results[0] as unknown as { revenue: number | null; profit: number | null } | undefined;

    return { revenue: Number(result?.revenue) || 0, profit: Number(result?.profit) || 0 };
  }

  getFourthwallOrderIds(): { id: string }[] {
    return this.sql.exec(`SELECT id FROM fourthwall_order`).toArray() as unknown as { id: string }[];
  }

  createRSSFeed(entity: NewRSSFeed) {
    this.sql.exec(`INSERT INTO rss_feed (url, channelId) VALUES (?, ?)`, entity.url, entity.channelId);
  }

  getRSSFeeds(channelId?: string): RSSFeed[] {
    if (channelId) {
      return this.sql.exec(`SELECT * FROM rss_feed WHERE channelId = ?`, channelId).toArray() as unknown as RSSFeed[];
    }
    return this.sql.exec(`SELECT * FROM rss_feed`).toArray() as unknown as RSSFeed[];
  }

  removeRSSFeed(url: string, channelId: string) {
    this.sql.exec(`DELETE FROM rss_feed WHERE url = ? AND channelId = ?`, url, channelId);
  }

  updateRSSFeed(entity: UpdateRSSFeed) {
    this.sql.exec(
      `UPDATE rss_feed SET lastId = ?, title = ?, profileImageUrl = ? WHERE url = ? AND channelId = ?`,
      entity.lastId ?? null,
      entity.title ?? null,
      entity.profileImageUrl ?? null,
      entity.url,
      entity.channelId,
    );
  }

  getScheduledMessages(): ScheduledMessage[] {
    return this.sql.exec(`SELECT * FROM scheduled_message`).toArray() as unknown as ScheduledMessage[];
  }

  getScheduledMessage(name: string): ScheduledMessage | undefined {
    const results = this.sql.exec(`SELECT * FROM scheduled_message WHERE name = ?`, name).toArray();
    return (results[0] as unknown as ScheduledMessage) ?? undefined;
  }

  createScheduledMessage(entity: NewScheduledMessage): ScheduledMessage {
    const id = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO scheduled_message (id, channelId, message, cronExpression, createdBy, name) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      entity.channelId,
      entity.message,
      entity.cronExpression,
      entity.createdBy,
      entity.name,
    );
    const results = this.sql.exec(`SELECT * FROM scheduled_message WHERE id = ?`, id).toArray();
    return results[0] as unknown as ScheduledMessage;
  }

  removeScheduledMessage(id: string) {
    this.sql.exec(`DELETE FROM scheduled_message WHERE id = ?`, id);
  }

  createPullRequest(entity: NewPullRequest) {
    this.sql.exec(`INSERT INTO pull_request (id, discordThreadId) VALUES (?, ?)`, entity.id, entity.discordThreadId);
  }

  getPullRequestById(id: number): PullRequestRecord | undefined {
    const results = this.sql.exec(`SELECT * FROM pull_request WHERE id = ?`, id).toArray();
    return (results[0] as unknown as PullRequestRecord) ?? undefined;
  }

  updatePullRequest({ id, closedAt }: { id: number; closedAt?: Date | null }) {
    this.sql.exec(
      `UPDATE pull_request SET closedAt = ? WHERE id = ?`,
      closedAt === null ? null : (closedAt?.toISOString() ?? null),
      id,
    );
  }
}
