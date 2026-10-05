// ============================================================
// SCHEDULER — the scheduled work, on the always-on server
// ============================================================
//
// On Vercel the same work runs from vercel.json crons (hourly automations
// tick, Google drain every five minutes, LiteLLM usage hourly). On the
// always-on server (ALWAYS_ON=true) it runs here instead, more often:
//
//   automations      tick: completed bookings, due waits, schedules
//   google push      drain the queue under the per-profile edit limit
//   litellm usage    pull spend per company (unless LITELLM_USAGE_PULL=false)
//   conversations    close idle text conversations and record them
//   event-outbox     post business events to Paperclip that did not go
//                    first time (lib/eventOutbox.js; off until EVENTS_TO_PAPERCLIP)
//
// Each job has its own interval (seconds, env) and never overlaps itself.

const { envBool, envInt } = require('./env');

const JOBS = [
    { name: 'automations', every: () => envInt('SCHEDULER_AUTOMATIONS_SECONDS', 60), run: () => require('./automationEngine').tick() },
    { name: 'google-push', every: () => envInt('SCHEDULER_GOOGLE_PUSH_SECONDS', 60), run: () => require('./googlePush').drain() },
    { name: 'litellm-usage', every: () => envInt('SCHEDULER_LITELLM_USAGE_SECONDS', 3600), run: () => require('./litellmUsage').pullUsage() },
    { name: 'conversations', every: () => envInt('SCHEDULER_CONVERSATIONS_SECONDS', 60), run: async () => {
        const live = require('./liveAgent');
        return { ...(await live.closeIdleConversations()), ...(await live.retryUnrecorded()) };
    } },
    { name: 'event-outbox', every: () => envInt('SCHEDULER_EVENT_OUTBOX_SECONDS', 60), run: () => require('./eventOutbox').drain() },
];

const timers = [];

function start() {
    if (!envBool('ALWAYS_ON') || process.env.VERCEL) return false;
    for (const job of JOBS) {
        let busy = false;
        const fire = async () => {
            if (busy) return;
            busy = true;
            try { await job.run(); } catch (e) { console.error(`[scheduler] ${job.name}:`, e.message); } finally { busy = false; }
        };
        timers.push(setInterval(fire, job.every() * 1000));
    }
    console.log(`[scheduler] running ${JOBS.map((j) => j.name).join(', ')}`);
    return true;
}

function stop() {
    while (timers.length) clearInterval(timers.pop());
}

module.exports = { start, stop, JOBS };
