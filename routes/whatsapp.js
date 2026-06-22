const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { authRequired } = require('../middleware/auth');

function getSupabase() {
    return createClient(
        process.env.GCR_SUPABASE_URL,
        process.env.GCR_SUPABASE_SERVICE_KEY
    );
}

// ============================================
// POST /api/whatsapp/connect — Store WhatsApp credentials for site
// ============================================
router.post('/connect', authRequired, async (req, res) => {
    const { token, phone_number_id, business_account_id } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });

    const supabase = getSupabase();
    try {
        const { error } = await supabase.from('whatsapp_connections').upsert({
            site_id: req.siteId,
            access_token: token,
            phone_number_id: phone_number_id || null,
            business_account_id: business_account_id || null,
            status: 'connected',
            connected_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }, { onConflict: 'site_id' });

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        console.error('whatsapp/connect error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// DELETE /api/whatsapp/disconnect — Remove WhatsApp credentials
// ============================================
router.delete('/disconnect', authRequired, async (req, res) => {
    const supabase = getSupabase();
    try {
        const { error } = await supabase
            .from('whatsapp_connections')
            .delete()
            .eq('site_id', req.siteId);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        console.error('whatsapp/disconnect error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// POST /api/whatsapp/send — Send a WhatsApp message
// ============================================
router.post('/send', authRequired, async (req, res) => {
    const { to, message } = req.body;
    if (!to) return res.status(400).json({ error: 'to required' });
    if (!message) return res.status(400).json({ error: 'message required' });

    const supabase = getSupabase();
    try {
        const { data, error } = await supabase
            .from('whatsapp_connections')
            .select('access_token, phone_number_id')
            .eq('site_id', req.siteId)
            .eq('status', 'connected')
            .single();

        if (error || !data) return res.status(400).json({ error: 'WhatsApp not connected for this site' });

        const sendRes = await fetch(
            `https://graph.facebook.com/v19.0/${data.phone_number_id}/messages`,
            {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + data.access_token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    messaging_product: 'whatsapp',
                    to,
                    type: 'text',
                    text: { body: message }
                })
            }
        );

        const sendData = await sendRes.json();
        if (!sendRes.ok) {
            return res.status(400).json({ error: sendData.error?.message || 'Send failed' });
        }

        res.json({ success: true, message_id: sendData.messages?.[0]?.id });
    } catch (err) {
        console.error('whatsapp/send error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// GET /api/whatsapp/status — Check WhatsApp connection status
// ============================================
router.get('/status', authRequired, async (req, res) => {
    const supabase = getSupabase();
    try {
        const { data } = await supabase
            .from('whatsapp_connections')
            .select('status, phone_number_id, business_account_id, connected_at')
            .eq('site_id', req.siteId)
            .maybeSingle();

        res.json({
            connected: data?.status === 'connected',
            phone_number_id: data?.phone_number_id || null,
            business_account_id: data?.business_account_id || null,
            connected_at: data?.connected_at || null
        });
    } catch (err) {
        console.error('whatsapp/status error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
