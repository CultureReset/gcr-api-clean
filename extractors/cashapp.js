const REQ_CODE_RE = /\b(REQ-[A-Z0-9]{8,})\b/i;
const AMOUNT_RE = /\$(\d+(?:\.\d{2})?)/;
const SENDER_RE = /(?:^|\s)([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\s+(?:sent you|paid)/i;
const CASHTAG_RE = /\$([a-z0-9_]{1,20})/i;
const MEMO_RE = /(?:for|message|note|reason)[:\s]+(.+?)(?:\n|$)/i;

function extract(text, html, fromEmail) {
  if (!text && !html) return null;

  const content = text || html || '';

  // Extract amount
  const amountMatch = content.match(AMOUNT_RE);
  if (!amountMatch) return null;
  const amount = parseFloat(amountMatch[1]);

  // Extract sender name
  let senderName = null;
  const senderMatch = content.match(SENDER_RE);
  if (senderMatch) {
    senderName = senderMatch[1];
  }

  // Try cashtag as fallback
  let cashtag = null;
  if (!senderName) {
    const cashtagMatch = content.match(CASHTAG_RE);
    if (cashtagMatch) {
      cashtag = cashtagMatch[1];
      senderName = `$${cashtag}`;
    }
  }

  // Extract memo/message field
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
