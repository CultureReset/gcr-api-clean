const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { authRequired } = require('../middleware/auth');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function getSupabase() {
    return createClient(
        process.env.GCR_SUPABASE_URL,
        process.env.GCR_SUPABASE_SERVICE_KEY
    );
}

// ============================================
// POST /api/voice-notes/upload — Upload audio file
// ============================================
router.post('/upload', authRequired, upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'audio file required' });

    const supabase = getSupabase();
    try {
        const ext = req.file.originalname?.split('.').pop() || 'webm';
        const fileName = `voice-notes/${req.siteId}/${Date.now()}.${ext}`;

        const { error: uploadError } = await supabase.storage
            .from('entity-media')
            .upload(fileName, req.file.buffer, {
                contentType: req.file.mimetype || 'audio/webm',
                upsert: false
            });

        if (uploadError) throw uploadError;

        const { data: urlData } = supabase.storage.from('entity-media').getPublicUrl(fileName);
        const publicUrl = urlData?.publicUrl;

        const { data: record, error: dbError } = await supabase
            .from('voice_notes')
            .insert({
                site_id: req.siteId,
                url: publicUrl,
                file_name: fileName,
                mime_type: req.file.mimetype || 'audio/webm',
                size_bytes: req.file.size,
                created_at: new Date().toISOString()
            })
            .select('id, url, created_at')
            .single();

        if (dbError) throw dbError;

        res.json({ success: true, id: record.id, url: record.url, created_at: record.created_at });
    } catch (err) {
        console.error('voice-notes/upload error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// GET /api/voice-notes/:id — Get voice note by ID
// ============================================
router.get('/:id', authRequired, async (req, res) => {
    const supabase = getSupabase();
    try {
        const { data, error } = await supabase
            .from('voice_notes')
            .select('id, url, file_name, mime_type, size_bytes, created_at')
            .eq('id', req.params.id)
            .eq('site_id', req.siteId)
            .single();

        if (error || !data) return res.status(404).json({ error: 'Voice note not found' });
        res.json(data);
    } catch (err) {
        console.error('voice-notes/get error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// DELETE /api/voice-notes/:id — Delete voice note
// ============================================
router.delete('/:id', authRequired, async (req, res) => {
    const supabase = getSupabase();
    try {
        const { data, error } = await supabase
            .from('voice_notes')
            .select('file_name')
            .eq('id', req.params.id)
            .eq('site_id', req.siteId)
            .single();

        if (error || !data) return res.status(404).json({ error: 'Voice note not found' });

        await supabase.storage.from('entity-media').remove([data.file_name]);
        await supabase.from('voice_notes').delete().eq('id', req.params.id);

        res.json({ success: true });
    } catch (err) {
        console.error('voice-notes/delete error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
