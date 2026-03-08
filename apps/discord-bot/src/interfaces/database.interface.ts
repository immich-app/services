import type { DateTime } from 'luxon';

export type DiscordLink = {
  id: string;
  createdAt: string;
  author: string;
  link: string;
  name: string;
  usageCount: number;
};

export type NewDiscordLink = {
  name: string;
  link: string;
  author: string;
};

export type DiscordLinkUpdate = {
  id: string;
  usageCount?: number;
};

export type DiscordMessage = {
  id: string;
  createdAt: string;
  lastEditedBy: string;
  name: string;
  content: string;
  usageCount: number;
};

export type NewDiscordMessage = {
  name: string;
  content: string;
  lastEditedBy: string;
};

export type UpdateDiscordMessage = {
  id: string;
  name: string;
  content: string;
  lastEditedBy: string;
};

export type NewPayment = {
  event_id: string;
  id: string;
  amount: number;
  currency: string;
  status: string;
  description: string;
  created: number;
  livemode: boolean;
  data: string;
};

export type NewFourthwallOrder = {
  id: string;
  discount: number;
  tax: number;
  shipping: number;
  subtotal: number;
  total: number;
  revenue: number;
  profit: number;
  username?: string | null;
  message?: string | null;
  status: string;
  createdAt: Date;
  testMode: boolean;
};

export type UpdateFourthwallOrder = {
  id: string;
  discount?: number;
  tax?: number;
  shipping?: number;
  subtotal?: number;
  total?: number;
  revenue?: number;
  profit?: number;
  username?: string | null;
  message?: string | null;
  status?: string;
  createdAt?: Date;
};

export type RSSFeed = {
  url: string;
  channelId: string;
  lastId: string | null;
  title: string | null;
  profileImageUrl: string | null;
};

export type NewRSSFeed = {
  url: string;
  channelId: string;
};

export type UpdateRSSFeed = {
  url: string;
  channelId: string;
  lastId?: string | null;
  title?: string | null;
  profileImageUrl?: string | null;
};

export type ScheduledMessage = {
  id: string;
  channelId: string;
  message: string;
  cronExpression: string;
  createdBy: string;
  name: string;
  createdAt: string;
};

export type NewScheduledMessage = {
  channelId: string;
  message: string;
  cronExpression: string;
  createdBy: string;
  name: string;
};

export type PullRequestRecord = {
  id: number;
  discordThreadId: string;
  closedAt: string | null;
};

export type NewPullRequest = {
  id: number;
  discordThreadId: string;
};

export type ReportOptions = {
  day?: DateTime;
  week?: DateTime;
  month?: DateTime;
};

export interface IDatabaseRepository {
  runMigrations(): void;
  createPayment(entity: NewPayment): void;
  getTotalLicenseCount(options?: ReportOptions): { server: number; client: number };
  getDiscordLinks(): DiscordLink[];
  getDiscordLink(name: string): DiscordLink | undefined;
  addDiscordLink(link: NewDiscordLink): void;
  removeDiscordLink(id: string): void;
  updateDiscordLink(link: DiscordLinkUpdate): void;
  getDiscordMessages(): DiscordMessage[];
  getDiscordMessage(name: string): DiscordMessage | undefined;
  addDiscordMessage(message: NewDiscordMessage): void;
  updateDiscordMessage(message: UpdateDiscordMessage): void;
  removeDiscordMessage(id: string): void;
  createFourthwallOrder(entity: NewFourthwallOrder): void;
  updateFourthwallOrder(entity: UpdateFourthwallOrder): void;
  getTotalFourthwallOrders(options?: ReportOptions): { revenue: number; profit: number };
  getFourthwallOrderIds(): { id: string }[];
  createRSSFeed(entity: NewRSSFeed): void;
  getRSSFeeds(channelId?: string): RSSFeed[];
  removeRSSFeed(url: string, channelId: string): void;
  updateRSSFeed(entity: UpdateRSSFeed): void;
  getScheduledMessages(): ScheduledMessage[];
  getScheduledMessage(name: string): ScheduledMessage | undefined;
  createScheduledMessage(entity: NewScheduledMessage): ScheduledMessage;
  removeScheduledMessage(id: string): void;
  createPullRequest(entity: NewPullRequest): void;
  getPullRequestById(id: number): PullRequestRecord | undefined;
  updatePullRequest(entity: { id: number; closedAt?: Date | null }): void;
}
