const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_API_URL = 'https://api.resend.com/emails';
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const FROM_NAME = process.env.FROM_NAME || 'Gulf Coast Radar';

async function sendEmail(to, subject, htmlBody, textBody) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set, skipping email send');
    return { success: true, message: 'Email service not configured' };
  }

  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: [to],
        subject,
        html: htmlBody,
        text: textBody || undefined,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Resend error:', data);
      return { success: false, error: data.message, message: 'Failed to send email' };
    }

    return { success: true, messageId: data.id, message: 'Email sent successfully' };
  } catch (error) {
    console.error('Error sending email:', error.message);
    return { success: false, error: error.message, message: 'Failed to send email' };
  }
}

async function sendVerificationEmail(email, code) {
  const subject = 'Verify Your Gulf Coast Radar Account';
  const htmlBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #0b7a75;">Welcome to Gulf Coast Radar</h2>
      <p>Your verification code is:</p>
      <div style="background: #f5f5f5; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px;">
        <h1 style="color: #0d2137; letter-spacing: 5px; margin: 0;">${code}</h1>
      </div>
      <p>This code expires in 10 minutes. Do not share this code with anyone.</p>
      <p style="color: #999; font-size: 12px;">If you didn't request this code, you can safely ignore this email.</p>
    </div>
  `;

  return sendEmail(email, subject, htmlBody);
}

async function sendPasswordResetEmail(email, resetToken) {
  const resetUrl = `${process.env.APP_URL || 'https://gcr-unified.vercel.app'}/reset?token=${resetToken}`;

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #0b7a75;">Reset Your Password</h2>
      <p>We received a request to reset your password. Click the button below to create a new password:</p>
      <div style="text-align: center; margin: 20px 0;">
        <a href="${resetUrl}" style="background: #14B8A6; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; display: inline-block;">Reset Password</a>
      </div>
      <p>Or copy this link into your browser:</p>
      <p style="word-break: break-all; color: #0b7a75;">${resetUrl}</p>
      <p style="color: #999; font-size: 12px;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
    </div>
  `;

  return sendEmail(email, 'Reset Your Gulf Coast Radar Password', htmlBody);
}

module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
};
