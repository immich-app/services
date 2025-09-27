import { WorkerMailer } from 'worker-mailer';
import { EmailData, Env } from '../types/index.js';

export class EmailService {
  private readonly smtpHost: string;
  private readonly smtpPort: number;
  private readonly smtpUser: string;
  private readonly smtpPassword: string;

  constructor(env: Env) {
    this.smtpHost = env.SMTP_HOST;
    this.smtpPort = Number.parseInt(env.SMTP_PORT, 10);
    this.smtpUser = env.SMTP_USER;
    this.smtpPassword = env.SMTP_PASSWORD;
  }

  async sendEmail(emailData: EmailData): Promise<void> {
    console.log('[EMAIL-SERVICE] Sending email to:', emailData.to);
    console.log('[EMAIL-SERVICE] Subject:', emailData.subject);

    if (!this.validateConfiguration()) {
      throw new Error('SMTP configuration is invalid');
    }

    try {
      await WorkerMailer.send(
        {
          host: this.smtpHost,
          port: this.smtpPort,
          secure: this.smtpPort === 465, // Use SSL for port 465
          startTls: this.smtpPort === 587, // Use STARTTLS for port 587
          credentials: {
            username: this.smtpUser,
            password: this.smtpPassword,
          },
          authType: ['plain', 'login'], // Specify supported auth methods
        },
        {
          to: emailData.to,
          from: 'Immich <noreply@immich.app>',
          subject: emailData.subject,
          text: emailData.text,
          html: emailData.html,
        },
      );

      console.log('[EMAIL-SERVICE] Email sent successfully');
    } catch (error) {
      console.error('[EMAIL-SERVICE] Failed to send email:', error);
      throw new Error(`Failed to send email: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  validateConfiguration(): boolean {
    try {
      if (!this.smtpHost || !this.smtpPort || !this.smtpUser || !this.smtpPassword) {
        console.error('[EMAIL-SERVICE] Missing SMTP configuration');
        return false;
      }

      console.log('[EMAIL-SERVICE] SMTP configuration is valid');
      return true;
    } catch (error) {
      console.error('[EMAIL-SERVICE] SMTP configuration validation failed:', error);
      return false;
    }
  }
}
