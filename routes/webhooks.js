const express = require('express');
const supabase = require('../db');

const router = express.Router();

// ============================================
// POST /api/webhooks/stripe — Stripe payment events
// ============================================
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    let event;
    let verified = false;

    // Verify Stripe webhook signature when secret is configured
    if (process.env.STRIPE_WEBHOOK_SECRET && process.env.STRIPE_SECRET_KEY) {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const sig = req.headers['stripe-signature'];
        try {
            // express.json() runs first (server.js), so req.body is already an
            // object here; the signature is over the raw bytes it kept.
            event = stripe.webhooks.constructEvent(req.rawBody || req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
            verified = true;
        } catch (err) {
            console.error('Stripe webhook signature failed:', err.message);
            return res.status(400).json({ error: 'Invalid signature' });
        }
    } else {
        // Fallback: parse without verification (dev only)
        try {
            event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        } catch (err) {
            return res.status(400).json({ error: 'Invalid JSON' });
        }
    }

    const type = event.type;
    const data = event.data?.object;

    console.log(`Stripe webhook: ${type}`);

    // Platform billing (subscription and invoice events, lib/billingStripe.js).
    // Only from a verified signature: an unsigned invoice.paid must not be able
    // to lift a pause.
    if (verified) {
        try {
            const applied = await require('../lib/billingStripe').applyStripeEvent(event);
            if (applied) return res.json({ received: true, billing: applied });
        } catch (err) {
            console.error('[billing webhook]', type, err.message);
            return res.status(500).json({ error: 'billing update failed' });
        }
    }

    switch (type) {
        case 'payment_intent.succeeded': {
            // Update booking/order payment status
            const bookingId = data.metadata?.booking_id;
            const orderId = data.metadata?.order_id;

            if (bookingId) {
                const { error } = await supabase
                    .from('bookings')
                    .update({
                        payment_status: 'paid',
                        payment_id: data.id,
                        payment_provider: 'stripe',
                        status: 'confirmed'
                    })
                    .eq('id', bookingId);
                if (error) console.error('[webhooks/stripe] failed to mark booking paid:', bookingId, error.message);
            }

            // Note: 'orders' table referenced here doesn't exist in the live DB (same
            // gap as public.js/dashboard.js/site.js's own 'orders' reads) -- and nothing
            // in this codebase ever sets metadata.order_id on a real payment intent, so
            // this branch cannot currently fire. Left as-is pending a real orders feature.
            if (orderId) {
                const { error } = await supabase
                    .from('orders')
                    .update({
                        payment_id: data.id,
                        payment_provider: 'stripe',
                        status: 'received'
                    })
                    .eq('id', orderId);
                if (error) console.error('[webhooks/stripe] failed to mark order received:', orderId, error.message);
            }
            break;
        }

        case 'payment_intent.payment_failed': {
            const bookingId = data.metadata?.booking_id;
            if (bookingId) {
                const { error } = await supabase
                    .from('bookings')
                    .update({ payment_status: 'failed' })
                    .eq('id', bookingId);
                if (error) console.error('[webhooks/stripe] failed to mark booking failed:', bookingId, error.message);
            }
            // TODO: Emit event: payment.failed → notify owner
            break;
        }

        case 'charge.refunded': {
            const bookingId = data.metadata?.booking_id;
            if (bookingId) {
                const { error } = await supabase
                    .from('bookings')
                    .update({ payment_status: 'refunded', status: 'cancelled' })
                    .eq('id', bookingId);
                if (error) console.error('[webhooks/stripe] failed to mark booking refunded:', bookingId, error.message);
            }
            break;
        }

        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
            // Platform subscription changes
            const siteId = data.metadata?.site_id;
            const plan = data.metadata?.plan;
            if (siteId && plan) {
                await supabase
                    .from('businesses')
                    .update({ plan })
                    .eq('site_id', siteId);
            }
            break;
        }

        case 'customer.subscription.deleted': {
            // Downgrade to free
            const siteId = data.metadata?.site_id;
            if (siteId) {
                await supabase
                    .from('businesses')
                    .update({ plan: 'free' })
                    .eq('site_id', siteId);
            }
            break;
        }
    }

    res.json({ received: true });
});

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
