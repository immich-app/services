import { describe, expect, it } from 'vitest';
import { EmailTemplateService } from '../../services/email-template.js';
import { ProductKeyEmailData } from '../../types/index.js';

describe('EmailTemplateService', () => {
  describe('generateProductKeyEmail', () => {
    it('should generate client key email template', () => {
      const emailData: ProductKeyEmailData = {
        orderId: 'order-123',
        customerEmail: 'test@example.com',
        customerName: 'John Doe',
        keyType: 'client',
        keyValue: 'CLIENT-KEY-12345',
        activationKey: 'test-activation-key-client',
      };

      const result = EmailTemplateService.generateProductKeyEmail(emailData);

      expect(result.subject).toBe('Your Immich Client Product Key');
      expect(result.html).toContain('CLIENT-KEY-12345');
      expect(result.html).toContain('John Doe');
      expect(result.html).toContain('order-123');
      expect(result.html).toContain('Client Product Key');
      expect(result.html).toContain('https://static.immich.cloud/assets/immich-logo-inline-light.png');

      expect(result.text).toContain('CLIENT-KEY-12345');
      expect(result.text).toContain('John Doe');
      expect(result.text).toContain('order-123');
      expect(result.text).toContain('Client Product Key');
    });

    it('should generate server key email template', () => {
      const emailData: ProductKeyEmailData = {
        orderId: 'order-456',
        customerEmail: 'admin@example.com',
        customerName: 'Jane Admin',
        keyType: 'server',
        keyValue: 'SERVER-KEY-67890',
        activationKey: 'test-activation-key-server',
      };

      const result = EmailTemplateService.generateProductKeyEmail(emailData);

      expect(result.subject).toBe('Your Immich Server Product Key');
      expect(result.html).toContain('SERVER-KEY-67890');
      expect(result.html).toContain('Jane Admin');
      expect(result.html).toContain('order-456');
      expect(result.html).toContain('Server Product Key');

      expect(result.text).toContain('SERVER-KEY-67890');
      expect(result.text).toContain('Jane Admin');
      expect(result.text).toContain('order-456');
      expect(result.text).toContain('Server Product Key');
    });

    it('should include proper HTML structure', () => {
      const emailData: ProductKeyEmailData = {
        orderId: 'order-123',
        customerEmail: 'test@example.com',
        customerName: 'Test User',
        keyType: 'client',
        keyValue: 'TEST-KEY',
        activationKey: 'test-activation-key',
      };

      const result = EmailTemplateService.generateProductKeyEmail(emailData);

      expect(result.html).toContain('<!DOCTYPE html>');
      expect(result.html).toContain('<html lang="en">');
      expect(result.html).toContain('<head>');
      expect(result.html).toContain('<body>');
      expect(result.html).toContain('</html>');
      expect(result.html).toContain('class="container"');
      expect(result.html).toContain('class="key-value"');
    });

    it('should include security and brand elements', () => {
      const emailData: ProductKeyEmailData = {
        orderId: 'order-123',
        customerEmail: 'test@example.com',
        customerName: 'Test User',
        keyType: 'client',
        keyValue: 'TEST-KEY',
        activationKey: 'test-activation-key',
      };

      const result = EmailTemplateService.generateProductKeyEmail(emailData);

      // Should include Immich branding
      expect(result.html).toContain('Immich');
      expect(result.html).toContain('immich.app');

      // Should have proper styling for key display
      expect(result.html).toContain("font-family: 'SF Mono'");
      expect(result.html).toContain('word-break: break-all');

      // Text template should include copyright
      const currentYear = new Date().getFullYear();
      expect(result.text).toContain(`© ${currentYear} Immich`);
    });

    it('should generate different instructions for client vs server keys', () => {
      const clientEmailData: ProductKeyEmailData = {
        orderId: 'order-123',
        customerEmail: 'test@example.com',
        customerName: 'Test User',
        keyType: 'client',
        keyValue: 'CLIENT-KEY',
        activationKey: 'client-activation',
      };

      const serverEmailData: ProductKeyEmailData = {
        orderId: 'order-456',
        customerEmail: 'test@example.com',
        customerName: 'Test User',
        keyType: 'server',
        keyValue: 'SERVER-KEY',
        activationKey: 'server-activation',
      };

      const clientResult = EmailTemplateService.generateProductKeyEmail(clientEmailData);
      const serverResult = EmailTemplateService.generateProductKeyEmail(serverEmailData);

      // Client and server should have different key type titles
      expect(clientResult.html).toContain('Client Product Key');
      expect(serverResult.html).toContain('Server Product Key');

      // Text templates should have different instructions
      expect(clientResult.text).toContain('mobile app or web interface');
      expect(clientResult.text).toContain('Settings > Product Key');
      expect(serverResult.text).toContain('server administration panel');
      expect(serverResult.text).toContain('System Settings > Product Key');
    });
  });
});
