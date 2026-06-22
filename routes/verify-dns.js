const express = require('express');
const router = express.Router();
const dns = require('dns').promises;

// ============================================
// POST /api/verify-dns/check — Verify DNS records for a domain
// Body: { domain }
// ============================================
router.post('/check', async (req, res) => {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: 'domain required' });

    const cleanDomain = domain.replace(/^https?:\/\//, '').split('/')[0].trim();
    const records = [];
    let verified = false;

    const resolvers = [
        { type: 'A',     fn: () => dns.resolve4(cleanDomain).then(addrs => addrs.map(v => ({ type: 'A', value: v }))) },
        { type: 'CNAME', fn: () => dns.resolveCname(cleanDomain).then(vals => vals.map(v => ({ type: 'CNAME', value: v }))) },
        { type: 'TXT',   fn: () => dns.resolveTxt(cleanDomain).then(vals => vals.map(v => ({ type: 'TXT', value: v.join('') }))) }
    ];

    for (const resolver of resolvers) {
        try {
            const found = await resolver.fn();
            records.push(...found);
        } catch (e) {
            // Record type not found — skip
        }
    }

    verified = records.length > 0;

    res.json({ domain: cleanDomain, verified, records });
});

// ============================================
// GET /api/verify-dns/status/:domain — Quick DNS check
// ============================================
router.get('/status/:domain', async (req, res) => {
    const cleanDomain = req.params.domain.replace(/^https?:\/\//, '').split('/')[0].trim();

    try {
        const addrs = await dns.resolve4(cleanDomain);
        res.json({ domain: cleanDomain, resolves: true, addresses: addrs });
    } catch (e) {
        try {
            const cnames = await dns.resolveCname(cleanDomain);
            res.json({ domain: cleanDomain, resolves: true, cnames });
        } catch (e2) {
            res.json({ domain: cleanDomain, resolves: false, error: 'No DNS records found' });
        }
    }
});

module.exports = router;
