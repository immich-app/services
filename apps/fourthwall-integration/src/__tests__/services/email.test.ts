import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailService } from '../../services/email.js';
import { EmailData, Env } from '../../types/index.js';

// Mock WorkerMailer
vi.mock('worker-mailer', () => ({
  WorkerMailer: {
    send: vi.fn().mockResolvedValue(void 0),
  },
}));

const mockEnv = {
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_USER: 'user@example.com',
  SMTP_PASSWORD: 'password123',
} as unknown as Env;

describe('EmailService', () => {
  let emailService: EmailService;

  beforeEach(() => {
    vi.clearAllMocks();
    emailService = new EmailService(mockEnv);
  });

  describe('validateConfiguration', () => {
    it('should return true for valid configuration', () => {
      const result = emailService.validateConfiguration();
      expect(result).toBe(true);
    });

    it('should return false for missing SMTP host', () => {
      const invalidEnv = {
        ...mockEnv,
        SMTP_HOST: '',
      } as unknown as Env;

      const service = new EmailService(invalidEnv);
      const result = service.validateConfiguration();
      expect(result).toBe(false);
    });

    it('should return false for missing SMTP user', () => {
      const invalidEnv = {
        ...mockEnv,
        SMTP_USER: '',
      } as unknown as Env;

      const service = new EmailService(invalidEnv);
      const result = service.validateConfiguration();
      expect(result).toBe(false);
    });
  });

  describe('sendEmail', () => {
    it('should send email successfully', async () => {
      const emailData: EmailData = {
        to: 'recipient@example.com',
        subject: 'Test Subject',
        html: '<h1>Test HTML</h1>',
        text: 'Test text content',
      };

      // Mock console.log to verify logging
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await expect(emailService.sendEmail(emailData)).resolves.not.toThrow();

      expect(consoleSpy).toHaveBeenCalledWith('[EMAIL-SERVICE] Sending email to:', 'recipient@example.com');
      expect(consoleSpy).toHaveBeenCalledWith('[EMAIL-SERVICE] Subject:', 'Test Subject');
      expect(consoleSpy).toHaveBeenCalledWith('[EMAIL-SERVICE] Email sent successfully');

      consoleSpy.mockRestore();
    });

    it('should log email content details', async () => {
      const emailData: EmailData = {
        to: 'test@example.com',
        subject: 'Test Email',
        html: '<p>HTML content here</p>',
        text: 'Plain text content here',
      };

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await emailService.sendEmail(emailData);

      expect(consoleSpy).toHaveBeenCalledWith('[EMAIL-SERVICE] Sending email to:', 'test@example.com');
      expect(consoleSpy).toHaveBeenCalledWith('[EMAIL-SERVICE] Subject:', 'Test Email');
      expect(consoleSpy).toHaveBeenCalledWith('[EMAIL-SERVICE] Email sent successfully');

      consoleSpy.mockRestore();
    });

    it('should send email with WorkerMailer', async () => {
      const { WorkerMailer } = await import('worker-mailer');
      
      const emailData: EmailData = {
        to: 'test@example.com',
        subject: 'Test',
        html: '<p>Test</p>',
        text: 'Test',
      };

      await emailService.sendEmail(emailData);

      expect(WorkerMailer.send).toHaveBeenCalledWith(
        {
          host: 'smtp.example.com',
          port: 587,
          secure: false,
          startTls: true,
          credentials: {
            username: 'user@example.com',
            password: 'password123',
          },
          authType: ['plain', 'login'],
        },
        {
          to: 'test@example.com',
          from: 'Immich <noreply@immich.app>',
          subject: 'Test',
          text: 'Test',
          html: '<p>Test</p>',
        },
      );
    });
  });
});
