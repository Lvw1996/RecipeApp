import nodemailer from 'nodemailer';

// ── Transport (lazy singleton) ────────────────────────────────────────────────
// Configure via Railway env vars:
//
//   SMTP_HOST  — e.g. mail.setpixel.eu   (your hosting provider's mail server)
//   SMTP_PORT  — 587 (STARTTLS, recommended) or 465 (SSL)
//   SMTP_USER  — full email address, e.g. support@setpixel.eu
//   SMTP_PASS  — email account password
//   SMTP_FROM  — display name + address, e.g. "Recipe App <support@setpixel.eu>"

let _transport;

function getTransport(overrides = {}) {
  if (_transport && !Object.keys(overrides).length) return _transport;

  const port   = Number(overrides.port ?? process.env.SMTP_PORT ?? 587);
  const secure = overrides.secure !== undefined
    ? overrides.secure === 'true' || overrides.secure === true
    : port === 465;

  const transport = nodemailer.createTransport({
    host:       overrides.host ?? process.env.SMTP_HOST,
    port,
    secure,
    requireTLS: !secure, // force STARTTLS upgrade on port 587
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: {
      // Accept self-signed / mismatched certs common on shared hosting
      rejectUnauthorized: false,
    },
    connectionTimeout: 15_000,
    greetingTimeout:   10_000,
  });

  if (!Object.keys(overrides).length) _transport = transport;
  return transport;
}

// ── Diagnostic (call GET /auth/smtp-test to verify connection) ────────────────
export async function testSmtpConnection(overrides = {}) {
  const t = getTransport(overrides);
  const config = {
    host:   overrides.host   ?? process.env.SMTP_HOST,
    port:   Number(overrides.port ?? process.env.SMTP_PORT ?? 587),
    user:   process.env.SMTP_USER,
    secure: overrides.secure !== undefined
      ? overrides.secure === 'true' || overrides.secure === true
      : Number(overrides.port ?? process.env.SMTP_PORT ?? 587) === 465,
    requireTLS: !(overrides.secure !== undefined
      ? overrides.secure === 'true' || overrides.secure === true
      : Number(overrides.port ?? process.env.SMTP_PORT ?? 587) === 465),
  };
  try {
    await t.verify();
    return { ok: true, config };
  } catch (err) {
    return { ok: false, error: err.message, config };
  }
}

export async function sendPasswordResetEmail(toEmail, rawToken) {
  const from    = process.env.SMTP_FROM || process.env.SMTP_USER;
  const appLink = `recipeapp://reset-password?token=${encodeURIComponent(rawToken)}&email=${encodeURIComponent(toEmail)}`;

  await getTransport().sendMail({
    from,
    to:      toEmail,
    subject: 'Reset your Recipe App password',

    // ── Plain-text fallback ───────────────────────────────────────────────
    text: [
      'Reset your Recipe App password',
      '',
      'Tap the link below on your phone to open the app and set a new password.',
      'This link expires in 30 minutes.',
      '',
      appLink,
      '',
      "If you didn't request this, ignore this email — your password won't change.",
    ].join('\n'),

    // ── HTML ──────────────────────────────────────────────────────────────
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Reset your password</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:48px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border-radius:16px;padding:40px 36px;box-shadow:0 1px 4px rgba(0,0,0,0.08);">

        <!-- Logo / icon -->
        <tr><td align="center" style="padding-bottom:28px;">
          <div style="width:56px;height:56px;border-radius:14px;background:#fff3e8;display:inline-flex;align-items:center;justify-content:center;font-size:28px;line-height:56px;">🍳</div>
        </td></tr>

        <!-- Heading -->
        <tr><td style="padding-bottom:12px;">
          <h1 style="margin:0;font-size:22px;font-weight:700;color:#111827;text-align:center;">Reset your password</h1>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding-bottom:32px;">
          <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#4b5563;text-align:center;">
            We received a request to reset the password for your Recipe App account.
          </p>
          <p style="margin:0;font-size:15px;line-height:1.6;color:#4b5563;text-align:center;">
            Tap the button below on your phone to open the app and choose a new password.<br>
            <strong>This link expires in 30 minutes.</strong>
          </p>
        </td></tr>

        <!-- CTA button -->
        <tr><td align="center" style="padding-bottom:32px;">
          <a href="${appLink}"
             style="display:inline-block;background:#e85d04;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:14px 36px;border-radius:10px;letter-spacing:0.01em;">
            Set New Password
          </a>
        </td></tr>

        <!-- Divider -->
        <tr><td style="border-top:1px solid #e5e7eb;padding-top:24px;">
          <p style="margin:0;font-size:13px;color:#9ca3af;text-align:center;">
            Didn't request this? You can safely ignore this email.<br>Your password won't change.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}
