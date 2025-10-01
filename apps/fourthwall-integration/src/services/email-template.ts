import { ProductKeyEmailData } from '../types/index.js';

export class EmailTemplateService {
  static generateProductKeyEmail(data: ProductKeyEmailData): { html: string; text: string; subject: string } {
    const subject = `Your Immich ${data.keyType === 'client' ? 'Client' : 'Server'} Product Key`;

    const html = this.generateHtmlTemplate(data);
    const text = this.generateTextTemplate(data);

    return { html, text, subject };
  }

  private static generateHtmlTemplate(data: ProductKeyEmailData): string {
    const keyTypeTitle = data.keyType === 'client' ? 'Client' : 'Server';
    const keyDescription =
      data.keyType === 'client'
        ? 'This key is your license for the Immich mobile and web applications.'
        : 'This key is your license for your self-hosted Immich server instance.';

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your Immich ${keyTypeTitle} Product Key</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f8fafc;
        }
        .container {
            background-color: #ffffff;
            border-radius: 12px;
            padding: 40px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
        }
        .header {
            text-align: center;
            margin-bottom: 40px;
        }
        .logo {
            max-width: 200px;
            height: auto;
            margin-bottom: 20px;
        }
        .title {
            color: #1a202c;
            font-size: 28px;
            font-weight: 700;
            margin: 0;
        }
        .subtitle {
            color: #4a5568;
            font-size: 16px;
            margin: 8px 0 0 0;
        }
        .greeting {
            font-size: 18px;
            margin-bottom: 24px;
        }
        .description {
            color: #4a5568;
            margin-bottom: 32px;
            font-size: 16px;
        }
        .key-section {
            background-color: #f7fafc;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            padding: 24px;
            margin: 24px 0;
            text-align: center;
        }
        .key-label {
            font-weight: 600;
            color: #2d3748;
            margin-bottom: 12px;
            font-size: 14px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .key-value {
            font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
            font-size: 18px;
            font-weight: 600;
            background-color: #ffffff;
            border: 1px solid #cbd5e0;
            border-radius: 6px;
            padding: 16px;
            word-break: break-all;
            color: #2b6cb0;
        }
        .instructions {
            background-color: #ebf8ff;
            border-left: 4px solid #3182ce;
            padding: 20px;
            margin: 24px 0;
        }
        .instructions h3 {
            color: #2c5282;
            margin: 0 0 12px 0;
            font-size: 16px;
        }
        .instructions ul {
            margin: 0;
            padding-left: 20px;
        }
        .instructions li {
            margin-bottom: 8px;
            color: #2d3748;
        }
        .footer {
            text-align: center;
            margin-top: 40px;
            padding-top: 32px;
            border-top: 1px solid #e2e8f0;
            color: #718096;
            font-size: 14px;
        }
        .footer a {
            color: #3182ce;
            text-decoration: none;
        }
        .footer a:hover {
            text-decoration: underline;
        }
        .support-note {
            background-color: #f0fff4;
            border: 1px solid #c6f6d5;
            border-radius: 6px;
            padding: 16px;
            margin: 24px 0;
            font-size: 14px;
            color: #22543d;
        }
        .activate-button {
            display: inline-block;
            background-color: #3182ce;
            color: #ffffff !important;
            text-decoration: none;
            padding: 16px 32px;
            border-radius: 8px;
            font-weight: 600;
            font-size: 16px;
            margin: 24px 0;
            text-align: center;
        }
        .activate-button:hover {
            background-color: #2c5282;
        }
        .button-container {
            text-align: center;
            margin: 32px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <img src="https://static.immich.cloud/assets/immich-logo-inline-light.png" alt="Immich" class="logo">
            <h1 class="title">Your ${keyTypeTitle} Product Key</h1>
            <p class="subtitle">Thank you for supporting Immich!</p>
        </div>

        <div class="greeting">
            Hello ${data.customerName},
        </div>

        <div class="description">
            Thank you for your purchase! Your Immich ${keyTypeTitle} product key is ready. ${keyDescription}
        </div>

        <div class="key-section">
            <div class="key-label">${keyTypeTitle} Product Key</div>
            <div class="key-value">${data.keyValue}</div>
        </div>

        <div class="button-container">
            <a href="https://my.immich.app/link?target=activate_license&licenseKey=${encodeURIComponent(data.keyValue)}&activationKey=${encodeURIComponent(data.activationKey)}" class="activate-button">Activate Product Key</a>
        </div>

        <div class="instructions">
            <h3>How to use your product key:</h3>
            <ul>
               <li>Click the "Activate Product Key" button above for one-click activation</li>
               <li>Or manually open the Immich web interface, navigate to Account Settings > Purchase, and enter your product key</li>
            </ul>
        </div>

        <div class="support-note">
            <strong>Need help?</strong> Visit our documentation or contact support if you have any questions about activating your product key.
        </div>

        <div class="footer">
            <p>This email was sent for order #${data.orderId}</p>
            <p>Visit <a href="https://immich.app">immich.app</a> for more information</p>
        </div>
    </div>
</body>
</html>`;
  }

  private static generateTextTemplate(data: ProductKeyEmailData): string {
    const keyTypeTitle = data.keyType === 'client' ? 'Client' : 'Server';
    const keyDescription =
      data.keyType === 'client'
        ? 'This key is your license for the Immich mobile and web applications.'
        : 'This key is your license for your self-hosted Immich server instance.';

    const instructions =
      data.keyType === 'client'
        ? `- Open the Immich mobile app or web interface
- Navigate to Settings > Product Key
- Enter your product key in the provided field`
        : `- Access your Immich server administration panel
- Navigate to System Settings > Product Key
- Enter your product key in the server configuration`;

    const activationUrl = `https://my.immich.app/link?target=activate_license&licenseKey=${encodeURIComponent(data.keyValue)}&activationKey=${encodeURIComponent(data.activationKey)}`;

    return `Your Immich ${keyTypeTitle} Product Key

Hello ${data.customerName},

Thank you for your purchase! Your Immich ${keyTypeTitle} product key is ready. ${keyDescription}

${keyTypeTitle} Product Key:
${data.keyValue}

Activate Your Product Key:
Click this link to activate automatically: ${activationUrl}

How to use your product key:
${instructions}

Need help? Visit our documentation or contact support if you have any questions about activating your product key.

This email was sent for order #${data.orderId}
Visit https://immich.app for more information

© ${new Date().getFullYear()} Immich. All rights reserved.`;
  }
}
