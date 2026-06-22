// ============================================================
// Live Photo — Verified Customer Food Photos
// Standalone module. Zero coupling to other routes.
//
// POST /api/live-photo
//   Accepts multipart: photo, site_id, table_qr_id, phone, dish_name, points_reward, timestamp
//   1. Validates it's an actual image
//   2. Runs AI check (does this contain food?)
//   3. Uploads to Supabase storage
//   4. Saves record with metadata
//   5. Awards loyalty points to customer (phone)
//   6. Returns photo_url
//
// GET /api/live-photo?site_id=X
//   Returns approved photos for a business (for GCR listing display)
// ============================================================

const express = require('express');
const multer  = require('multer');
const supabase = require('../db');
const getGcrDb = require('../gcr-db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// GET /api/live-photo — public, returns approved photos for a business
router.get('/', async (req, res) => {
    const { site_id, limit = 20 } = req.query;
    if (!site_id) return res.status(400).json({ error: 'site_id required' });

    const { data, error } = await supabase
        .from('customer_live_photos')
        .select('id, photo_url, dish_name, created_at')
        .eq('site_id', site_id)
        .eq('status', 'approved')
        .order('created_at', { ascending: false })
        .limit(parseInt(limit) || 20);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
});

// POST /api/live-photo — upload a verified live photo
router.post('/', upload.single('photo'), async (req, res) => {
    const { site_id, table_qr_id, phone, dish_name, points_reward, timestamp, send_review, business_name, review_delay_minutes } = req.body;

    if (!req.file)  return res.status(400).json({ error: 'Photo required' });
    if (!site_id)   return res.status(400).json({ error: 'site_id required' });
    if (!phone)     return res.status(400).json({ error: 'Phone required' });

    const cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length < 10) return res.status(400).json({ error: 'Invalid phone' });

    // Validate it's actually an image
    const mime = req.file.mimetype || '';
    if (!mime.startsWith('image/')) return res.status(400).json({ error: 'File must be an image' });

    try {
        // ── AI food check (fast, optional — skip if no key) ────────
        let aiApproved = true; // default: approve
        let aiLabel = 'unverified';
        const anthropicKey = process.env.ANTHROPIC_API_KEY;
        if (anthropicKey) {
            try {
                const b64 = req.file.buffer.toString('base64');
                const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
                    body: JSON.stringify({
                        model: 'claude-haiku-4-5-20251001',
                        max_tokens: 50,
                        messages: [{ role: 'user', content: [
                            { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
                            { type: 'text', text: 'Does this image contain food, a drink, or a restaurant meal? Reply with only: YES or NO' },
                        ]}],
                    }),
                });
                if (aiRes.ok) {
                    const aiData = await aiRes.json();
                    const answer = (aiData.content?.[0]?.text || '').trim().toUpperCase();
                    aiApproved = answer.startsWith('YES');
                    aiLabel = aiApproved ? 'food_verified' : 'no_food';
                }
            } catch(e) { /* non-fatal — default approve */ }
        }

        // ── Upload to Supabase Storage ─────────────────────────────
        const dateStr  = new Date().toISOString().split('T')[0];
        const fileName = `live-photos/${site_id}/${dateStr}/${Date.now()}_${cleanPhone.slice(-4)}.jpg`;
        const { error: upErr } = await supabase.storage
            .from('customer-photos')
            .upload(fileName, req.file.buffer, { contentType: 'image/jpeg', upsert: false });

        if (upErr) {
            // If bucket doesn't exist, create it first
            if (upErr.message && upErr.message.includes('not found')) {
                await supabase.storage.createBucket('customer-photos', { public: true }).catch(() => {});
                await supabase.storage.from('customer-photos').upload(fileName, req.file.buffer, { contentType: 'image/jpeg', upsert: true });
            } else {
                throw new Error(upErr.message);
            }
        }

        const { data: { publicUrl } } = supabase.storage.from('customer-photos').getPublicUrl(fileName);

        // ── Save record ────────────────────────────────────────────
        const status = aiApproved ? 'approved' : 'pending_review';
        const { data: photoRecord } = await supabase.from('customer_live_photos').insert({
            site_id,
            table_qr_id: table_qr_id || null,
            phone: cleanPhone,
            dish_name: dish_name || null,
            photo_url: publicUrl,
            ai_label: aiLabel,
            status,
            points_awarded: parseInt(points_reward) || 0,
            captured_at: timestamp || new Date().toISOString(),
        }).select().single();

        // ── Award loyalty points ───────────────────────────────────
        const pts = parseInt(points_reward) || 0;
        if (pts > 0) {
            const { data: customer } = await supabase.from('customers')
                .select('id, loyalty_points')
                .eq('phone', cleanPhone)
                .eq('site_id', site_id)
                .maybeSingle();

            if (customer) {
                await supabase.from('customers')
                    .update({ loyalty_points: (customer.loyalty_points || 0) + pts })
                    .eq('id', customer.id);
            } else {
                // Create customer
                const loyaltyNum = 'LOYAL' + String(Math.floor(100000 + Math.random() * 900000));
                await supabase.from('customers').insert({
                    phone: cleanPhone, site_id,
                    loyalty_number: loyaltyNum,
                    loyalty_points: pts,
                    source: 'live_photo',
                    tier: 'standard',
                });
            }
        }

        // ── Send review request via SMS ────────────────────────────
        // Fire-and-forget after delay. The photo proves they were there —
        // so this review is 100% verified before it's even written.
        if (send_review === 'true' || send_review === true) {
            const sid  = process.env.TWILIO_ACCOUNT_SID;
            const tok  = process.env.TWILIO_AUTH_TOKEN;
            const from = process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_FROM_NUMBER;
            if (sid && tok && from) {
                const delayMs = Math.max(0, parseInt(review_delay_minutes) || 0) * 60 * 1000;
                const bizName = business_name || 'us';
                const reviewUrl = `https://cybercheck-links.vercel.app/review.html?site=${site_id}&phone=${cleanPhone}${photoRecord?.id ? '&photo=' + photoRecord.id : ''}`;
                const smsBody = `Thanks for dining with ${bizName}! 🙏\n\nYour photo is live on our menu. Mind leaving a quick review? It only takes 30 seconds and helps other visitors:\n\n${reviewUrl}`;

                setTimeout(async () => {
                    try {
                        const twilio = require('twilio')(sid, tok);
                        await twilio.messages.create({ body: smsBody, from, to: '+1' + cleanPhone });
                    } catch(e) { console.error('review SMS error:', e.message); }
                }, delayMs);
            }
        }

        res.json({
            ok: true,
            id: photoRecord?.id,
            photo_url: publicUrl,
            status,
            ai_label: aiLabel,
            points_awarded: pts,
            review_requested: !!(send_review === 'true' || send_review === true),
            message: status === 'approved'
                ? 'Photo live on the menu listing!'
                : 'Photo submitted — will be reviewed shortly.',
        });

    } catch(err) {
        console.error('live-photo error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/live-photo/:id — approve or reject (admin)
router.put('/:id', async (req, res) => {
    const { status } = req.body; // 'approved' | 'rejected'
    if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'status must be approved or rejected' });
    const { error } = await supabase.from('customer_live_photos').update({ status }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
});

// DELETE /api/live-photo/:id — remove (admin or restaurant)
router.delete('/:id', async (req, res) => {
    const { error } = await supabase.from('customer_live_photos').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
});

module.exports = router;
