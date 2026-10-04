const express = require('express');
const supabase = require('../db');

const router = express.Router();

// ============================================
// POST /api/webhooks/stripe — Stripe payment events
// The older address. It runs the one handler in routes/stripe.js
// (/api/stripe/webhook), which claims each event id first, so an event Stripe
// posts to both addresses is processed once. (The branches this route used to
// carry on its own — an `orders` table that does not exist and a
// businesses.plan update keyed on subscription metadata nothing here sets —
// were dead; the booking and platform-billing branches are the shared ones.)
// ============================================
router.post('/stripe', express.raw({ type: 'application/json' }), (req, res) => require('./stripe').handleStripeWebhook(req, res));

// ============================================
// POST /api/webhooks/twilio — Twilio SMS events
// ============================================
router.post('/twilio', express.urlencoded({ extended: false }), async (req, res) => {
    const { From, To, Body, MessageSid, SmsStatus } = req.body;

    console.log(`Twilio webhook: ${SmsStatus} from ${From}`);

    if (SmsStatus === 'received' && Body) {
        // TCPA: Handle STOP / opt-out keywords
        const bodyUpper = (Body || '').trim().toUpperCase();
        if (['STOP', 'UNSUBSCRIBE', 'CANCEL', 'QUIT', 'END'].includes(bodyUpper)) {
            await supabase.from('sms_opt_outs').upsert({
                phone: From,
                site_id: null  // null = opted out of all businesses on shared number
            }, { onConflict: 'phone,site_id' }).catch(() => {});

            await supabase.from('sms_log').insert({
                site_id: null,
                to_phone: From,
                message: Body,
                type: 'opt_out',
                status: 'received'
            }).catch(() => {});

            return res.status(200).send('<Response><Message>You have been unsubscribed. Reply START to resubscribe.</Message></Response>');
        }

        // Handle START / re-subscribe
        if (bodyUpper === 'START') {
            await supabase.from('sms_opt_outs')
                .delete()
                .eq('phone', From)
                .catch(() => {});

            return res.status(200).send('<Response><Message>You have been resubscribed and will receive messages again.</Message></Response>');
        }

        // Incoming SMS — find which business this phone number belongs to
        const { data: content } = await supabase
            .from('site_content')
            .select('site_id, contact_phone')
            .eq('contact_phone', To)
            .single();

        if (content) {
            // Log the incoming message
            await supabase.from('sms_log').insert({
                site_id: content.site_id,
                to_phone: To,
                message: Body,
                type: 'incoming',
                status: 'received'
            });

            // Create notification
            await supabase.from('notifications').insert({
                site_id: content.site_id,
                type: 'sms_received',
                title: `SMS from ${From}`,
                body: Body,
                metadata: { from: From, message_sid: MessageSid }
            }).catch(() => {});

            // TODO: Emit event: message.received
            // TODO: Check if AI auto-reply is enabled
        }
    }

    // Twilio expects empty 200 response
    res.status(200).send('<Response></Response>');
});

// ============================================
// POST /api/webhooks/google — Google Business events
// ============================================
router.post('/google', async (req, res) => {
    console.log('Google webhook:', req.body);

    // TODO: Handle Google Business Profile notifications
    // - New review posted
    // - New question asked
    // - Business info updated externally

    res.json({ received: true });
});

module.exports = router;
