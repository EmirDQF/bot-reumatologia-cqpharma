import { createClient } from '@supabase/supabase-js';
import config from '../config/env.js';

// Supabase-backed lead service. For tests, call initSupabaseClient(mockClient) to inject a mock.
let supabase = null;
export function initSupabaseClient(client) {
  supabase = client;
}

function normalizeSupabaseUrl(url) {
  if (!url || typeof url !== 'string') return url;
  return url.replace(/\/rest\/v1\/?$/i, '').replace(/\/$/, '');
}

export function getSupabaseClient() {
  if (supabase) return supabase;
  const rawUrl = config.supabase?.url || process.env.SUPABASE_URL;
  const key = config.supabase?.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  const url = normalizeSupabaseUrl(rawUrl);
  if (!url || !key) throw new Error('Supabase not configured (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required)');
  supabase = createClient(url, key);
  return supabase;
}

// Normalize phone to plain Peruvian digits (9 digits) or E.164-like +51... depending on input
function normalizePhone(telefono) {
  if (!telefono && telefono !== 0) return null;
  const raw = telefono.toString().trim();
  const onlyDigits = raw.replace(/\D/g, '');
  if (onlyDigits.length === 9) return onlyDigits; // local 9-digit
  if (onlyDigits.length === 11 && onlyDigits.startsWith('51')) return onlyDigits.slice(2);
  if (onlyDigits.length === 12 && onlyDigits.startsWith('+51')) return onlyDigits.replace('+51', '').replace(/\D/g, '');
  return onlyDigits || null;
}

import { isValidDistrict } from './districts.js';

function sanitizeDistrict(value) {
  if (!value || typeof value !== 'string') return null;
  const normalized = value.trim();
  const low = normalized.toLowerCase();
  const banned = ['nuestra clínica', 'nuestra clinica', 'en lima', 'lima', 'no proporcionado', 'no proporcionada', 'el de siempre', 'a confirmar', 'por confirmar'];
  for (const bad of banned) {
    if (low.includes(bad)) return null;
  }
  return isLikelyDistrict(normalized) ? normalized : null;
}

function isLikelyDistrict(text) {
  if (!text || typeof text !== 'string') return false;
  // Delegate to canonical validator with fuzzy matching
  return isValidDistrict(text);
}

function isValidNormalizedPhone(normalized) {
  return Boolean(normalized && /^\d{9}$/.test(String(normalized)));
}

function isValidNameForNotify(name) {
  if (!name || typeof name !== 'string') return false;
  const n = name.trim();
  if (n.length < 2) return false;
  if (/^camila\b/i.test(n)) return false; // avoid assistant name
  if (/\b(qué|cuál|cuando|a este número|dónde|donde)\b/i.test(n)) return false;
  return true;
}

function isValidISODateString(s) {
  if (!s || typeof s !== 'string') return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

// validateLead: throws Error with descriptive message when required fields missing in strict mode
export function validateLead({ telefono, nombre, distrito, fechaHoraISO, fechaHoraTexto } = {}, options = { strict: false }) {
  if (!telefono) throw Object.assign(new Error('telefono is required'), { status: 400, expose: true });
  if (options.strict) {
    if (!nombre) throw Object.assign(new Error('nombre is required'), { status: 400, expose: true });
    if (!distrito) throw Object.assign(new Error('distrito is required'), { status: 400, expose: true });
    if (!fechaHoraISO && !fechaHoraTexto) throw Object.assign(new Error('fechaHora (ISO or texto) is required'), { status: 400, expose: true });
  }
  return true;
}

export async function getByPhone(phone) {
  const client = getSupabaseClient();
  const normalized = normalizePhone(phone);
  try {
    if (normalized) {
      const { data, error } = await client.from('leads').select('*').eq('telefono', normalized).order('created_at', { ascending: false }).limit(1);
      if (error) throw error;
      if (Array.isArray(data) && data.length) return data[0];
    }
    return null;
  } catch (e) {
    console.error('leadService.getByPhone error', e && e.message ? e.message : e);
    throw e;
  }
}

export async function listLeads() {
  const client = getSupabaseClient();
  const { data, error } = await client.from('leads').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function saveLead({ telefono, nombre, distrito, fechaHoraISO, fechaHoraTexto, servicio = null, servicioInteres = null, confirmed = false, clinicId = null, clinic = null } = {}) {
  const client = getSupabaseClient();
  try {
    if (!telefono && telefono !== 0) {
      throw Object.assign(new Error('telefono is required to save a lead'), { status: 400, expose: true });
    }

    const normalized = normalizePhone(telefono);
    const now = new Date().toISOString();
    const incomingServicio = typeof servicio === 'string' ? servicio.trim() : (typeof servicioInteres === 'string' ? servicioInteres.trim() : null);

    // 1. Intentar obtener si el lead ya existe y si ya fue notificado previamente
    let existingData = null;
    try {
      const baseQuery = client.from('leads').select('id, ready_to_notify, notified_at, nombre, distrito, fecha_hora_texto, fecha_hora_iso, lead_snapshot').eq('telefono', normalized);
      if (typeof baseQuery.maybeSingle === 'function') {
        const { data } = await baseQuery.maybeSingle();
        existingData = data || null;
      } else {
        // older mock clients may not support maybeSingle
        const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const { data } = await client.from('leads')
          .select('id, ready_to_notify, notified_at, nombre, distrito, fecha_hora_texto, fecha_hora_iso')
          .eq('telefono', normalized)
          .gte('created_at', cutoff)
          .order('created_at', { ascending: false })
          .limit(1);
        existingData = Array.isArray(data) && data.length ? data[0] : null;
      }
    } catch (e) {
      // If query shape is unexpected for mock, fallback to null and continue
      console.warn('leadService.saveLead: could not read existing lead with maybeSingle/fallback:', e && e.message ? e.message : e);
      existingData = null;
    }

    const wasReady = Boolean(existingData?.ready_to_notify);
    const wasNotified = Boolean(existingData?.notified_at);

    // 2. Construir el payload manteniendo datos previos si los nuevos vienen nulos
    // Preserve valid existing fields: do not overwrite nombre with a value that looks like a distrito
    const incomingNombre = typeof nombre === 'string' ? nombre.trim() : null;
    const incomingDistrito = sanitizeDistrict(typeof distrito === 'string' ? distrito.trim() : null);

    const finalNombre = (function() {
      // Prefer incoming name when provided and not clearly the assistant name
      if (incomingNombre && incomingNombre.length > 1 && !/^camila\b/i.test(incomingNombre)) return incomingNombre;
      // Otherwise preserve existing name if present
      if (existingData?.nombre && existingData.nombre.length > 1 && !/^camila\b/i.test(existingData.nombre)) return existingData.nombre;
      return incomingNombre || null;
    })();

    const finalDistrito = (function() {
      const normalizedIncomingDistrict = incomingDistrito ? incomingDistrito.trim() : null;
      if (normalizedIncomingDistrict) return normalizedIncomingDistrict;
      const existingDistrict = sanitizeDistrict(existingData?.distrito ? existingData.distrito.trim() : null);
      if (existingDistrict) return existingDistrict;
      return null;
    })();

    const normalizedClinicId = typeof clinicId === 'string' && clinicId.trim() ? clinicId.trim() : null;
    const finalClinicId = normalizedClinicId || existingData?.clinic_id || null;

    // Explicitly prefer incoming confirmed fecha values when present and valid.
    let incomingFechaTexto = (typeof fechaHoraTexto === 'string' && fechaHoraTexto.trim().length > 0) ? fechaHoraTexto.trim() : null;
    let incomingFechaIso = (typeof fechaHoraISO === 'string' && fechaHoraISO.trim().length > 0 && isValidISODateString(fechaHoraISO)) ? fechaHoraISO : null;

    // If incoming textual fecha exists but no ISO provided, try to parse it via geminiService.parseTextToLimaISO
    if (!incomingFechaIso && incomingFechaTexto) {
      try {
        // dynamic import to avoid circular deps
        const gemini = await import('./geminiService.js');
        if (typeof gemini.parseTextToLimaISO === 'function') {
          const parsedIso = gemini.parseTextToLimaISO(incomingFechaTexto);
          if (parsedIso && isValidISODateString(parsedIso)) {
            incomingFechaIso = parsedIso;
            // normalize textual form to explicit formatted text
            try {
              const explicit = gemini.formatLimaFechaHoraText(parsedIso);
              if (explicit) incomingFechaTexto = explicit;
            } catch (_) { /* ignore */ }
          } else {
            // parsedIso null => textual fecha is incomplete (e.g., "el martes").
            // Attempt to combine a day-only incomingFechaTexto with an existing time from lead_snapshot if available.
            try {
              const existingIsoInSnapshot = existingData?.lead_snapshot?.fecha_hora_iso || existingData?.fecha_hora_iso || null;
              if (existingIsoInSnapshot && isValidISODateString(existingIsoInSnapshot) && typeof gemini.parseTextToLimaDate === 'function') {
                const targetDate = gemini.parseTextToLimaDate(incomingFechaTexto);
                if (targetDate) {
                  // derive local Lima hour/min from existing ISO
                  const existingDate = new Date(existingIsoInSnapshot);
                  const localHour = existingDate.getUTCHours() - 5; // reverse earlier +5 adjustment
                  const minute = existingDate.getUTCMinutes();
                  // build combined UTC date that represents Lima local time
                  const limaUtcDate = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate(), localHour + 5, minute, 0));
                  const combinedIso = limaUtcDate.toISOString().replace(/\.000Z$/, '+00:00');
                  if (isValidISODateString(combinedIso)) {
                    incomingFechaIso = combinedIso;
                    try {
                      const explicit = gemini.formatLimaFechaHoraText(incomingFechaIso);
                      if (explicit) incomingFechaTexto = explicit;
                    } catch (_) { /* ignore */ }
                  }
                }
              } else {
                // no existing time to combine with — treat as fragment and ignore
                incomingFechaTexto = null;
              }
            } catch (errComb) {
              // fallback: do not prefer fragment
              incomingFechaTexto = null;
            }
          }
        }
      } catch (e) {
        // If parsing fails for any reason, be defensive and do not prefer incoming textual fragment
        incomingFechaTexto = null;
      }
    }

    const finalServicio = incomingServicio || (existingData?.servicio) || (existingData?.servicio_interes) || (existingData?.lead_snapshot && typeof existingData.lead_snapshot === 'object' ? existingData.lead_snapshot.servicio : null) || null;
    const persistedLeadSnapshot = {
      ...(existingData && existingData.lead_snapshot && typeof existingData.lead_snapshot === 'object' ? existingData.lead_snapshot : {}),
      ...(finalNombre ? { nombre: finalNombre } : {}),
      ...(finalDistrito ? { distrito: finalDistrito } : {}),
      ...(incomingFechaTexto || existingData?.fecha_hora_texto ? { fecha_hora_texto: incomingFechaTexto || existingData?.fecha_hora_texto || null } : {}),
      ...(incomingFechaIso || existingData?.fecha_hora_iso ? { fecha_hora_iso: incomingFechaIso || existingData?.fecha_hora_iso || null } : {}),
      ...(finalServicio ? { servicio: finalServicio } : {}),
    };

    const payload = {
      telefono: normalized,
      nombre: finalNombre,
      distrito: finalDistrito,
      clinic_id: finalClinicId,
      // Only prefer incoming textual fecha if it produced a valid ISO (complete date+time). Otherwise preserve existing textual value.
      fecha_hora_texto: incomingFechaTexto || (existingData?.fecha_hora_texto || null),
      // If incoming ISO is present and valid, always prefer it. Else preserve existing ISO if any.
      fecha_hora_iso: incomingFechaIso || (existingData?.fecha_hora_iso || null),
      lead_snapshot: Object.keys(persistedLeadSnapshot).length ? persistedLeadSnapshot : null,
      updated_at: now,
    };
 
    // Calcular estado ready_to_notify solo cuando ya contamos con una fecha/hora ISO válida y datos validados.
    const isNowReady = Boolean(
      payload.nombre && isValidNameForNotify(payload.nombre) &&
      payload.distrito && isLikelyDistrict(payload.distrito) &&
      payload.fecha_hora_iso && isValidISODateString(payload.fecha_hora_iso) &&
      isValidNormalizedPhone(normalized)
    );
 
    const hasExistingDataFields = Boolean(existingData && (existingData.nombre || existingData.distrito || existingData.fecha_hora_iso));
    const incomingIsFirstCompleteSave = !hasExistingDataFields && isNowReady;
    payload.ready_to_notify = Boolean(
      (confirmed && isNowReady) ||
      (existingData?.ready_to_notify && isNowReady) ||
      incomingIsFirstCompleteSave
    );

    // 3. Ejecutar UPSERT atómico en Supabase para evitar Race Conditions (si está disponible)
    let updatedLead = null;
    if (typeof client.from === 'function') {
      try {
        // Log payload attempt before DB operation
        console.log('[DB SAVE ATTEMPT]: Payload enviado a Supabase:', payload);

        const testQuery = client.from('leads');
        if (testQuery && typeof testQuery.upsert === 'function') {
          const { data: upserted, error: upsertErr } = await client
            .from('leads')
            .upsert(payload, { onConflict: 'telefono' })
            .select('*')
            .single();
          if (upsertErr) {
            // log detailed supabase error
            console.error('[SUPABASE DB ERROR]:', upsertErr.message, upsertErr.details, upsertErr.hint, upsertErr.code);
            // if the error seems related to clinic_id FK, retry without clinic_id
            const fkRelated = String(upsertErr.message || '') + ' ' + String(upsertErr.details || '');
            if (/foreign key|constraint|clinic_id|clinic/i.test(fkRelated)) {
              try {
                const fallbackPayload = Object.assign({}, payload, { clinic_id: null });
                console.log('[DB SAVE ATTEMPT]: Retrying payload sin clinic_id:', fallbackPayload);
                const { data: upserted2, error: upsertErr2 } = await client
                  .from('leads')
                  .upsert(fallbackPayload, { onConflict: 'telefono' })
                  .select('*')
                  .single();
                if (upsertErr2) {
                  console.error('[SUPABASE DB ERROR]: retry failed', upsertErr2.message, upsertErr2.details, upsertErr2.hint, upsertErr2.code);
                  throw upsertErr2;
                }
                updatedLead = upserted2;
                console.log('[DB SAVE SUCCESS]: Fila guardada en Supabase con éxito (fallback clinic_id null):', updatedLead);
              } catch (e2) {
                throw e2;
              }
            } else {
              throw upsertErr;
            }
          } else {
            updatedLead = upserted;
            console.log('[DB SAVE SUCCESS]: Fila guardada en Supabase con éxito:', updatedLead);
          }
        } else {
          // Fallback for mocks that don't implement upsert(): update if existing, else insert
          try {
            if (existingData && existingData.id) {
              // log attempt
              console.log('[DB SAVE ATTEMPT]: Updating existing lead id', existingData.id, 'with payload', payload);
              const { data: updatedRows, error: updateErr } = await client.from('leads').update(payload).eq('id', existingData.id).select('*').limit(1);
              if (updateErr) {
                console.error('[SUPABASE DB ERROR]:', updateErr.message, updateErr.details, updateErr.hint, updateErr.code);
                // if foreign key issue, retry with clinic_id null
                const fkRelated = String(updateErr.message || '') + ' ' + String(updateErr.details || '');
                if (/foreign key|constraint|clinic_id|clinic/i.test(fkRelated)) {
                  const fallbackPayload = Object.assign({}, payload, { clinic_id: null });
                  console.log('[DB SAVE ATTEMPT]: Retrying update without clinic_id for id', existingData.id, fallbackPayload);
                  const { data: updatedRows2, error: updateErr2 } = await client.from('leads').update(fallbackPayload).eq('id', existingData.id).select('*').limit(1);
                  if (updateErr2) {
                    console.error('[SUPABASE DB ERROR]: retry failed', updateErr2.message, updateErr2.details, updateErr2.hint, updateErr2.code);
                    throw updateErr2;
                  }
                  updatedLead = Array.isArray(updatedRows2) && updatedRows2.length ? updatedRows2[0] : updatedRows2;
                  console.log('[DB SAVE SUCCESS]: Fila actualizada en Supabase con éxito (fallback clinic_id null):', updatedLead);
                } else {
                  throw updateErr;
                }
              } else {
                updatedLead = Array.isArray(updatedRows) && updatedRows.length ? updatedRows[0] : updatedRows;
                console.log('[DB SAVE SUCCESS]: Fila actualizada en Supabase con éxito:', updatedLead);
              }
            } else {
              const newRow = Object.assign({ created_at: now, notified_at: null }, payload);
              console.log('[DB SAVE ATTEMPT]: Insertando nuevo lead en Supabase:', newRow);
              const { data: inserted, error: insertErr } = await client.from('leads').insert([newRow]).select('*').limit(1);
              if (insertErr) {
                console.error('[SUPABASE DB ERROR]:', insertErr.message, insertErr.details, insertErr.hint, insertErr.code);
                const fkRelated = String(insertErr.message || '') + ' ' + String(insertErr.details || '');
                if (/foreign key|constraint|clinic_id|clinic/i.test(fkRelated)) {
                  const fallbackRow = Object.assign({ created_at: now, notified_at: null }, Object.assign({}, newRow, { clinic_id: null }));
                  console.log('[DB SAVE ATTEMPT]: Retrying insert without clinic_id:', fallbackRow);
                  const { data: inserted2, error: insertErr2 } = await client.from('leads').insert([fallbackRow]).select('*').limit(1);
                  if (insertErr2) {
                    console.error('[SUPABASE DB ERROR]: retry failed', insertErr2.message, insertErr2.details, insertErr2.hint, insertErr2.code);
                    throw insertErr2;
                  }
                  updatedLead = Array.isArray(inserted2) && inserted2.length ? inserted2[0] : inserted2;
                  console.log('[DB SAVE SUCCESS]: Fila insertada en Supabase con éxito (fallback clinic_id null):', updatedLead);
                } else {
                  throw insertErr;
                }
              } else {
                updatedLead = Array.isArray(inserted) && inserted.length ? inserted[0] : inserted;
                console.log('[DB SAVE SUCCESS]: Fila insertada en Supabase con éxito:', updatedLead);
              }
            }
          } catch (e) {
            throw e;
          }
        }
      } catch (e) {
        throw e;
      }
    } else {
      throw new Error('Supabase client shape unexpected');
    }

    // 4. Evaluar si se debe disparar la notificación al administrador
    const shouldNotify = Boolean(payload.ready_to_notify && !wasReady && !wasNotified);

    // If we must notify now (we recovered a previously incomplete but now-complete lead), attempt to notify admin immediately (best-effort).
    if (shouldNotify && updatedLead) {
      try {
        // Dynamic import to avoid potential circular deps at top-level
        const { notifyAdminNewLead } = await import('./notificationService.js');
        const notifyOptions = {};
        if (clinic) notifyOptions.clinic = clinic;
        // Fire and forget but await best-effort call to catch errors here
        await notifyAdminNewLead(updatedLead, notifyOptions);
        console.log('leadService.saveLead: triggered admin notification for recovered lead', updatedLead?.id || updatedLead?.telefono);
      } catch (e) {
        console.error('leadService.saveLead: failed to notify admin for recovered lead', e && e.message ? e.message : e);
      }
    }

    // If this lead was already notified previously but the fecha changed (e.g., correction by user), send an update notification to admin
    try {
      if (existingData?.notified_at && updatedLead) {
        const previousIso = existingData?.fecha_hora_iso || null;
        const previousNombre = existingData?.nombre || null;
        const previousDistrito = existingData?.distrito || null;

        // helper to normalize text for comparison (ignore diacritics, case, punctuation, extra spaces)
        const normalizeTextForCompare = (s) => {
          if (!s || typeof s !== 'string') return '';
          return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        };

        const nameChanged = normalizeTextForCompare(previousNombre) !== normalizeTextForCompare(payload.nombre);
        const distritoChanged = normalizeTextForCompare(previousDistrito) !== normalizeTextForCompare(payload.distrito);

        let dateChanged = false;
        try {
          if (previousIso && payload.fecha_hora_iso && isValidISODateString(previousIso) && isValidISODateString(payload.fecha_hora_iso)) {
            const prevDt = new Date(previousIso);
            const newDt = new Date(payload.fecha_hora_iso);
            const diffMs = Math.abs(newDt.getTime() - prevDt.getTime());
            if (diffMs > 5 * 60 * 1000) dateChanged = true; // more than 5 minutes difference
          } else if ((previousIso && !payload.fecha_hora_iso) || (!previousIso && payload.fecha_hora_iso)) {
            dateChanged = true; // one has date, other doesn't
          }
        } catch (errDate) {
          dateChanged = previousIso !== payload.fecha_hora_iso;
        }

        // Only notify admin on substantial change to avoid spamming for formatting tweaks
        if (nameChanged || distritoChanged || dateChanged) {
          try {
            const { notifyAdminUpdatedLead } = await import('./notificationService.js');
            const prevText = existingData?.fecha_hora_texto || previousIso;
            const leadForNotify = Object.assign({}, updatedLead, { previous_fecha_hora_texto: prevText });
            const notifyOptions = {};
            if (clinic) notifyOptions.clinic = clinic;
            await notifyAdminUpdatedLead(leadForNotify, previousIso, notifyOptions);
            console.log('leadService.saveLead: triggered admin UPDATE notification for lead', updatedLead?.id || updatedLead?.telefono);
          } catch (e) {
            console.error('leadService.saveLead: failed to send admin update notification', e && e.message ? e.message : e);
          }
        } else {
          // no substantial change -> skip re-notification
          console.log('leadService.saveLead: skipping re-notification; no substantial changes detected');
        }
      }
    } catch (e) {
      // non-fatal: continue
    }

    // 5. After upsert, log if lead is stuck (has phone but not ready_to_notify for >10 minutes)
    try {
      const createdAt = updatedLead?.created_at || existingData?.created_at || null;
      if (createdAt) {
        const createdTime = new Date(createdAt).getTime();
        if (!isNowReady && isValidNormalizedPhone(normalized) && (Date.now() - createdTime) > 10 * 60 * 1000) {
          const missing = [];
          if (!payload.nombre || !isValidNameForNotify(payload.nombre)) missing.push('nombre');
          if (!payload.distrito || !isLikelyDistrict(payload.distrito)) missing.push('distrito');
          if (!payload.fecha_hora_iso || !isValidISODateString(payload.fecha_hora_iso)) missing.push('fecha_hora_iso');
          console.warn(JSON.stringify({ tag: 'LEAD_ATASCADO', leadId: updatedLead?.id || null, telefono: normalized, missingFields: missing }));
        }
      }
    } catch (e) {
      // non fatal
      console.warn('leadService.saveLead: error checking lead stuck condition', e && e.message ? e.message : e);
    }

    return {
      isNew: !existingData,
      readyToNotify: shouldNotify,
      lead: updatedLead
    };

  } catch (error) {
    console.error('[CRITICAL DB/NOTIFY ERROR]: leadService.saveLead error:', error?.message || error);
    throw error;
  }
}

export async function saveLeadSnapshot(telefono, snapshot) {
  const client = getSupabaseClient();
  if (!telefono) throw new Error('telefono is required to save snapshot');
  const normalized = normalizePhone(telefono);
  const now = new Date().toISOString();
  const payload = {
    telefono: normalized,
    lead_snapshot: snapshot || null,
    updated_at: now
  };

  try {
    // Try upsert if available
    const testQuery = client.from('leads');
    if (testQuery && typeof testQuery.upsert === 'function') {
      const { data: upserted, error: upsertErr } = await client
        .from('leads')
        .upsert(payload, { onConflict: 'telefono' })
        .select('*')
        .single();
      if (upsertErr) throw upsertErr;
      return upserted;
    }

    // Fallback: update if exists, else insert
    const { data: existingRows } = await client.from('leads').select('id').eq('telefono', normalized).limit(1);
    const existing = Array.isArray(existingRows) && existingRows.length ? existingRows[0] : null;
    if (existing && existing.id) {
      const { data: updatedRows, error: updateErr } = await client.from('leads').update(payload).eq('id', existing.id).select('*').limit(1);
      if (updateErr) throw updateErr;
      return Array.isArray(updatedRows) && updatedRows.length ? updatedRows[0] : updatedRows;
    }

    const newRow = Object.assign({ created_at: now, notified_at: null }, payload);
    const { data: inserted, error: insertErr } = await client.from('leads').insert([newRow]).select('*').limit(1);
    if (insertErr) throw insertErr;
    return Array.isArray(inserted) && inserted.length ? inserted[0] : inserted;
  } catch (e) {
    console.error('leadService.saveLeadSnapshot error', e && e.message ? e.message : e);
    throw e;
  }
}

export async function tryClaimNotification(leadId) {
  // Atomically set notified_at only if currently NULL to avoid double notifications
  const client = getSupabaseClient();
  try {
    const now = new Date().toISOString();
    // Use .is to check NULL in Supabase client
    const { data, error } = await client.from('leads')
      .update({ notified_at: now, updated_at: now })
      .eq('id', leadId)
      .is('notified_at', null)
      .select('*')
      .limit(1);
    if (error) throw error;
    const row = Array.isArray(data) && data.length ? data[0] : null;
    return row; // returns the updated row if claimed, or null if someone else already notified
  } catch (e) {
    console.error('leadService.tryClaimNotification error', e && e.message ? e.message : e);
    throw e;
  }
}

export async function markAsNotified(leadId) {
  const client = getSupabaseClient();
  try {
    const { data, error } = await client.from('leads').update({ notified_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', leadId).select('*').limit(1);
    if (error) throw error;
    return Array.isArray(data) && data.length ? data[0] : null;
  } catch (e) {
    console.error('leadService.markAsNotified error', e && e.message ? e.message : e);
    throw e;
  }
}

export async function getClinicByWabaPhoneId(phoneNumberId) {
  if (!phoneNumberId) return null;
  const client = getSupabaseClient();
  try {
    if (typeof client.from === 'function') {
      // prefer maybeSingle when available
      if (typeof client.from('clinics').maybeSingle === 'function') {
        const { data, error } = await client.from('clinics').select('*').eq('waba_phone_number_id', phoneNumberId).maybeSingle();
        if (error) throw error;
        return data || null;
      }
      // fallback to select with limit
      const { data, error } = await client.from('clinics').select('*').eq('waba_phone_number_id', phoneNumberId).limit(1);
      if (error) throw error;
      return Array.isArray(data) && data.length ? data[0] : null;
    }
    return null;
  } catch (e) {
    console.error('leadService.getClinicByWabaPhoneId error', e && e.message ? e.message : e);
    throw e;
  }
}

export default {
  saveLead,
  getByPhone,
  listLeads,
  validateLead,
  initSupabaseClient,
  getSupabaseClient,
  getClinicByWabaPhoneId,
  _internals: { normalizePhone },
};
