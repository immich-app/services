import type { DiscordChannel, IDiscordInterface } from './interfaces/discord.interface.js';

type Logger = { error(...args: unknown[]): void };
type Repos = { discord: IDiscordInterface; logger: Logger; botSpamChannelId: DiscordChannel | string };

export const logError = async (message: string, error: unknown, { discord, logger, botSpamChannelId }: Repos) => {
  logger.error(message, error);
  try {
    await discord.sendMessage({ channelId: botSpamChannelId, message: `${message}: ${error}` });
  } catch (sendError) {
    logger.error('Failed to send error message to bot spam channel', sendError);
  }
};

type WithErrorOptions<T> = Repos & {
  message: string;
  method: () => Promise<T>;
  fallbackValue: T;
};
export const withErrorLogging = async <T = unknown>(options: WithErrorOptions<T>) => {
  const { message, method, fallbackValue, discord, logger, botSpamChannelId } = options;
  try {
    return await method();
  } catch (error) {
    await logError(message, error, { discord, logger, botSpamChannelId });
    return fallbackValue;
  }
};

export const getTotal = ({ server, client }: { server: number; client: number }) => {
  return '$' + (server * 100 + client * 25).toLocaleString();
};

export const makeLicenseFields = ({ server, client }: { server: number; client: number }) => {
  return [
    {
      name: 'Server licenses',
      value: `$${(server * 100).toLocaleString()} - ${server.toLocaleString()} licenses`,
      inline: true,
    },
    {
      name: 'Client licenses',
      value: `$${(client * 25).toLocaleString()} - ${client.toLocaleString()} licenses`,
      inline: true,
    },
  ];
};

export const makeOrderFields = ({
  revenue,
  profit,
  message,
}: {
  revenue: number;
  profit: number;
  message?: string;
}) => {
  const fields = [
    { name: 'Revenue', value: `${revenue.toLocaleString()} USD`, inline: true },
    { name: 'Profit', value: `${profit.toLocaleString()} USD`, inline: true },
  ];
  if (message) {
    fields.push({ name: 'Message', value: message, inline: true });
  }
  return fields;
};

export const shorten = (text: string, maxLength: number = 100) => {
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
};

export const formatCommand = (name: string, ...args: string[]) => {
  return `\n\`\`\`\n/${name} ${args.join(' ')}\n\`\`\``;
};

export const createLogger = (name: string) => ({
  log: (...args: unknown[]) => console.log(`[${name}]`, ...args),
  error: (...args: unknown[]) => console.error(`[${name}]`, ...args),
  warn: (...args: unknown[]) => console.warn(`[${name}]`, ...args),
  debug: (...args: unknown[]) => console.debug(`[${name}]`, ...args),
  verbose: (...args: unknown[]) => console.debug(`[${name}]`, ...args),
});
