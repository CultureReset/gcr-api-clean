const REQ_CODE_RE = /\b(REQ-[A-Z0-9]{8,})\b/i;
const AMOUNT_RE = /\$(\d+(?:\.\d{2})?)/;
const SENDER_RE = /(?:from|paid by|payment from)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/i;
const MEMO_RE = /(?:for|memo|note)[:\s]+(.+?)(?:\n|$)/i;

function extract(text, html, fromEmail) {
  if (!text && !html) return null;

  const content = text || html || '';

  // Extract amount
  const amountMatch = content.match(AMOUNT_RE);
  if (!amountMatch) return null;
  const amount = parseFloat(amountMatch[1]);

  // Extract sender name from subject or body
  let senderName = null;
  const senderMatch = content.match(SENDER_RE);
  if (senderMatch) {
    senderName = senderMatch[1];
  } else if (fromEmail && fromEmail.includes('venmo')) {
    // Try to extract from email display name
    const displayMatch = fromEmail.match(/^"?([^"<]+)"?/);
    if (displayMatch) {
      senderName = displayMatch[1].trim();
    }
  }

  // Extract memo/note field
  let memo = null;
  const memoMatch = content.match(MEMO_RE);
  if (memoMatch) {
    memo = memoMatch[1].trim();
  }

  // Extract REQ code from memo
  let reqCode = null;
  if (memo) {
    const reqMatch = memo.match(REQ_CODE_RE);
    if (reqMatch) {
      reqCode = reqMatch[1];
    }
  }

  // Confidence scoring
  let confidence = 0.7;
  if (senderName) confidence += 0.1;
  if (reqCode) confidence += 0.15;
  if (memo) confidence += 0.05;
  confidence = Math.min(confidence, 0.99);

  return {
    amount,
    senderName,
    memo,
    reqCode,
    confidence: parseFloat(confidence.toFixed(2))
  };
}

module.exports = { extract };
