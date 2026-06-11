// ============================================
// Analytics API Routes
// Tracks page views, conversions, events
// ============================================

const express = require('express');
const router = express.Router();
const supabase = require('../db');

// ============================================
// POST /api/analytics/pageview
// Track page view with UTM params and device info
// ============================================
router.post('/pageview', async (req, res) => {
    try {
        const {
            subdomain,
            page_path,
            page_title,
            referrer,
            utm_source,
            utm_medium,
            utm_campaign,
            utm_term,
            utm_content,
            device_type,
            browser,
            os,
            session_id
        } = req.body;

        // Get site_id from subdomain
        const { data: business } = await supabase
            .from('businesses')
            .select('site_id')
            .eq('subdomain', subdomain)
            .single();

        if (!business) {
            return res.status(404).json({ error: 'Business not found' });
        }

        // Get IP address and geo data
        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

        // Insert page view
        const { data, error } = await supabase
            .from('page_views')
            .insert({
                site_id: business.site_id,
                page_path: page_path || '/',
                page_title: page_title,
                referrer: referrer,
                utm_source: utm_source,
                utm_medium: utm_medium,
                utm_campaign: utm_campaign,
                utm_term: utm_term,
                utm_content: utm_content,
                device_type: device_type,
                browser: browser,
                os: os,
                ip_address: ip,
                session_id: session_id
            })
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, id: data.id });
    } catch (error) {
        console.error('Analytics pageview error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// POST /api/analytics/conversion
// Track conversion (booking, contact, signup)
// ============================================
router.post('/conversion', async (req, res) => {
    try {
        const {
            subdomain,
            conversion_type,
            conversion_value,
            revenue,
            customer_email,
            customer_name,
            utm_source,
            utm_medium,
            utm_campaign,
            referrer,
            session_id,
            booking_id,
            metadata
        } = req.body;

        // Get site_id from subdomain
        const { data: business } = await supabase
            .from('businesses')
            .select('site_id')
            .eq('subdomain', subdomain)
            .single();

        if (!business) {
            return res.status(404).json({ error: 'Business not found' });
        }

        // Insert conversion
        const { data, error } = await supabase
            .from('conversions')
            .insert({
                site_id: business.site_id,
                conversion_type: conversion_type || 'custom',
                conversion_value: conversion_value || 0,
                revenue: revenue || 0,
                customer_email: customer_email,
                customer_name: customer_name,
                utm_source: utm_source,
                utm_medium: utm_medium,
                utm_campaign: utm_campaign,
                referrer: referrer,
                session_id: session_id,
                booking_id: booking_id,
                metadata: metadata
            })
            .select()
            .single();

        if (error) throw error;

        res.json({ success: true, id: data.id });
    } catch (error) {
        console.error('Analytics conversion error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// POST /api/analytics/event
// Track custom events
// ============================================
router.post('/event', async (req, res) => {
    try {
        const { subdomain, event_name, session_id, event_data } = req.body;

        // Get site_id from subdomain
        const { data: business } = await supabase
            .from('businesses')
            .select('site_id')
            .eq('subdomain', subdomain)
            .single();

        if (!business) {
            return res.status(404).json({ error: 'Business not found' });
        }

        // For now, log to console (can add events table later if needed)
        console.log('Custom event:', event_name, session_id, event_data);

        res.json({ success: true });
    } catch (error) {
        console.error('Analytics event error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// POST /api/analytics/duration
// Track time spent on page
// ============================================
router.post('/duration', async (req, res) => {
    try {
        const { session_id, duration } = req.body;

        // Update the last page view with this session_id
        await supabase
            .from('page_views')
            .update({ duration_seconds: duration })
            .eq('session_id', session_id)
            .order('created_at', { ascending: false })
            .limit(1);

        res.json({ success: true });
    } catch (error) {
        console.error('Analytics duration error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// GET /api/analytics/stats
// Get analytics stats for dashboard (requires auth)
// ============================================
router.get('/stats', async (req, res) => {
    try {
        // This would be called by the dashboard (needs auth middleware)
        const { site_id, period } = req.query;

        if (!site_id) {
            return res.status(400).json({ error: 'site_id required' });
        }

        const today = new Date().toISOString().split('T')[0];

        // Get today's page views
        const { data: todayViews } = await supabase
            .from('page_views')
            .select('*')
            .eq('site_id', site_id)
            .gte('created_at', today + ' 00:00:00');

        // Get today's conversions
        const { data: todayConversions } = await supabase
            .from('conversions')
            .select('*')
            .eq('site_id', site_id)
            .gte('created_at', today + ' 00:00:00');

        const todayRevenue = (todayConversions || [])
            .reduce((sum, c) => sum + (parseFloat(c.revenue) || 0), 0);

        res.json({
            today: {
                visitors: new Set((todayViews || []).map(v => v.ip_address)).size,
                pageviews: (todayViews || []).length,
                conversions: (todayConversions || []).length,
                revenue: todayRevenue
            }
        });
    } catch (error) {
        console.error('Analytics stats error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
