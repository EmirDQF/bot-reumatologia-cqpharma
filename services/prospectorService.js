import config from '../config/env.js';
import { createClient } from '@supabase/supabase-js';

const META_TOKEN = process.env.META_AD_LIBRARY_TOKEN || null;
const COUNTRY = process.env.PROSPECTOR_COUNTRY || 'PE';
const KEYWORDS = [
  'reumatología',
  'densitometría ósea',
  'suplementos nutricionales',
  'colágeno hidrolizado',
  'calcio vitamina d'
];

const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey);

function extractPhoneFromText(text) {
  if (!text) return null;
  const digits = (text || '').replace(/[^0-9\+]/g, '');
  // Look for 9-digit sequences possibly prefixed by country code
  const match = digits.match(/(?:51)?(9\d{8})/);
  return match ? match[1] : null;
}

async function fetchAdsForKeyword(keyword, limit = 50) {
  if (!META_TOKEN) throw new Error('META_AD_LIBRARY_TOKEN is required');
  const base = 'https://graph.facebook.com/v19.0/ads_archive';
  const params = new URLSearchParams({
    access_token: META_TOKEN,
    search_terms: keyword,
    ad_reached_countries: JSON.stringify([COUNTRY]),
    ad_active_status: 'ACTIVE',
    limit: String(limit),
    fields: 'page_name,page_id,ad_snapshot_url,publisher_platforms,ad_creative{body,link_caption}'
  });
  const url = `${base}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Meta Ad Library API error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.data || [];
}

export async function runProspector() {
  const stats = { found: 0, upserted: 0, skipped: 0 };
  for (const kw of KEYWORDS) {
    let ads = [];
    try {
      ads = await fetchAdsForKeyword(kw);
    } catch (e) {
      console.warn('prospector: failed to fetch ads for', kw, e && e.message ? e.message : e);
      continue;
    }

    for (const ad of ads) {
      stats.found += 1;
      const page_name = ad.page_name || null;
      const page_id = ad.page_id || null;
      const ad_snapshot_url = ad.ad_snapshot_url || (ad.ad_creative && ad.ad_creative.url) || null;
      const plataformas = Array.isArray(ad.publisher_platforms) ? ad.publisher_platforms : [];
      const creativeBody = (ad.ad_creative && (ad.ad_creative.body || ad.ad_creative.link_caption)) || '';
      const telefono = extractPhoneFromText(creativeBody);

      const prospect = {
        page_name,
        page_id,
        telefono,
        ad_snapshot_url,
        plataformas,
        updated_at: new Date().toISOString(),
      };

      try {
        const { data, error } = await supabase.from('prospects').upsert(prospect, { onConflict: 'page_id' }).select('*').single();
        if (error) {
          console.warn('prospector: upsert error', error.message || error);
          stats.skipped += 1;
        } else {
          stats.upserted += 1;
        }
      } catch (e) {
        console.warn('prospector: unexpected error inserting prospect', e && e.message ? e.message : e);
        stats.skipped += 1;
      }
    }
  }

  return stats;
}

export default { runProspector };
