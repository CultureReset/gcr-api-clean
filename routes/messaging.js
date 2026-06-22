const express = require('express');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { sendSms } = require('../utils/sendSms');

const router = express.Router();

// POST /api/messaging/conversations — create/get conversation
router.post('/conversations', authRequired, async (req, res) => {
  try {
    const {
      business_id,
      business_type,
      participant_name,
      participant_phone,
      participant_email,
      subject,
      context_id,
      context_type,
      site_id,
    } = req.body;

    // Check if conversation exists
    const { data: existing } = await db
      .from('conversations')
      .select('id')
      .eq('business_id', business_id)
      .eq('participant_phone', participant_phone)
      .eq('context_id', context_id)
      .maybeSingle();

    if (existing) {
      return res.json({ conversation_id: existing.id, created: false });
    }

    // Create new conversation
    const { data: conversation, error } = await db
      .from('conversations')
      .insert({
        site_id,
        business_id,
        business_type,
        participant_name,
        participant_phone,
        participant_email,
        subject,
        context_id,
        context_type,
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(201).json({
      conversation_id: conversation.id,
      created: true,
    });
  } catch (err) {
    console.error('Create conversation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messaging/conversations/:business_id — list conversations
router.get('/conversations/:business_id', authRequired, async (req, res) => {
  try {
    const { business_id } = req.params;

    const { data: conversations, error } = await db
      .from('conversations')
      .select('*')
      .eq('business_id', business_id)
      .eq('is_active', true)
      .order('last_message_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json(conversations || []);
  } catch (err) {
    console.error('List conversations error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/messaging/conversations/:conversation_id/messages — get messages
router.get('/conversations/:conversation_id/messages', authRequired, async (req, res) => {
  try {
    const { conversation_id } = req.params;

    const { data: messages, error } = await db
      .from('messages')
      .select('*')
      .eq('conversation_id', conversation_id)
      .order('created_at', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json(messages || []);
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/messaging/messages — send message
router.post('/messages', authRequired, async (req, res) => {
  try {
    const {
      conversation_id,
      message_text,
      send_sms,
      sender_name,
    } = req.body;

    // Get conversation details
    const { data: conversation } = await db
      .from('conversations')
      .select('*')
      .eq('id', conversation_id)
      .maybeSingle();

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Create message
    const { data: message, error: insertError } = await db
      .from('messages')
      .insert({
        conversation_id,
        sender_type: 'business_owner',
        sender_name: sender_name || 'Business Owner',
        message_text,
        sent_via: send_sms ? 'dashboard_and_sms' : 'dashboard',
      })
      .select()
      .single();

    if (insertError) {
      return res.status(400).json({ error: insertError.message });
    }

    // Send SMS if requested
    if (send_sms && conversation.participant_phone) {
      try {
        await sendSms(
          conversation.participant_phone,
          message_text
        );
        // Mark SMS as sent
        await db
          .from('messages')
          .update({ sms_sent: true })
          .eq('id', message.id);
      } catch (smsErr) {
        console.error('SMS send failed:', smsErr);
        // Continue anyway, message is saved
      }
    }

    // Update conversation last_message_at
    await db
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversation_id);

    return res.status(201).json({
      message_id: message.id,
      sms_sent: send_sms,
    });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/messaging/sms-webhook — receive SMS from guest/artist
router.post('/sms-webhook', async (req, res) => {
  try {
    const { from, body, conversation_id } = req.body;

    if (!conversation_id) {
      return res.status(400).json({ error: 'conversation_id required' });
    }

    // Create message from guest/artist
    const { data: message, error } = await db
      .from('messages')
      .insert({
        conversation_id,
        sender_type: 'guest',
        sender_phone: from,
        message_text: body,
        sent_via: 'sms',
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // Update conversation last_message_at
    await db
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversation_id);

    return res.json({ received: true, message_id: message.id });
  } catch (err) {
    console.error('SMS webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
