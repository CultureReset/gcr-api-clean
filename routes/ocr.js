const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');

function getClient() {
    return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ============================================
// POST /api/ocr/receipt — Extract receipt data via Claude vision
// Body: { image_url } or { image_base64, media_type }
// ============================================
router.post('/receipt', async (req, res) => {
    const { image_url, image_base64, media_type } = req.body;

    if (!image_url && !image_base64) {
        return res.status(400).json({ error: 'image_url or image_base64 required' });
    }

    const client = getClient();

    try {
        let imageSource;
        if (image_url) {
            imageSource = { type: 'url', url: image_url };
        } else {
            imageSource = {
                type: 'base64',
                media_type: media_type || 'image/jpeg',
                data: image_base64
            };
        }

        const response = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'image', source: imageSource },
                        {
                            type: 'text',
                            text: `Extract the receipt data from this image and return a JSON object with these fields:
- merchant: string (store/restaurant name)
- date: string (ISO format if possible, otherwise as printed)
- total: number (final total amount as a number)
- subtotal: number or null
- tax: number or null
- tip: number or null
- items: array of { name: string, quantity: number, price: number }
- payment_method: string or null (cash, credit, debit, etc.)
- currency: string (USD, EUR, etc.)

Return ONLY valid JSON, no markdown, no explanation.`
                        }
                    ]
                }
            ]
        });

        const text = response.content[0]?.text || '';
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            // Try to extract JSON from the response
            const match = text.match(/\{[\s\S]*\}/);
            if (match) {
                parsed = JSON.parse(match[0]);
            } else {
                return res.status(422).json({ error: 'Could not parse receipt data', raw: text });
            }
        }

        res.json({ success: true, receipt: parsed });
    } catch (err) {
        console.error('ocr/receipt error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
