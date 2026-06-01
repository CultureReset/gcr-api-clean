# Email Verification Setup Guide

## Overview
The GCR platform uses **Brevo** (formerly Sendinblue) for sending verification emails and password reset links. This guide walks through setting it up.

## Prerequisites
- Active Brevo account (free tier available at https://brevo.com)
- Access to your gcr-api-clean Vercel environment

## Step 1: Get Your Brevo API Key

1. Go to https://app.brevo.com/settings/keys/api
2. Click "Create a New API Key" or copy your existing key
3. Keep this key safe - you'll need it for Vercel

## Step 2: Configure Local Development

### Copy the env example:
```bash
cp .env.example .env.local
```

### Edit `.env.local` and add:
```
BREVO_API_KEY=your_api_key_here
FROM_EMAIL=your-email@example.com
FROM_NAME=Gulf Coast Radar
APP_URL=http://localhost:5173
```

### Test locally:
```bash
npm run dev
# Visit http://localhost:5173/auth and sign up to test emails
```

## Step 3: Configure Vercel Environment Variables

1. Go to your **gcr-api-clean** Vercel project
2. Click **Settings** → **Environment Variables**
3. Add these variables:

| Key | Value | Notes |
|-----|-------|-------|
| `BREVO_API_KEY` | Your Brevo API key | Get from https://app.brevo.com/settings/keys/api |
| `FROM_EMAIL` | noreply@gulfcoastcruise.com | Sender email address |
| `FROM_NAME` | Gulf Coast Radar | Sender display name |
| `APP_URL` | https://gcr-unified.vercel.app | Frontend URL for reset links |

4. Click **Save** and redeploy

## Step 4: Test Email Verification

### Test signup verification:
1. Go to https://gcr-unified.vercel.app/auth
2. Enter an email and password
3. Check inbox for verification code
4. Enter code to verify

### Test password reset:
1. Go to https://gcr-unified.vercel.app/reset
2. Enter your email
3. Check inbox for reset link
4. Click link and set new password

## Step 5: Verify in Production

After deploying, check your Brevo dashboard:
1. Go to https://app.brevo.com/dashboard
2. Look for sent emails in the activity log
3. Verify sender email is correct

## Troubleshooting

### Emails not sending?

**Check 1: API Key is valid**
```bash
# In gcr-api-clean Vercel settings, verify BREVO_API_KEY is set
```

**Check 2: Verify sender email is authorized**
- In Brevo, go to Senders & Domain Settings
- Make sure `FROM_EMAIL` is authorized
- You may need to verify the domain

**Check 3: Check Brevo sending limits**
- Free tier: 300 emails/day
- See https://app.brevo.com/settings/billing

**Check 4: Review API error logs**
- In Vercel, check function logs for error details
- Look for BREVO_API_KEY configuration in environment

## Email Templates

### Verification Email
- Subject: "Verify Your Gulf Coast Radar Account"
- Contains: 6-digit code, 10-minute expiry warning
- Recipient: New user signup email

### Password Reset Email  
- Subject: "Reset Your Gulf Coast Radar Password"
- Contains: Direct reset link with token
- Link valid for: 1 hour
- Recipient: User who requested password reset

## Security Notes

1. **API Key**: Store securely in Vercel, never commit to git
2. **Sender Email**: Should be a non-reply email address
3. **Token Expiry**: Verification codes expire in 10 minutes
4. **HTTPS Only**: Reset links only work over HTTPS

## API Reference

### sendVerificationEmail(email, code)
Sends verification code for email confirmation.

```javascript
const { sendVerificationEmail } = require('./utils/email');
await sendVerificationEmail('user@example.com', '123456');
```

### sendPasswordResetEmail(email, token)
Sends password reset link to user.

```javascript
const { sendPasswordResetEmail } = require('./utils/email');
await sendPasswordResetEmail('user@example.com', 'reset_token_xyz');
```

## Production Checklist

- [ ] BREVO_API_KEY added to Vercel environment
- [ ] FROM_EMAIL is verified in Brevo
- [ ] APP_URL points to correct frontend
- [ ] Test signup creates verification email
- [ ] Test password reset sends email
- [ ] Monitor Brevo dashboard for bounce rates
- [ ] Set up Brevo webhook notifications (optional)

## Next Steps

- [ ] Monitor email deliverability
- [ ] Set up Brevo bounce notifications
- [ ] Add email templates to Brevo for consistency
- [ ] Test with real user workflows

---

For questions, contact: support@gulfcoastcruise.com
