// ============================================================
// GHOST RECEIPTS — a computer's result, back to Paperclip (plan §11)
// ============================================================
//
// An instruction to a computer carries its Paperclip task id
// (ghost_node_requests.paperclip_task_id, set by the Ghost MCP tools). When
// the computer answers through the relay (routes/nodes.js) with a receipt —
// nextgent-platform's verification of what it did — the receipt is posted to
// Paperclip, signed (CONTRACT §5):
//
//   POST /api/nextgent/receipts { companyId, taskId?, action, capability?,
//        target, oldValue?, newValue?, device?, verified, at, evidence? }
//
// A receipt request for an action (/actions/<id>/receipt) inherits the task id
// of the instruction that produced that action. Posting never fails the
// computer's answer; the outcome is kept on the request row.
//
// A receipt produced later (after the owner's YES) comes up on its own: the
// computer pushes it to POST /api/nodes/receipts, which writes it as a done
// GET /actions/<id>/receipt row and posts it through here the same way
// (DECISIONS #80).

const supabase = require('../db');
const { signedPost } = require('./serviceSigning');

const ACTION_PATH = /^\/actions\/([^/]+)(\/receipt)?$/;

/** The receipt in a computer's answer, or null when there is none. */
function receiptOf(request) {
    const body = request.response_body;
    if (!body || typeof body !== 'object') return null;
    if (body.receipt && typeof body.receipt === 'object') return body.receipt;
    if (ACTION_PATH.test(request.path || '') && /\/receipt$/.test(request.path) && request.response_status === 200) return body;
    return null;
}

const actionIdOf = (obj) => obj?.action?.id || obj?.action_id || obj?.task_id || obj?.id || null;

/** The Paperclip task this request belongs to: its own, or the instruction's that produced the action. */
async function taskIdFor(request) {
    if (request.paperclip_task_id) return request.paperclip_task_id;
    const m = String(request.path || '').match(ACTION_PATH);
    if (!m) return null;
    const actionId = decodeURIComponent(m[1]);
    const { data } = await supabase.from('ghost_node_requests')
        .select('paperclip_task_id, response_body')
        .eq('node_id', request.node_id).not('paperclip_task_id', 'is', null)
        .order('created_at', { ascending: false }).limit(100);
    const origin = (data || []).find((r) => String(actionIdOf(r.response_body) || '') === actionId);
    return origin?.paperclip_task_id || null;
}

/** The first value that is a non-empty string, else ''. */
const firstString = (...vals) => String(vals.find((v) => typeof v === 'string' && v.trim()) || '');

const isVerified = (r) => r.verified === true || String(r.status || r.result || '').toUpperCase() === 'VERIFIED';

/**
 * Post the receipt in a finished request to Paperclip. Resolves
 * { posted: true } or { posted: false, reason }.
 */
async function postReceipt(request, { post = signedPost, now = new Date() } = {}) {
    const receipt = receiptOf(request);
    if (!receipt) return { posted: false, reason: 'no_receipt' };
    if (request.receipt_posted_at) return { posted: false, reason: 'already_posted' };

    const { data: link } = await supabase.from('company_links').select('company_id').eq('entity_slug', request.entity_slug).maybeSingle();
    const mark = async (patch) => { await supabase.from('ghost_node_requests').update(patch).eq('id', request.id); };
    if (!link?.company_id) {
        await mark({ receipt_error: 'not_linked' });
        return { posted: false, reason: 'not_linked' };
    }
    const { data: node } = await supabase.from('ghost_nodes').select('name').eq('id', request.node_id).maybeSingle();
    const taskId = await taskIdFor(request);
    const payload = {
        companyId: link.company_id,
        ...(taskId ? { taskId } : {}),
        action: String(receipt.action || receipt.capability || receipt.intent || request.body?.text || request.path),
        // The capability as its own field when the receipt names one; Paperclip
        // accepts and shows it. Omitted when absent.
        ...(typeof receipt.capability === 'string' && receipt.capability.trim() ? { capability: receipt.capability } : {}),
        // No target (the relay form of core's receipt has none): the capability,
        // the action or the action id stand in, so Paperclip never refuses it
        // (DECISIONS #79; the shape is otherwise #38's).
        target: firstString(receipt.target, receipt.app, receipt.to, receipt.capability, receipt.action, receipt.action_id, actionIdOf(receipt)),
        ...(receipt.old_value !== undefined || receipt.oldValue !== undefined ? { oldValue: receipt.old_value ?? receipt.oldValue } : {}),
        ...(receipt.new_value !== undefined || receipt.newValue !== undefined ? { newValue: receipt.new_value ?? receipt.newValue } : {}),
        device: receipt.device || node?.name || null,
        verified: isVerified(receipt),
        at: receipt.at || receipt.verified_at || now.toISOString(),
        ...(receipt.evidence !== undefined ? { evidence: receipt.evidence } : {}),
    };
    try {
        await post('/api/nextgent/receipts', payload);
        await mark({ receipt_posted_at: now.toISOString(), receipt_error: null });
        return { posted: true, payload };
    } catch (err) {
        await mark({ receipt_error: String(err.message).slice(0, 300) });
        return { posted: false, reason: err.message };
    }
}

module.exports = { postReceipt, receiptOf, taskIdFor, actionIdOf };
