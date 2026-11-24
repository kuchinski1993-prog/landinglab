// Idempotent seed of default TrustShield email templates.
//
// Inserts one row per (store_id, event_key) into `email_templates`. Re-running
// the script is safe: ON CONFLICT DO UPDATE overwrites subject + html_body so
// you can iterate on copy without manual DELETEs.
//
// Honesty constraints (TrustShield principle):
// - We never promise approval, refund, or timing in the receipt template
//   (`refund_requested`). The customer is acknowledged, not pre-approved.
// - We never invent a delivery timeline for refunded money — only state the
//   bank-side window that ACTUALLY applies (7–10 business days after the
//   payment provider issues the refund).
// - In the rejection template, the reason is interpolated from the operator
//   notes ({{reason}}). No template-side excuses or downplaying.
// - Voice is UK English (the store is AuthenLondon).
//
// Run: export DATABASE_URL=...; pnpm --filter @blackshop/api exec tsx
//      src/scripts/seed-email-templates.ts
//
// Optional: STORE_ID=<id> to seed for a non-default store. Defaults to 'default'.

import { createClient, emailTemplates } from '@blackshop/db';
import { sql } from 'drizzle-orm';

export interface TemplateRow {
  eventKey: string;
  subject: string;
  htmlBody: string;
}

// URL da logo hospedada na Shopify CDN (PNG preto, fundo transparente).
// Trocar aqui atualiza os 4 templates de uma vez.
export const BRAND_LOGO_URL =
  'https://cdn.shopify.com/s/files/1/0740/4185/1997/files/ChatGPT_Image_8_de_jul._de_2026_09_00_27_1_450x.png?v=1783512846';

// Cabeçalho compartilhado inserido no topo de cada template. HTML
// deliberadamente conservador (inline styles, `width` como atributo) para
// que Outlook e clientes antigos respeitem o dimensionamento — não
// dependemos de CSS externo nem media queries.
export const LOGO_HEADER = `<div style="text-align:center; padding:16px 0 24px;">
    <img src="${BRAND_LOGO_URL}"
         alt="AuthenLondon" width="180"
         style="display:inline-block; max-width:180px; height:auto;" />
  </div>`;

// Minimal inline CSS so the email renders the same in every client without
// importing a real template engine. The {{var}} placeholders are interpolated
// at send time — see packages/email/src/render.ts.
export const DEFAULT_TEMPLATES: TemplateRow[] = [
  {
    eventKey: 'refund_requested',
    subject: 'We have received your request — AuthenLondon order #{{order_number}}',
    htmlBody: `<!doctype html>
<html lang="en">
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">
  ${LOGO_HEADER}
  <p>Hi {{customer_name}},</p>
  <p>Thanks for getting in touch about order <strong>#{{order_number}}</strong>. We have received your request and a member of our team will look at it shortly.</p>
  <p>We will keep you posted by email. You can also check the status at any time:</p>
  <p><a href="{{tracking_url}}" style="display: inline-block; background: #000; color: #fff; padding: 10px 18px; text-decoration: none; border-radius: 4px;">Track your request</a></p>
  <p>If you have anything else to add, simply reply to this email.</p>
  <p>— AuthenLondon Support</p>
  <hr style="border: 0; border-top: 1px solid #e5e5e5; margin: 24px 0;" />
  <p style="font-size: 12px; color: #666;">Reference: {{ticket_id}}</p>
</body>
</html>`,
  },
  {
    eventKey: 'refund_approved',
    subject: 'Your refund has been approved — order #{{order_number}}',
    htmlBody: `<!doctype html>
<html lang="en">
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">
  ${LOGO_HEADER}
  <p>Hi {{customer_name}},</p>
  <p>Good news: your request for order <strong>#{{order_number}}</strong> has been approved.</p>
  <p>{{next_steps}}</p>
  <p>Once the refund is issued by our payment provider, it usually takes <strong>7 to 10 business days</strong> for the amount to appear on your statement. The exact timing depends on your bank.</p>
  <p><a href="{{tracking_url}}" style="display: inline-block; background: #000; color: #fff; padding: 10px 18px; text-decoration: none; border-radius: 4px;">Check your request</a></p>
  <p>Thank you for your patience.</p>
  <p>— AuthenLondon Support</p>
  <hr style="border: 0; border-top: 1px solid #e5e5e5; margin: 24px 0;" />
  <p style="font-size: 12px; color: #666;">Reference: {{ticket_id}}</p>
</body>
</html>`,
  },
  {
    eventKey: 'refund_rejected',
    subject: 'Update on your request — order #{{order_number}}',
    htmlBody: `<!doctype html>
<html lang="en">
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">
  ${LOGO_HEADER}
  <p>Hi {{customer_name}},</p>
  <p>We have reviewed your request for order <strong>#{{order_number}}</strong>. After looking at the details, we are unable to approve it on this occasion.</p>
  <p><strong>Reason:</strong> {{reason}}</p>
  <p>If you believe this decision should be reconsidered, please reply to this email with any additional information and we will take another look.</p>
  <p><a href="{{tracking_url}}" style="display: inline-block; background: #000; color: #fff; padding: 10px 18px; text-decoration: none; border-radius: 4px;">View your request</a></p>
  <p>— AuthenLondon Support</p>
  <hr style="border: 0; border-top: 1px solid #e5e5e5; margin: 24px 0;" />
  <p style="font-size: 12px; color: #666;">Reference: {{ticket_id}}</p>
</body>
</html>`,
  },
  {
    eventKey: 'refund_status_update',
    subject: 'New update on your request — order #{{order_number}}',
    htmlBody: `<!doctype html>
<html lang="en">
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">
  ${LOGO_HEADER}
  <p>Hi {{customer_name}},</p>
  <p>There is a new update on your request for order <strong>#{{order_number}}</strong>:</p>
  <blockquote style="border-left: 3px solid #000; margin: 16px 0; padding: 4px 0 4px 12px; color: #333;">{{message}}</blockquote>
  <p><a href="{{tracking_url}}" style="display: inline-block; background: #000; color: #fff; padding: 10px 18px; text-decoration: none; border-radius: 4px;">Open the conversation</a></p>
  <p>— AuthenLondon Support</p>
  <hr style="border: 0; border-top: 1px solid #e5e5e5; margin: 24px 0;" />
  <p style="font-size: 12px; color: #666;">Reference: {{ticket_id}}</p>
</body>
</html>`,
  },
  // ── Shopify notification templates recuperados (Fase C3-fix) ──────
  // Conteúdo rico escrito pelo dono. Variáveis do sistema: {{order_number}},
  // {{customer_name}}, {{tracking_url}}, {{tracking_number}}, {{tracking_company}}.
  // Marcadores "—" ficam onde o Liquid original usava vars sem paridade no
  // envio TrustShield (endereço, subtotal, previsão). O dono edita no admin.
  {
    eventKey: 'order_confirmed',
    subject: 'Order {{order_number}} confirmed — thank you from AuthenLondon',
    htmlBody: `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Order {{order_number}} confirmed</title>
  <style>
    @media only screen and (max-width: 600px) {
      table[role="presentation"] { width: 100% !important; max-width: 100% !important; }
      body, td, p, div { font-size: 15px !important; }
    }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a !important; color: #ffffff !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;">

<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#f6f6f7;line-height:1px;">
  Your order {{order_number}} is confirmed. Total —. We will notify you as soon as it ships.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f7;padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">

        <tr>
          <td align="center" style="padding:32px 32px 0 32px;">
            
              <img src="https://cdn.shopify.com/s/files/1/0740/4185/1997/files/ChatGPT_Image_8_de_jul._de_2026_09_00_27_1_450x.png?v=1783512846" alt="AuthenLondon" width="140" style="display:block;border:0;max-width:140px;height:auto;">
            
          </td>
        </tr>

        <tr>
          <td style="padding:32px;">
            <div style="font-size:28px;line-height:1.2;font-weight:600;margin:0 0 8px 0;">Thank you, {{customer_name}}</div>
            <p style="font-size:16px;line-height:1.5;margin:0 0 24px 0;color:#3b3d40;">
              Your order <strong>{{order_number}}</strong> is confirmed. We are preparing everything for you and will send tracking as soon as it ships.
            </p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e1e3e5;border-radius:8px;padding:16px;margin-bottom:16px;">
              
              <tr><td colspan="2" style="border-top:1px solid #e1e3e5;padding-top:8px;"></td></tr>
              <tr>
                <td style="padding:4px 0;font-size:14px;color:#6d7175;">Subtotal</td>
                <td align="right" style="padding:4px 0;font-size:14px;">—</td>
              </tr>
              
              <tr>
                <td style="padding:4px 0;font-size:14px;color:#6d7175;">Shipping</td>
                <td align="right" style="padding:4px 0;font-size:14px;">—</td>
              </tr>
              
              
              <tr>
                <td style="padding:8px 0 0 0;font-size:15px;font-weight:600;">Total</td>
                <td align="right" style="padding:8px 0 0 0;font-size:15px;font-weight:600;">—</td>
              </tr>
            </table>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;">
              <tr>
                <td style="padding:12px 0;font-size:13px;color:#6d7175;">
                  <strong style="color:#1a1a1a;">Shipping to</strong><br>
                  —<br>
                  —, —<br>
                  —, —<br>
                  —
                </td>
              </tr>
            </table>

            <div style="text-align:center;margin:24px 0 8px 0;">
              <a href="{{tracking_url}}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:15px;font-weight:500;">View your order</a>
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:0 32px 32px 32px;text-align:center;font-size:12px;color:#6d7175;line-height:1.6;">
            <div style="border-top:1px solid #e1e3e5;padding-top:16px;">
              Questions? Reply to this email or write to <a href="mailto:support@authenlondon.com" style="color:#6d7175;">support@authenlondon.com</a>.<br>
              Can't find our emails? Check your spam folder and add us to your contacts.<br><br>
              AuthenLondon · 35 Weir Rd, London SW12 0NU, United Kingdom<br>
              You're receiving this because you placed an order with us.
            </div>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>

</body>
</html>`,
  },
  {
    eventKey: 'order_shipped',
    subject: 'Order {{order_number}} is on its way',
    htmlBody: `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Order {{order_number}} shipped</title>
  <style>
    @media only screen and (max-width: 600px) {
      table[role="presentation"] { width: 100% !important; max-width: 100% !important; }
      body, td, p, div { font-size: 15px !important; }
    }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a !important; color: #ffffff !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;">

<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#f6f6f7;line-height:1px;">
  Your order {{order_number}} has been dispatched. Tracking is available below.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f7;padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">

        <tr>
          <td align="center" style="padding:32px 32px 0 32px;">
            
              <img src="https://cdn.shopify.com/s/files/1/0740/4185/1997/files/ChatGPT_Image_8_de_jul._de_2026_09_00_27_1_450x.png?v=1783512846" alt="AuthenLondon" width="140" style="display:block;border:0;max-width:140px;height:auto;">
            
          </td>
        </tr>

        <tr>
          <td style="padding:32px;">
            <div style="font-size:28px;line-height:1.2;font-weight:600;margin:0 0 8px 0;">On its way, {{customer_name}} 📦</div>
            <p style="font-size:16px;line-height:1.5;margin:0 0 24px 0;color:#3b3d40;">
              Your order <strong>{{order_number}}</strong> has been dispatched from our warehouse.
              Estimated delivery: <strong>—</strong>.
            </p>

            
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e1e3e5;border-radius:8px;padding:16px;margin-bottom:16px;">
              <tr>
                <td style="padding:6px 0;font-size:14px;color:#6d7175;">Carrier</td>
                <td align="right" style="padding:6px 0;font-size:14px;">{{tracking_company}}</td>
              </tr>
              <tr>
                <td style="padding:6px 0;font-size:14px;color:#6d7175;">Tracking number</td>
                <td align="right" style="padding:6px 0;font-size:14px;font-family:'SF Mono',Menlo,Consolas,monospace;">{{tracking_number}}</td>
              </tr>
            </table>
            

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e1e3e5;border-radius:8px;padding:16px;margin-bottom:16px;">
              
            </table>

            
            <div style="text-align:center;margin:24px 0 8px 0;">
              <a href="{{tracking_url}}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:15px;font-weight:500;">Track your parcel</a>
            </div>
            
            <div style="text-align:center;margin:24px 0 8px 0;">
              <a href="{{tracking_url}}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:15px;font-weight:500;">View your order</a>
            </div>
            
          </td>
        </tr>

        <tr>
          <td style="padding:0 32px 32px 32px;text-align:center;font-size:12px;color:#6d7175;line-height:1.6;">
            <div style="border-top:1px solid #e1e3e5;padding-top:16px;">
              Questions? Reply to this email or write to <a href="mailto:support@authenlondon.com" style="color:#6d7175;">support@authenlondon.com</a>.<br>
              Can't find our emails? Check your spam folder and add us to your contacts.<br><br>
              AuthenLondon · 35 Weir Rd, London SW12 0NU, United Kingdom
            </div>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>

</body>
</html>`,
  },
  {
    eventKey: 'shipping_update',
    subject: 'Tracking update for order {{order_number}}',
    htmlBody: `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Tracking update for order {{order_number}}</title>
  <style>
    @media only screen and (max-width: 600px) {
      table[role="presentation"] { width: 100% !important; max-width: 100% !important; }
      body, td, p, div { font-size: 15px !important; }
    }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a !important; color: #ffffff !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;">

<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#f6f6f7;line-height:1px;">
  Updated tracking for your order {{order_number}}: {{tracking_company}} {{tracking_number}}.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f7;padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">

        <tr>
          <td align="center" style="padding:32px 32px 0 32px;">
            
              <img src="https://cdn.shopify.com/s/files/1/0740/4185/1997/files/ChatGPT_Image_8_de_jul._de_2026_09_00_27_1_450x.png?v=1783512846" alt="AuthenLondon" width="140" style="display:block;border:0;max-width:140px;height:auto;">
            
          </td>
        </tr>

        <tr>
          <td style="padding:32px;">
            <div style="font-size:28px;line-height:1.2;font-weight:600;margin:0 0 8px 0;">Tracking update, {{customer_name}} 📮</div>
            <p style="font-size:16px;line-height:1.5;margin:0 0 24px 0;color:#3b3d40;">
              We have an updated tracking for your order <strong>{{order_number}}</strong>. Here are the latest carrier details.
              Estimated delivery: <strong>—</strong>.
            </p>

            
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e1e3e5;border-radius:8px;padding:16px;margin-bottom:16px;">
              <tr>
                <td style="padding:6px 0;font-size:14px;color:#6d7175;">Carrier</td>
                <td align="right" style="padding:6px 0;font-size:14px;">{{tracking_company}}</td>
              </tr>
              <tr>
                <td style="padding:6px 0;font-size:14px;color:#6d7175;">Tracking number</td>
                <td align="right" style="padding:6px 0;font-size:14px;font-family:'SF Mono',Menlo,Consolas,monospace;">{{tracking_number}}</td>
              </tr>
            </table>
            

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e1e3e5;border-radius:8px;padding:16px;margin-bottom:16px;">
              
            </table>

            
            <div style="text-align:center;margin:24px 0 8px 0;">
              <a href="{{tracking_url}}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:15px;font-weight:500;">Track your parcel</a>
            </div>
            
            <div style="text-align:center;margin:24px 0 8px 0;">
              <a href="{{tracking_url}}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:15px;font-weight:500;">View your order</a>
            </div>
            
          </td>
        </tr>

        <tr>
          <td style="padding:0 32px 32px 32px;text-align:center;font-size:12px;color:#6d7175;line-height:1.6;">
            <div style="border-top:1px solid #e1e3e5;padding-top:16px;">
              Questions? Reply to this email or write to <a href="mailto:support@authenlondon.com" style="color:#6d7175;">support@authenlondon.com</a>.<br>
              Can't find our emails? Check your spam folder and add us to your contacts.<br><br>
              AuthenLondon · 35 Weir Rd, London SW12 0NU, United Kingdom
            </div>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>

</body>
</html>`,
  },
  {
    eventKey: 'out_for_delivery',
    subject: 'Your order {{order_number}} is out for delivery today',
    htmlBody: `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Order {{order_number}} out for delivery</title>
  <style>
    @media only screen and (max-width: 600px) {
      table[role="presentation"] { width: 100% !important; max-width: 100% !important; }
      body, td, p, div { font-size: 15px !important; }
    }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a !important; color: #ffffff !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;">

<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#f6f6f7;line-height:1px;">
  Your order {{order_number}} is with the courier today. Track live below.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f7;padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">

        <tr>
          <td align="center" style="padding:32px 32px 0 32px;">
            
              <img src="https://cdn.shopify.com/s/files/1/0740/4185/1997/files/ChatGPT_Image_8_de_jul._de_2026_09_00_27_1_450x.png?v=1783512846" alt="AuthenLondon" width="140" style="display:block;border:0;max-width:140px;height:auto;">
            
          </td>
        </tr>

        <tr>
          <td style="padding:32px;">
            <div style="font-size:28px;line-height:1.2;font-weight:600;margin:0 0 8px 0;">Out for delivery today, {{customer_name}} 🚚</div>
            <p style="font-size:16px;line-height:1.5;margin:0 0 24px 0;color:#3b3d40;">
              Great news — your order <strong>{{order_number}}</strong> is with the courier today.
              Expected delivery: <strong>—</strong>.
              Please keep an eye out for the driver.
            </p>

            
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e1e3e5;border-radius:8px;padding:16px;margin-bottom:16px;">
              <tr>
                <td style="padding:6px 0;font-size:14px;color:#6d7175;">Carrier</td>
                <td align="right" style="padding:6px 0;font-size:14px;">{{tracking_company}}</td>
              </tr>
              <tr>
                <td style="padding:6px 0;font-size:14px;color:#6d7175;">Tracking number</td>
                <td align="right" style="padding:6px 0;font-size:14px;font-family:'SF Mono',Menlo,Consolas,monospace;">{{tracking_number}}</td>
              </tr>
            </table>
            

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e1e3e5;border-radius:8px;padding:16px;margin-bottom:16px;">
              
            </table>

            
            <div style="text-align:center;margin:24px 0 8px 0;">
              <a href="{{tracking_url}}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:15px;font-weight:500;">Track your parcel</a>
            </div>
            
            <div style="text-align:center;margin:24px 0 8px 0;">
              <a href="{{tracking_url}}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:15px;font-weight:500;">View your order</a>
            </div>
            
          </td>
        </tr>

        <tr>
          <td style="padding:0 32px 32px 32px;text-align:center;font-size:12px;color:#6d7175;line-height:1.6;">
            <div style="border-top:1px solid #e1e3e5;padding-top:16px;">
              Questions? Reply to this email or write to <a href="mailto:support@authenlondon.com" style="color:#6d7175;">support@authenlondon.com</a>.<br>
              Can't find our emails? Check your spam folder and add us to your contacts.<br><br>
              AuthenLondon · 35 Weir Rd, London SW12 0NU, United Kingdom
            </div>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>

</body>
</html>`,
  },
  {
    eventKey: 'delivered',
    subject: 'Order {{order_number}} delivered',
    htmlBody: `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Order {{order_number}} delivered</title>
  <style>
    @media only screen and (max-width: 600px) {
      table[role="presentation"] { width: 100% !important; max-width: 100% !important; }
      body, td, p, div { font-size: 15px !important; }
    }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a !important; color: #ffffff !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;">

<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#f6f6f7;line-height:1px;">
  Your order {{order_number}} has been delivered. Anything not right? Reply to this email.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f7;padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">

        <tr>
          <td align="center" style="padding:32px 32px 0 32px;">
            
              <img src="https://cdn.shopify.com/s/files/1/0740/4185/1997/files/ChatGPT_Image_8_de_jul._de_2026_09_00_27_1_450x.png?v=1783512846" alt="AuthenLondon" width="140" style="display:block;border:0;max-width:140px;height:auto;">
            
          </td>
        </tr>

        <tr>
          <td style="padding:32px;">
            <div style="font-size:28px;line-height:1.2;font-weight:600;margin:0 0 8px 0;">Delivered, {{customer_name}} ✅</div>
            <p style="font-size:16px;line-height:1.5;margin:0 0 24px 0;color:#3b3d40;">
              Your order <strong>{{order_number}}</strong> has been delivered. We hope you love it.
              If anything is not right, simply reply to this email within 30 days and our team will help.
            </p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e1e3e5;border-radius:8px;padding:16px;margin-bottom:16px;">
              
            </table>

            <div style="text-align:center;margin:24px 0 8px 0;">
              <a href="{{tracking_url}}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:15px;font-weight:500;">View your order</a>
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:0 32px 32px 32px;text-align:center;font-size:12px;color:#6d7175;line-height:1.6;">
            <div style="border-top:1px solid #e1e3e5;padding-top:16px;">
              Questions? Reply to this email or write to <a href="mailto:support@authenlondon.com" style="color:#6d7175;">support@authenlondon.com</a>.<br>
              Can't find our emails? Check your spam folder and add us to your contacts.<br><br>
              AuthenLondon · 35 Weir Rd, London SW12 0NU, United Kingdom
            </div>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>

</body>
</html>`,
  },
  {
    eventKey: 'order_cancelled',
    subject: 'Order {{order_number}} cancelled',
    htmlBody: `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Order {{order_number}} cancelled</title>
  <style>
    @media only screen and (max-width: 600px) {
      table[role="presentation"] { width: 100% !important; max-width: 100% !important; }
      body, td, p, div { font-size: 15px !important; }
    }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a !important; color: #ffffff !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;">

<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#f6f6f7;line-height:1px;">
  Your order {{order_number}} has been cancelled. Any charges will be reversed.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f7;padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">

        <tr>
          <td align="center" style="padding:32px 32px 0 32px;">
            
              <img src="https://cdn.shopify.com/s/files/1/0740/4185/1997/files/ChatGPT_Image_8_de_jul._de_2026_09_00_27_1_450x.png?v=1783512846" alt="AuthenLondon" width="140" style="display:block;border:0;max-width:140px;height:auto;">
            
          </td>
        </tr>

        <tr>
          <td style="padding:32px;">
            <div style="font-size:28px;line-height:1.2;font-weight:600;margin:0 0 8px 0;">Order cancelled</div>
            <p style="font-size:16px;line-height:1.5;margin:0 0 16px 0;color:#3b3d40;">
              Hello {{customer_name}},
            </p>
            <p style="font-size:16px;line-height:1.5;margin:0 0 24px 0;color:#3b3d40;">
              Your order <strong>{{order_number}}</strong> has been cancelled. Any charges made will be reversed, and we will confirm the details in a separate email within 1 business day.
            </p>

            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e1e3e5;border-radius:8px;padding:16px;margin-bottom:16px;">
              
              <tr><td colspan="2" style="border-top:1px solid #e1e3e5;padding-top:8px;"></td></tr>
              <tr>
                <td style="padding:8px 0 0 0;font-size:15px;font-weight:600;">Total</td>
                <td align="right" style="padding:8px 0 0 0;font-size:15px;font-weight:600;">—</td>
              </tr>
            </table>

            <p style="font-size:14px;line-height:1.5;margin:16px 0 0 0;color:#6d7175;">
              If this cancellation was unexpected or you have any questions, simply reply to this email — our team will help.
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:0 32px 32px 32px;text-align:center;font-size:12px;color:#6d7175;line-height:1.6;">
            <div style="border-top:1px solid #e1e3e5;padding-top:16px;">
              Questions? Reply to this email or write to <a href="mailto:support@authenlondon.com" style="color:#6d7175;">support@authenlondon.com</a>.<br>
              Can't find our emails? Check your spam folder and add us to your contacts.<br><br>
              AuthenLondon · 35 Weir Rd, London SW12 0NU, United Kingdom
            </div>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>

</body>
</html>`,
  },
];

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    process.stderr.write('✖ DATABASE_URL is required\n');
    process.exit(1);
  }
  const storeId = (process.env['STORE_ID'] ?? 'default').trim();

  const { db, sql: pgSql } = createClient({ databaseUrl });
  try {
    for (const tpl of DEFAULT_TEMPLATES) {
      await db
        .insert(emailTemplates)
        .values({
          storeId,
          eventKey: tpl.eventKey,
          subject: tpl.subject,
          htmlBody: tpl.htmlBody,
          enabled: true,
        })
        .onConflictDoUpdate({
          target: [emailTemplates.storeId, emailTemplates.eventKey],
          set: {
            subject: tpl.subject,
            htmlBody: tpl.htmlBody,
            // Don't touch `enabled` on update — the operator may have toggled
            // a template off in the backoffice and we don't want to override.
            updatedAt: sql`now()`,
          },
        });
      process.stdout.write(`✓ ${storeId}/${tpl.eventKey}\n`);
    }
    process.stdout.write(`\nDone. Seeded ${DEFAULT_TEMPLATES.length} templates for store '${storeId}'.\n`);
  } finally {
    await pgSql.end();
  }
}

// Só roda `main()` quando o arquivo é executado diretamente. Import via
// `import ... from '.../seed-email-templates.ts'` (feito pelos testes)
// não dispara efeito colateral.
const isMain = process.argv[1]?.includes('seed-email-templates');
if (isMain) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`✖ ${msg}\n`);
    process.exit(1);
  });
}
