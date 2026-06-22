const express = require('express');
const router = express.Router();
const { authRequired } = require('../middleware/auth');

/**
 * Provider-agnostic AI wrapper.
 * Auto-detects provider from env: ANTHROPIC_API_KEY → Claude, OPENAI_API_KEY → GPT-4o, GROQ_API_KEY → Groq.
 * callAIRound({ messages, systemPrompt, temperature, maxTokens }) → { text }
 */

async function callAIRound({ messages = [], systemPrompt = '', temperature = 0.7, maxTokens = 1800 } = {}) {
  if (process.env.ANTHROPIC_API_KEY) {
    return callAnthropic({ messages, systemPrompt, temperature, maxTokens });
  }
  if (process.env.OPENAI_API_KEY) {
    return callOpenAI({ messages, systemPrompt, temperature, maxTokens });
  }
  if (process.env.GROQ_API_KEY) {
    return callGroq({ messages, systemPrompt, temperature, maxTokens });
  }
  throw new Error('No AI provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GROQ_API_KEY.');
}

async function callAnthropic({ messages, systemPrompt, temperature, maxTokens }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages,
  });

  const text = response.content?.find(b => b.type === 'text')?.text || '';
  return { text, provider: 'anthropic', model: response.model };
}

async function callOpenAI({ messages, systemPrompt, temperature, maxTokens }) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const openaiMessages = [];
  if (systemPrompt) openaiMessages.push({ role: 'system', content: systemPrompt });
  openaiMessages.push(...messages);

  const response = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    max_tokens: maxTokens,
    temperature,
    messages: openaiMessages,
  });

  const text = response.choices?.[0]?.message?.content || '';
  return { text, provider: 'openai', model: response.model };
}

async function callGroq({ messages, systemPrompt, temperature, maxTokens }) {
  const openaiMessages = [];
  if (systemPrompt) openaiMessages.push({ role: 'system', content: systemPrompt });
  openaiMessages.push(...messages);

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      max_tokens: maxTokens,
      temperature,
      messages: openaiMessages,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';
  return { text, provider: 'groq', model: data.model };
}

// ─────────────────────────────────────────────────────────────────────────────
// Route: POST /api/ai-provider/call
// ─────────────────────────────────────────────────────────────────────────────
router.post('/call', authRequired, async (req, res) => {
  try {
    const { messages, systemPrompt, temperature, maxTokens } = req.body;
    const result = await callAIRound({ messages, systemPrompt, temperature, maxTokens });
    res.json(result);
  } catch (err) {
    console.error('AI provider error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
