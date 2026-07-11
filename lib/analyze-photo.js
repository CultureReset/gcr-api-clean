// Analyze an uploaded photo with Claude vision: what is this actually a
// picture of, specifically enough to drive swipe-deck analytics (not just
// "outdoor" but "dolphin," "boat deck," "seafood platter," etc).
const Anthropic = require('@anthropic-ai/sdk');

function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

const PROMPT = `This photo is on a Gulf Coast tourism listing. Look at what's actually
depicted and return a JSON object with these fields:
- description: one plain sentence describing exactly what's in the photo.
- tags: an array of 3-8 specific, lowercase, single-or-two-word tags for what's
  actually shown -- concrete subjects (e.g. "dolphin", "sunset", "boat deck",
  "seafood platter", "pool", "gulf view"), not vague categories like "outdoor"
  or "nice photo". If it's food, tag the actual dish. If it's an animal, tag
  the specific animal. If it's a place/room, tag what kind of space it is.

Return ONLY valid JSON: {"description": "...", "tags": ["...", "..."]}
No markdown, no explanation.`;

// Returns { description, tags } or null if analysis fails -- callers should
// treat this as best-effort and never block the actual photo save on it.
async function analyzePhoto(imageUrl) {
  if (!imageUrl || !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const client = getClient();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: imageUrl } },
          { type: 'text', text: PROMPT },
        ],
      }],
    });

    const text = response.content[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      parsed = JSON.parse(match[0]);
    }

    if (!parsed || typeof parsed.description !== 'string' || !Array.isArray(parsed.tags)) return null;
    return {
      description: parsed.description,
      tags: parsed.tags.filter(t => typeof t === 'string').map(t => t.toLowerCase().trim()).slice(0, 8),
    };
  } catch (err) {
    console.warn('[analyze-photo] failed:', err.message);
    return null;
  }
}

module.exports = { analyzePhoto };
