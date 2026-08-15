// Simple keep-alive pinger for Render free dynos or external cron services.
// Usage: node scripts/keepAlive.js
// It will ping the URL every 10 minutes (configurable via KEEPALIVE_INTERVAL_MS)

import fetch from 'node-fetch';

const url = process.env.KEEPALIVE_URL || `https://bot-reumatologia-cqpharma.onrender.com/health`;
const intervalMs = Number(process.env.KEEPALIVE_INTERVAL_MS || 10 * 60 * 1000);

async function ping() {
  try {
    const res = await fetch(url, { method: 'GET', timeout: 10000 });
    const ok = res.ok;
    console.log(`keepAlive: pinged ${url} -> ${res.status} ${res.statusText}`);
  } catch (e) {
    console.warn('keepAlive: ping failed', e && e.message ? e.message : e);
  }
}

console.log(`Starting keepAlive pinger to ${url} every ${intervalMs}ms`);
ping();
setInterval(ping, intervalMs);
