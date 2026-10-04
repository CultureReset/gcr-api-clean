// ============================================================
// POST /api/telephony/telnyx/say — speak one message, then hang up
// ============================================================
//
// The Call Control webhook for calls placed with telephony.placeCall({ say }):
// a claim code read to a landline, for one. Telnyx posts each event of the
// call here; the message rides in client_state, which Telnyx echoes back and
// which only Telnyx can send, because every request must carry a valid
// Ed25519 signature (TELNYX_PUBLIC_KEY).
//
//   call.answered     speak the message
//   call.speak.ended  speak it once more, then hang up
//
// Stateless, so it works anywhere this API runs. This is NOT the live voice
// handler (/api/telephony/telnyx/voice), which answers conversations.

const express = require('express');
const telephony = require('../lib/telephony');

const router = express.Router();

// How many times the message is read before hanging up.
const repeats = () => Math.max(1, Number(process.env.TELEPHONY_SAY_REPEATS) || 2);

router.post('/', async (req, res) => {
    const check = telephony.verifyWebhook(req, { provider: 'telnyx' });
    if (!check.ok) return res.status(401).json({ error: check.reason });

    const event = req.body?.data?.event_type;
    const payload = req.body?.data?.payload || {};
    const callId = payload.call_control_id;
    const state = telephony.decodeClientState(payload.client_state) || {};

    // Acknowledge first: Telnyx retries a slow webhook, and a retried
    // call.answered would read the message twice over itself.
    res.status(200).json({ received: true });
    if (!callId || !state.say) return;

    try {
        if (event === 'call.answered') {
            await telephony.speak({ callId, text: state.say, clientState: { ...state, n: 1 } });
        } else if (event === 'call.speak.ended') {
            if ((state.n || 1) < repeats()) {
                await telephony.speak({ callId, text: state.say, clientState: { ...state, n: (state.n || 1) + 1 } });
            } else {
                await telephony.hangup({ callId });
            }
        }
    } catch (err) {
        console.error('[telephony-say]', event, err.message);
    }
});

module.exports = router;
