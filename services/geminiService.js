import config from '../config/env.js';

// Expanded model fallback list (include older 1.5 variants and 2.0 fallback)
const ALLOWED_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash-exp',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash-8b',
];

// Log configured model on startup (do NOT modify or sanitize process.env.GEMINI_MODEL here)
const configuredModelRaw = (config && config.gemini && config.gemini.model) ? String(config.gemini.model) : (process.env.GEMINI_MODEL || '');
console.info(`[geminiService] Configured Gemini model (raw env): "${configuredModelRaw}"`);
console.info(`[geminiService] Allowed models (fallback order): ${JSON.stringify(ALLOWED_MODELS)}`);

const TTL_MS = Number(process.env.GEMINI_SESSION_TTL_MS || 30 * 60 * 1000); // 30 minutes
// Booked sessions (confirmed appointments) should persist much longer to avoid losing booking context if user replies slowly
const BOOKED_TTL_MS = Number(process.env.GEMINI_BOOKED_SESSION_TTL_MS || 7 * 24 * 3600 * 1000); // 7 days
const DEBOUNCE_MS = Number(process.env.GEMINI_DEBOUNCE_MS || 2000);

const CAMILA_SYSTEM_PROMPT = `Eres "Camila", la asistente virtual del Centro Especializado en Reumatología y Salud Ósea.

Identidad y rol:
- Eres "Camila", asistente virtual: empática, humana, clara y resolutiva.
- Usa un tono cálido y profesional; respuestas breves de máximo 2-3 párrafos cortos.

Base de conocimiento y precios referenciales:
- Opción 1: Orientación / Síntomas
  - Escucha atentamente: dolor de rodillas, espalda, manos, rigidez matutina, inflamación, sensación de desgaste.
  - Si los síntomas son articulares o de desgaste, sugiere Consulta con Reumatología.
  - Si hay sospecha de descalcificación, antecedentes de fracturas o es un chequeo preventivo, sugiere Densitometría Ósea.

- Opción 2: Densitometría Ósea
  - Precio referencial: S/ 80.00 (cadera y columna / cuerpo según disponibilidad).
  - Horarios: Lunes a Viernes 08:00-18:00; Sábados 08:00-13:00.
  - No requiere orden médica obligatoria si es un chequeo preventivo; si tiene orden médica, indícalo.

- Opción 3: Consulta Médica Especializada
  - Precio referencial: S/ 120.00 por consulta.
  - Especialistas disponibles: Dr. Carlos Mendoza (Reumatólogo clínico), Dra. Mariana Flores (Especialista en Artritis y Artrosis).
  - Horarios de atención: Mañana 09:00-13:00, Tarde 15:00-19:00.

- Opción 4: Suplementos y Farmacia
  - Calcio Citrato + Vitamina D3 — S/ 65.00 (frasco 60 tab).
  - Colágeno Hidrolizado Articular — S/ 85.00 (pote 300g).
  - Magnesio Quelado + Zinc — S/ 55.00.
  - Delivery Lima: S/ 10.00 extra o recojo en sede.

Flujo de agendamiento y cierre:
- El paciente puede consultar por varios servicios sin reiniciar la conversación.
- Para confirmar una cita o pedido, solicita amablemente y de uno en uno: Nombre completo, distrito y fecha/horario preferido.
- Al recibir esos datos, confirma el resumen (Servicio/Especialista o Examen, Fecha, Hora y Precio) y avisa que un asesor se comunicará por WhatsApp para la confirmación final.

Reglas operativas:
- Nunca pidas más de un dato a la vez; prioriza la claridad y la empatía.
- No inventes horarios ni precios fuera de los referencia proporcionados.
- Si el usuario entrega un número de teléfono o dice "a este número", reconoce que es el remitente actual y no preguntes otro número.
- No des diagnósticos médicos; orienta y sugiere acudir a consulta cuando corresponda.
- Mantén el hilo de la conversación: recuerda nombre y datos ya confirmados en la sesión.

Comportamiento en fallos:
- Si hay un error técnico o la IA no responde, responde con un mensaje amable pidiendo la consulta o teléfono: "Lo siento, en este momento estamos con problemas técnicos. Por favor deja tu consulta y tu teléfono y te contactaremos lo antes posible."`;

// Menú principal corto a usar como fallback visible al usuario cuando Gemini falla
const MAIN_MENU_TEXT = `¡Hola! Te damos la bienvenida a nuestro Centro Especializado en Reumatología y Salud Ósea 🦴✨

Por favor, selecciona el número de la opción que necesitas o escríbenos tu consulta:

1️⃣ Atención General / Información 🏥
2️⃣ Densitometría Ósea (diagnóstico de osteoporosis y masa ósea) 🔬
3️⃣ Consulta Médica con Especialista en Reumatología 👨‍⚕️👩‍⚕️
4️⃣ Medicinas, Suplementos y Calcio 💊

¿En qué podemos ayudarte hoy?`

const MAX_HISTORY_MESSAGES = Number(process.env.GEMINI_MAX_HISTORY || 10);
const CLEANUP_MS = Number(process.env.GEMINI_CLEANUP_MS || 60 * 1000);
const CONTINGENCY_MESSAGE = process.env.GEMINI_CONTINGENCY_MESSAGE || 'Lo siento, en este momento estamos con problemas técnicos. Por favor deja tu consulta y tu número de teléfono y te contactaremos lo antes posible.';

const chatSessions = new Map(); // sessionId -> { history: [], timer, paused: false }
const failureCounts = new Map(); // sessionId -> consecutive failure count

// Pause map helper exposed for handover control
export function pauseSessionById(sessionId) {
  const sid = String(sessionId || '').split('@')[0];
  const entry = chatSessions.get(sid);
  if (entry) {
    entry.paused = true;
    return true;
  }
  // create an entry flagged as paused so future messages are ignored until resumed
  chatSessions.set(sid, { history: [], timer: null, paused: true });
  return true;
}

export function resumeSessionById(sessionId) {
  const sid = String(sessionId || '').split('@')[0];
  const entry = chatSessions.get(sid);
  if (entry) {
    entry.paused = false;
    return true;
  }
  return false;
}

export function isSessionPaused(sessionId) {
  const sid = String(sessionId || '').split('@')[0];
  const entry = chatSessions.get(sid);
  return Boolean(entry && entry.paused);
}

function getSessionId(jid) {
  return (jid || '').split('@')[0];
}

function resetSessionTimer(sessionId, entry) {
  if (entry.timer) clearTimeout(entry.timer);
  // If the session is booked (appointment confirmed), extend the TTL to BOOKED_TTL_MS to retain context
  const delay = (entry && entry.booked) ? BOOKED_TTL_MS : TTL_MS;
  entry.timer = setTimeout(() => {
    // Only delete non-booked sessions; if booked, respect the longer TTL and delete only when it expires
    chatSessions.delete(sessionId);
    failureCounts.delete(sessionId);
    // console.log(`Gemini: cleared session ${sessionId} due to inactivity`);
  }, delay);
  entry.timer.unref && entry.timer.unref();
}

async function restoreSessionFromDb(sessionId, entry) {
  try {
    const { getByPhone } = await import('./leadService.js');
    if (typeof getByPhone !== 'function') return;
    const existing = await getByPhone(sessionId);
    if (!existing) return;

    const snap = existing.lead_snapshot || {};
    const cleanDistrito = (function(d) {
      if (!d || typeof d !== 'string') return null;
      const low = d.toLowerCase().trim();
      const banned = ['nuestra clínica', 'nuestra clinica', 'en lima', 'lima', 'no proporcionado', 'no proporcionada'];
      for (const b of banned) if (low.includes(b)) return null;
      if (!isLikelyDistrict(d)) return null;
      return d;
    })(snap.distrito || existing.distrito);

    entry.booked = Boolean(existing.ready_to_notify);
    entry.leadSnapshot = {
      nombre: snap.nombre || existing.nombre || null,
      telefono: snap.telefono || existing.telefono || null,
      distrito: cleanDistrito || snap.distrito || existing.distrito || null,
      fecha_hora_texto: snap.fecha_hora_texto || existing.fecha_hora_texto || null,
      fecha_hora_iso: snap.fecha_hora_iso || existing.fecha_hora_iso || null,
      confirmedAt: snap.confirmedAt || existing.confirmed_at || null
    };

    if (!entry.booked && entry.leadSnapshot && entry.leadSnapshot.nombre && entry.leadSnapshot.distrito && entry.leadSnapshot.fecha_hora_iso) {
      entry.awaitingConfirmation = true;
    }

    resetSessionTimer(sessionId, entry);
  } catch (e) {
    // non fatal: DB not configured or import failed in test environments
  }
}

function cleanupSessions() {
  const now = Date.now();
  for (const [sid, entry] of chatSessions) {
    // rely on timer to cleanup; additional pass not strictly necessary here
  }
}

const cleanupInterval = setInterval(cleanupSessions, CLEANUP_MS);
cleanupInterval.unref && cleanupInterval.unref();

export function mergeRecentUserMessages(history, windowMs = 10000) {
  // Merge consecutive user messages within windowMs into a single consolidated message string.
  if (!Array.isArray(history) || history.length === 0) return [];
  const merged = [];
  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    if (item.role === 'user') {
      const last = merged.length ? merged[merged.length - 1] : null;
      const ts = item.at || 0;
      const text = (item.parts || []).map(p => p.text || '').join(' ').trim();
      if (!text) continue;
      if (last && last.role === 'user' && Math.abs((ts - (last.at || 0))) <= windowMs) {
        // concatenate
        last.text = `${last.text} ${text}`.trim();
        last.at = Math.max(last.at || 0, ts);
      } else {
        merged.push({ role: 'user', text, at: ts });
      }
    } else {
      const text = (item.parts || []).map(p => p.text || '').join(' ').trim();
      if (!text) continue;
      merged.push({ role: 'model', text, at: item.at || 0 });
    }
  }
  return merged;
}

function formatHistoryForPrompt(history, mergeWindowMs = 10000) {
  const normalized = mergeRecentUserMessages(history, mergeWindowMs);
  return normalized.map((h) => {
    const role = h.role === 'user' ? 'Cliente' : 'Camila';
    const text = h.text || '';
    return text ? `${role}: ${text}` : '';
  }).filter(Boolean).join('\n');
}

function hasSchedulingIntent(message, history) {
  if (!message) return false;
  const text = [message, formatHistoryForPrompt(history)].filter(Boolean).join(' ').toLowerCase();
  const keywords = ['cita','agendar','reservar','agenda','horario','fecha','turno','consulta','consultar'];
  return keywords.some(k => text.includes(k));
}

// Simple heuristic parser for lead data (fallback)
import { isValidDistrict } from './districts.js';

function isLikelyDistrict(text) {
  if (!text || typeof text !== 'string') return false;
  // Use strict validation against the canonical list with fuzzy matching
  return isValidDistrict(text);
}

export function extractLeadDataFromText(text) {
 if (!text) return null;
 const t = text.toLowerCase();

 // Detect explicit "soy de X" or "vivo en X" as distrito
 const distritoFromSoy = t.match(/(?:soy\s+(?:de|del)|vivo\s+en)\s+([a-záéíóúñü\s]{2,60})(?:[,\.\n]|$)/i);
 const distrito = distritoFromSoy ? distritoFromSoy[1].trim() : null;
 
 // Name extraction: support typos like "me llamos" or "me llasmo" and avoid capturing phrases like "soy de ..." by negative lookahead
 // Capture up to 3-word names after common phrases like "me llamo", "mi nombre es", or "soy".
 // Stop capture at common connectors such as 'vivo', 'vi', 'mi', 'tengo', 'y', 'con' or punctuation.
 const nombreMatch = text.match(/(?:me\s+llam(?:o|os|smo)|me\s+llasm[oó]|me\s+llamo|mi\s+nombre\s+es)\s+([a-záéíóúñü]+(?:\s+[a-záéíóúñü]+){0,2})(?=\s*(?:[,\.\n]|vivo\b|vivo\s+en\b|vi\b|mi\b|mi\s+telefono|mi\s+número|tengo\b|y\b|con\b|$))/i)
   || text.match(/(?:soy)\s+(?!de\b|del\b|en\b)([a-záéíóúñü]+(?:\s+[a-záéíóúñü]+){0,2})(?=\s*(?:[,\.\n]|vivo\b|vivo\s+en\b|vi\b|mi\b|mi\s+telefono|mi\s+número|tengo\b|y\b|con\b|$))/i);
 const nombre = nombreMatch ? nombreMatch[1].trim().replace(/\s+/g,' ') : null;
 
 const digitString = t.replace(/[^0-9]/g, "");
 const telefonoMatch = digitString.match(/(?:^51)?(9\d{8})/);
 // DO NOT use telefono extracted from text as primary key. It can be used as reference only.
 const telefono = telefonoMatch ? telefonoMatch[1] : null;

 const distritoMatch = distrito || t.match(/vivo en\s+([a-záéíóúñü\s]{2,60})(?:[,\.\n]|\s+y\b|$)/i) || t.match(/en\s+([a-záéíóúñü\s]{2,60})(?:[,\.\n]|\s+y\b|$)/i);
 const distritoCandidate = distritoMatch ? (typeof distritoMatch === 'string' ? distritoMatch : (distritoMatch[1] ? distritoMatch[1].trim() : null)) : null;

 // Validate district strictly against canonical list; if not valid, do not set
 const distritoFinal = distritoCandidate && isLikelyDistrict(distritoCandidate) ? distritoCandidate : null;

 const explicitWeekdayDateMatch = t.match(/\b(?:lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)\s+\d{1,2}\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+(?:a\s*las?)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i);
 if (explicitWeekdayDateMatch) {
   return { nombre: nombre ?? null, telefono: telefono ?? null, distrito: distritoFinal ?? null, fechaHora: explicitWeekdayDateMatch[0].trim() };
 }
 
 const explicitDateMatch = t.match(/\b\d{1,2}\s*(?:de\s*)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+(?:a\s*las?)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i);
 if (explicitDateMatch) {
   return { nombre: nombre ?? null, telefono: telefono ?? null, distrito: distritoFinal ?? null, fechaHora: explicitDateMatch[0].trim() };
 }
 
 const fechaMatch = t.match(/(?:puedo\s+)?(el\s+)?((?:hoy|mañana|pasado\s+mañana|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo))(?:\s+(?:a\s+las)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i);
 const fechaHora = fechaMatch ? fechaMatch[0].trim() : null;

 return { nombre: nombre ?? null, telefono: telefono ?? null, distrito: distritoFinal ?? null, fechaHora: fechaHora ?? null };
}

function normalizeLeadData(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  return {
    nombre: parsed.nombre || parsed.name || null,
    telefono: parsed.telefono ? String(parsed.telefono).replace(/\D/g, '') : null,
    distrito: parsed.distrito || parsed.district || null,
    fechaHora: parsed.fechaHoraTexto || parsed.fecha_hora_texto || parsed.fecha_hora || parsed.fechaHora || null,
    // Do not trust model-provided ready flag; server will validate before setting
    ready_to_notify: false,
  };
}

// Helper: normalize and remove diacritics
function normalizeTextForCompare(s) {
  if (!s || typeof s !== 'string') return '';
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
}

function isValidPhoneNumber9(telefono) {
  if (!telefono) return false;
  const t = String(telefono).replace(/\D/g, '');
  return /^9\d{8}$/.test(t);
}

export function isValidName(nombre) {
  if (!nombre || typeof nombre !== 'string') return false;
  const n = nombre.trim();
  if (n.length < 2) return false;
  // reject the literal placeholder the system sometimes uses
  if (normalizeTextForCompare(n) === 'no proporcionado') return false;
  // reject assistant name or phrases
  if (/^camila\b/i.test(n)) return false;
  // reject if contains question forms or system prompts
  if (/\b(qué|cuál|cuando|a qué|a este número|dónde|donde)\b/i.test(n)) return false;
  return true;
}

function isValidDistrictName(distrito) {
  if (!distrito || typeof distrito !== 'string') return false;
  try {
    // Prefer centralized validator
    return isValidDistrict(distrito);
  } catch (e) {
    // Fallback: simple normalization + substring match against known items if available
    try {
      const n = normalizeTextForCompare(distrito);
      // If the districts module exposes a list, attempt to use it safely
      if (Array.isArray(typeof DISTRICTS !== 'undefined' ? DISTRICTS : [])) {
        for (const d of DISTRICTS) {
          if (String(d).toLowerCase && n.includes(String(d).toLowerCase())) return true;
        }
      }
    } catch (err) {
      // ignore
    }
    return isLikelyDistrict(distrito);
  }
}

export function isExplicitConfirmation(text) {
  if (!text || typeof text !== 'string') return false;
  const normalized = text.trim().toLowerCase();
  const disqualifiers = /\b(pero|aunque|sin embargo|cambiar|cambio|reprogramar|reagendar|mover|posponer|adelantar|otra hora|otro horario|otra fecha|mejor el|mejor|no puedo|no quiero|prefiero|prefiero otro|espera|esperame|un segundo|segundo|más tarde|mas tarde|después|despues|luego|quizás|quizas|si,? pero)\b/i;
  if (disqualifiers.test(normalized)) return false;
  return /^(?:sí|si|confirmo|confirmado|correcto|vale|perfecto|ok|claro|de acuerdo|gracias)(?:[.,!]?\s*(?:sí|si|confirmo|confirmado|correcto|vale|perfecto|ok|claro|de acuerdo|gracias|todo bien|la cita|la hora|lo confirmo|confirmo la cita|confirmo la hora))*$/i.test(normalized);
}

function finalizeLeadData(lead) {
  if (!lead || typeof lead !== 'object') return null;
  // normalize phone
  if (lead.telefono) lead.telefono = String(lead.telefono).replace(/\D/g, '');

  // If textual fechaHora exists but no ISO, try to parse
  if (lead.fechaHora && !lead.fechaHoraISO) {
    try {
      const iso = parseTextToLimaISO(lead.fechaHora);
      if (iso) {
        lead.fechaHoraISO = iso;
        const explicitText = formatLimaFechaHoraText(iso);
        if (explicitText) lead.fechaHora = explicitText;
      }
    } catch (e) {
      // ignore parse failures
    }
  }

  const hasValidPhone = isValidPhoneNumber9(lead.telefono);
  const hasValidName = isValidName(lead.nombre);
  const hasValidDistrict = isValidDistrictName(lead.distrito);
  const hasValidFechaISO = Boolean(lead.fechaHoraISO && typeof lead.fechaHoraISO === 'string');

  // Respect clinic hours configuration: if the parsed date falls outside diasAtencion, do NOT mark ready_to_notify.
  let withinClinicDays = true;
  try {
    const clinicCfg = (config && config.clinicHours) ? config.clinicHours : { diasAtencion: [1,2,3,4,5,6] };
    if (hasValidFechaISO) {
      const parsedDate = new Date(lead.fechaHoraISO);
      if (!Number.isNaN(parsedDate.getTime())) {
        // Derive weekday in Lima timezone by formatting weekday name and mapping to index
        const limaWeekdayName = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', weekday: 'long' }).format(parsedDate).toLowerCase();
        const weekdayMap = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3, jueves: 4, viernes: 5, sabado: 6, sábado: 6 };
        const weekdayIndex = typeof weekdayMap[limaWeekdayName] === 'number' ? weekdayMap[limaWeekdayName] : parsedDate.getUTCDay();
        withinClinicDays = Array.isArray(clinicCfg.diasAtencion) ? clinicCfg.diasAtencion.includes(weekdayIndex) : true;
      }
    } else if (lead.fechaHora && typeof lead.fechaHora === 'string') {
      // If we don't have an ISO but the textual fechaHora explicitly mentions a weekday, use that to detect outside clinic hours.
      const t = lead.fechaHora.toLowerCase();
      const weekdayMapText = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, 'miércoles': 3, jueves: 4, viernes: 5, sabado: 6, 'sábado': 6 };
      for (const [name, idx] of Object.entries(weekdayMapText)) {
        if (t.includes(name)) {
          withinClinicDays = Array.isArray(clinicCfg.diasAtencion) ? clinicCfg.diasAtencion.includes(idx) : true;
          if (!withinClinicDays) {
            lead.outsideClinicHours = true;
          }
          break;
        }
      }
    }
  } catch (e) {
    withinClinicDays = true; // conservative: if validation fails, do not block
  }

  lead.ready_to_notify = hasValidPhone && hasValidName && hasValidDistrict && hasValidFechaISO && withinClinicDays;
  if (!withinClinicDays) {
    // signal that the date is out of clinic hours so caller can inform user
    lead.outsideClinicHours = true;
  }

  return lead;
}


function extractLeadDataFromHistory(history) {
  if (!Array.isArray(history) || !history.length) return null;
  const userText = history
    .filter((h) => h.role === 'user')
    .map((h) => (h.parts || []).map((p) => p.text || '').join(' ').trim())
    .filter(Boolean)
    .join('\n');
  return extractLeadDataFromText(userText);
}

export function getOrCreateSession(jid) {
  const sid = getSessionId(jid);
  let entry = chatSessions.get(sid);
  if (!entry) {
    entry = { history: [], timer: null, lastUserMessageAt: 0, booked: false, leadSnapshot: null, awaitingConfirmation: false };
    entry.restorePromise = restoreSessionFromDb(sid, entry);
    chatSessions.set(sid, entry);
  }
  resetSessionTimer(sid, entry);
  return entry;
}

export async function ensureSessionLoaded(session) {
  if (session && session.restorePromise) {
    try {
      await session.restorePromise;
    } catch (e) {
      // ignore restore failures
    }
    session.restorePromise = null;
  }
  return session;
}

function isStructuredGeminiClient(client) {
  return client && typeof client.generateContent === 'function';
}
 
function extractTextFromCandidate(candidate) {
  if (!candidate?.content?.parts) return '';
  return candidate.content.parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
}

function extractTextFromResult(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (typeof result.text === 'string') return result.text;
  if (result.response) {
    if (typeof result.response.text === 'string') return result.response.text;
    const candidate = Array.isArray(result.response.candidates) ? result.response.candidates[0] : null;
    return extractTextFromCandidate(candidate);
  }
  return '';
}

function extractTextFromParsedJson(parsed) {
  if (parsed == null) return '';
  if (typeof parsed === 'string') return parsed.trim();
  if (typeof parsed === 'number' || typeof parsed === 'boolean') return String(parsed);
  if (Array.isArray(parsed)) {
    return parsed.map(extractTextFromParsedJson).filter(Boolean).join(' ');
  }

  const candidateKeys = ['content', 'respuesta', 'response', 'texto', 'text', 'message'];
  for (const key of candidateKeys) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      const extracted = extractTextFromParsedJson(parsed[key]);
      if (extracted) return extracted;
    }
  }

  if (parsed.content && typeof parsed.content === 'object') {
    const extracted = extractTextFromParsedJson(parsed.content);
    if (extracted) return extracted;
  }

  if (parsed.response && typeof parsed.response === 'object') {
    const extracted = extractTextFromParsedJson(parsed.response);
    if (extracted) return extracted;
  }

  if (parsed.response?.content) {
    const extracted = extractTextFromParsedJson(parsed.response.content);
    if (extracted) return extracted;
  }

  for (const value of Object.values(parsed)) {
    const extracted = extractTextFromParsedJson(value);
    if (extracted) return extracted;
  }

  return '';
}

// === LIMPIEZA DE STRINGS JSON EN geminiService.js ===
export function sanitizeModelTextOutput(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  
  let cleaned = rawText.trim();

  // 1. Eliminar etiquetas LEAD_JSON (completas o truncadas por el modelo)
  cleaned = cleaned.replace(/<<<LEAD_JSON>>>[\s\S]*?(?:<<<END_LEAD_JSON>>>|$)/gi, '');
  cleaned = cleaned.replace(/<<<[\s\S]*?$/gi, ''); // Limpiar cualquier residuo de tag inconcluso
  cleaned = cleaned.replace(/<+$/g, '');            // Limpiar símbolos '<' sueltos al final
  // 1.5 Eliminar cualquier texto de alerta interna destinado al administrador
  cleaned = cleaned.replace(/🚨\s*¡NUEVO PACIENTE AGENDADO![\s\S]*$/gi, '').trim();

  // 2. Eliminar bloques de código Markdown ```json ... ```
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // 3. Desempaquetar si viene en formato JSON stringify
  if (/^[\[{]/.test(cleaned)) {
    try {
      const parsed = JSON.parse(cleaned);

      // If the model returned a structured object with a top-level "response", prefer that.
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.response === 'string' && parsed.response.trim().length > 0) {
          return parsed.response.trim();
        }

        // If response is nested object with parts (structured Gemini), try to extract its text
        if (parsed.response && typeof parsed.response === 'object') {
          const nested = extractTextFromParsedJson(parsed.response);
          if (nested && nested.trim()) return nested.trim();
        }

        // If the payload looks like it contains lead data (LEAD_JSON key or personal fields), do NOT forward raw JSON.
        const containsLeadKeys = ('LEAD_JSON' in parsed) || ('lead' in parsed) || ('nombre' in parsed) || ('telefono' in parsed) || ('distrito' in parsed);
        if (containsLeadKeys) {
          // Try to extract any human-readable textual reply (message/text/content). If none, return a safe generic confirmation.
          const extracted = extractTextFromParsedJson(parsed);
          if (extracted && extracted.trim()) return extracted.trim();

          // Last-resort safe message to avoid leaking JSON to end-user
          return 'Gracias, registré tu solicitud. Te contactaré por este número para confirmar los detalles de la cita.';
        }

        // Generic traversal extraction if no explicit response key
        const extracted = extractTextFromParsedJson(parsed);
        if (extracted && extracted.trim()) {
          cleaned = extracted.trim();
        }
      }
    } catch (e) {
      // Fallback por expresiones regulares si el parseo estricto de JSON falla
      const malformedPrefixMatch = cleaned.match(/^\s*\{\s*"(?:content|respuesta|response|texto|text|message)"\s*:\s*"?(.*)$/i);
      if (malformedPrefixMatch && malformedPrefixMatch[1]) {
        cleaned = malformedPrefixMatch[1].replace(/\}?\s*$/,'').replace(/^"/, '').trim();
      } else {
        const match = cleaned.match(/"(?:content|respuesta|response|texto|text|message)"\s*:\s*"([\s\S]*?)"\s*\}?$/i);
        if (match && match[1]) {
          cleaned = match[1];
        }
      }
    }
  }

  // 4. Limpieza de comillas dobles externas o saltos de línea sobrantes
  cleaned = cleaned.replace(/^"/, '').replace(/"$/, '').trim();

  return cleaned;
}

function getCurrentPhoneHint(jid) {
  const phone = getSessionId(jid);
  return phone ? `El usuario escribe desde el número de WhatsApp ${phone}. Si el usuario pide "a este número" o menciona el número actual, reconoce que se refiere a este número y no vuelvas a preguntar por teléfono.` : '';
}

/**
 * Obtiene la fecha y hora actual formateada explícitamente para el huso horario de Lima.
 */
function getLimaCurrentDateTime() {
  const now = new Date(Date.now());
  const options = {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  };
  return new Intl.DateTimeFormat('es-PE', options).format(now);
}

/**
 * Construye el prompt de sistema dinámico incluyendo el contexto temporal y de WhatsApp.
 */
export function buildSystemPromptWithContext(jid, session = null, clinic = null) {
  const fechaActual = getLimaCurrentDateTime();
  const phoneHint = getCurrentPhoneHint(jid);

  // Determine clinic name fallback and patient name from session if available
  const clinicName = (clinic && clinic.name) ? clinic.name : (config.clinicNameFallback || 'Centro Especializado en Reumatología y Salud Ósea');
  let patientName = null;
  try {
    if (session && session.leadSnapshot && isValidName(session.leadSnapshot.nombre)) {
      patientName = session.leadSnapshot.nombre;
    } else if (session && Array.isArray(session.history)) {
      const hist = session.history.slice().reverse();
      for (const h of hist) {
        if (h.role === 'user') {
          const t = (h.parts || []).map(p => p.text || '').join(' ').trim();
          const parsed = extractLeadDataFromText(t) || {};
          if (parsed && parsed.nombre && isValidName(parsed.nombre)) {
            patientName = parsed.nombre;
            break;
          }
        }
      }
    }
  } catch (e) {
    patientName = null;
  }

  // Apply safe prompt placeholders replacements
  let promptBase = CAMILA_SYSTEM_PROMPT.replace(/\[NOMBRE_CLINICA\]/g, clinicName);
  if (patientName) {
    promptBase = promptBase.replace(/\[NOMBRE_PACIENTE\]/g, patientName);
    promptBase = promptBase + `\n- PACIENTE CONFIRMADO: ${patientName}`;
  } else {
    promptBase = promptBase.replace(/\[NOMBRE_PACIENTE\]/g, 'estimado/a paciente');
  }

  if (session && session.leadSnapshot) {
    try {
      const snap = session.leadSnapshot;
      const confirmedValues = [];
      if (snap.nombre) confirmedValues.push(`Nombre: ${snap.nombre}`);
      if (snap.telefono) confirmedValues.push(`Teléfono: ${snap.telefono}`);
      if (snap.distrito) confirmedValues.push(`Distrito: ${snap.distrito}`);
      if (snap.fecha_hora_texto) confirmedValues.push(`Fecha/Hora: ${snap.fecha_hora_texto}`);
      if (confirmedValues.length) {
        promptBase = promptBase + `\n\n- AVISO: Estos datos ya están confirmados en la sesión: ${confirmedValues.join(', ')}. No vuelvas a pedirlos ni los reemplaces a menos que el usuario los corrija explícitamente.`;
      }
      if (session.booked) {
        promptBase = promptBase + `\n- AVISO ADICIONAL: Este usuario ya tiene una cita agendada. Responde dudas post-agendamiento o procesa reprogramaciones solo si el usuario lo solicita explícitamente.`;
      }
    } catch (e) { /* ignore */ }
  }

  return `${promptBase}\n\n[CONTEXTO TEMPORAL Y DE SISTEMA EN VIVO]\n- FECHA Y HORA ACTUAL EN LIMA: ${fechaActual}\n- REGLA DE TIEMPO: Usa esta fecha actual de Lima como tu única referencia absoluta para calcular "hoy", "mañana", "el próximo lunes", o fechas específicas solicitadas por el cliente. No asumas años ni meses pasados.${phoneHint ? `\n${phoneHint}` : ''}`;
}

/**
 * Parsea texto libre de fecha/hora relativo a Lima y devuelve ISO 8601 en UTC (+00:00).
 * Ejemplos aceptados: "hoy a las 3pm", "mañana 16:00", "el jueves a las 4pm", "3 de agosto a las 10:30"
 */
export function parseTextToLimaISO(fechaTexto) {
  // parseTextToLimaISO kept for backwards compat: tries to parse date+time and returns ISO only when time found

  if (!fechaTexto || typeof fechaTexto !== 'string') return null;
  const txt = fechaTexto.toLowerCase();

  // Obtener fecha base en Lima (YYYY-MM-DD)
  const now = new Date(Date.now());
  const limaDateStr = now.toLocaleString('sv-SE', { timeZone: 'America/Lima' }).split(' ')[0];
  const [baseYear, baseMonth, baseDay] = limaDateStr.split('-').map((s) => parseInt(s, 10));
  let target = new Date(Date.UTC(baseYear, baseMonth - 1, baseDay)); // use UTC date arithmetic

  // Mappings
  const weekdays = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3, jueves: 4, viernes: 5, sabado: 6, sábado: 6 };
  const months = {
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
    julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12
  };

  // Relative days
  if (txt.includes('pasado mañana')) {
    target.setUTCDate(target.getUTCDate() + 2);
  } else if (txt.includes('mañana')) {
    target.setUTCDate(target.getUTCDate() + 1);
  } else if (txt.includes('hoy')) {
    // no change
  } else {
    // If user says 'próxima semana' explicitly, anchor to next week's Monday before resolving weekday
    if (/pr[oó]xima\s+semana/i.test(txt)) {
      const currentWeekday = target.getUTCDay(); // 0=Sun..6=Sat
      // days until next Monday: (8 - currentWeekday) % 7 (ensure at least 1 week ahead)
      const daysToNextMonday = ((8 - currentWeekday) % 7) || 7;
      target.setUTCDate(target.getUTCDate() + daysToNextMonday);
    }

    // Weekday names
    for (const [name, idx] of Object.entries(weekdays)) {
      if (txt.includes(name)) {
        // advance until weekday matches
        const maxIter = 14;
        let iter = 0;
        while (target.getUTCDay() !== idx && iter < maxIter) {
          target.setUTCDate(target.getUTCDate() + 1);
          iter += 1;
        }
        break;
      }
    }

    // Explicit day e.g., '3 de agosto' or '3 agosto'
    const explicitDateMatch = txt.match(/(\d{1,2})\s*(?:de\s*)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i);
    if (explicitDateMatch) {
      const dayNum = parseInt(explicitDateMatch[1], 10);
      const monthName = explicitDateMatch[2].toLowerCase();
      const monthNum = months[monthName];
      if (monthNum) {
        // Keep year same as base; adjust year only if month less than current month? Avoid future-year assumptions.
        let year = baseYear;
        if (monthNum < baseMonth) year = baseYear;
        target = new Date(Date.UTC(year, monthNum - 1, dayNum));
      }
    }
  }

  // Expose helper: return just the target date (UTC midnight) for date-only parsing
  // This will be used by saveLead to combine day-only incoming text with previously stored time.
  // Note: this function early-returns when there's an explicit time later; here we simply return the computed target date.
  // (The time-handling code follows after this block.)

  // Time parsing
  let hour = 12;
  let minute = 0;
  const timeMatchAmPm = txt.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  const timeMatch24 = txt.match(/(\d{1,2}):(\d{2})/);
  const timeMatchPlain = txt.match(/(?:a\s*las|a|\bat\b)?\s*(\d{1,2})\s*(?:hm|h|hrs|horas)?\s*(am|pm)?/i);

  // If no explicit time provided, treat as incomplete: do not assume a default time.
  // Returning null will indicate that fechaHora is incomplete (missing time) and should not be persisted as an ISO datetime.
  // However, callers might want only the date part — use parseTextToLimaDate for that use-case.

  if (timeMatchAmPm) {
    hour = parseInt(timeMatchAmPm[1], 10);
    minute = timeMatchAmPm[2] ? parseInt(timeMatchAmPm[2], 10) : 0;
    const ampm = (timeMatchAmPm[3] || '').toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
  } else if (timeMatch24) {
    hour = parseInt(timeMatch24[1], 10);
    minute = parseInt(timeMatch24[2], 10);
  } else if (timeMatchPlain) {
    hour = parseInt(timeMatchPlain[1], 10);
    minute = 0;
    const ampm = (timeMatchPlain[2] || '').toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
  } else {
    // If no explicit time provided, treat as incomplete: do not assume a default time.
    // Returning null will indicate that fechaHora is incomplete (missing time) and should not be persisted as an ISO datetime.
    return null;
  }

  // Build a UTC ISO string from Lima local time by applying the -05:00 offset.
  const limaUtcDate = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), hour + 5, minute, 0));
  return limaUtcDate.toISOString().replace(/\.000Z$/, '+00:00');
}

// Parse a date-only textual expression into a UTC Date representing the target day in Lima (UTC midnight for that local day).
export function parseTextToLimaDate(fechaTexto) {  if (!fechaTexto || typeof fechaTexto !== 'string') return null;
  const txt = fechaTexto.toLowerCase();

  const now = new Date(Date.now());
  const limaDateStr = now.toLocaleString('sv-SE', { timeZone: 'America/Lima' }).split(' ')[0];
  const [baseYear, baseMonth, baseDay] = limaDateStr.split('-').map((s) => parseInt(s, 10));
  let target = new Date(Date.UTC(baseYear, baseMonth - 1, baseDay));

  const weekdays = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3, jueves: 4, viernes: 5, sabado: 6, sábado: 6 };
  const months = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };

  if (txt.includes('pasado mañana')) {
    target.setUTCDate(target.getUTCDate() + 2);
  } else if (txt.includes('mañana')) {
    target.setUTCDate(target.getUTCDate() + 1);
  } else if (txt.includes('hoy')) {
    // no change
  } else {
    for (const [name, idx] of Object.entries(weekdays)) {
      if (txt.includes(name)) {
        const maxIter = 14;
        let iter = 0;
        while (target.getUTCDay() !== idx && iter < maxIter) {
          target.setUTCDate(target.getUTCDate() + 1);
          iter += 1;
        }
        break;
      }
    }

    const explicitDateMatch = txt.match(/(\d{1,2})\s*(?:de\s*)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i);
    if (explicitDateMatch) {
      const dayNum = parseInt(explicitDateMatch[1], 10);
      const monthName = explicitDateMatch[2].toLowerCase();
      const monthNum = months[monthName];
      if (monthNum) {
        let year = baseYear;
        if (monthNum < baseMonth) year = baseYear;
        target = new Date(Date.UTC(year, monthNum - 1, dayNum));
      }
    }
  }

  return target;
}

export function formatLimaFechaHoraText(fechaHoraISO) {
  if (!fechaHoraISO || typeof fechaHoraISO !== 'string') return null;
  const parsed = new Date(fechaHoraISO);
  if (Number.isNaN(parsed.getTime())) return null;

  let datePart = new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(parsed);

  const timePart = new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(parsed);

  datePart = datePart.replace(/\s*,\s*/, ' ');
  const normalizedTime = timePart
    .replace(/\s*a\.?\s*m\.?/i, ' AM')
    .replace(/\s*p\.?\s*m\.?/i, ' PM')
    .replace(/\u202F/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return `${datePart}, ${normalizedTime}`.replace(/\s+de\s+\d{4}/, '').trim();
}

/**
 * Prepara el request hacia la API de Gemini inyectando el prompt dinámico.
 */
function buildGeminiRequest(client, mensaje, history, jid, options = {}) {
  const historyText = formatHistoryForPrompt(history, 10000);
  const userText = `${historyText ? historyText + '\n' : ''}Cliente: ${mensaje}`;
  
  // Se obtiene el prompt enriquecido dinámicamente con Fecha de Lima, WhatsApp Hint y posibles placeholders inyectados
  const effectiveSystemPrompt = buildSystemPromptWithContext(jid, options.session || getOrCreateSession(jid), options.clinic);

  if (isStructuredGeminiClient(client)) {
    return {
      type: 'structured',
      request: {
        contents: [
          {
            role: 'user',
            parts: [{ text: userText }],
          },
        ],
        systemInstruction: effectiveSystemPrompt,
        generationConfig: {
          maxOutputTokens: options.maxOutputTokens || config.gemini?.maxOutputTokens || 100
        },
      },
    };
  }

  return {
    type: 'text',
    prompt: `${effectiveSystemPrompt}\n${userText}`,
  };
}

async function callClientWithRetries(client, geminiRequest, maxRetries = 1, options = {}) {
  // Attempt first the configured model (cleaned), then fall back to ALLOWED_MODELS order if a 404 is returned
  // Use the environment-provided model name exactly as-is for the first attempt
  const configuredModelRawLocal = (config && config.gemini && config.gemini.model) ? String(config.gemini.model) : (process.env.GEMINI_MODEL || '');
  const modelsToTry = configuredModelRawLocal ? [configuredModelRawLocal, ...ALLOWED_MODELS.filter((m) => m !== configuredModelRawLocal)] : [...ALLOWED_MODELS];

  // Helper to attempt a single call with a given model (ensures model name is cleaned before calling SDK)
  async function attemptCallWithModel(modelName) {
    // Use model name exactly as provided (do not sanitize or strip prefixes here)
    const rawModelToUse = String(modelName || '');
    console.info(`[geminiService] Attempting Gemini model (raw): "${rawModelToUse}"`);

    if (!client || (typeof client.generate !== 'function' && typeof client.generateContent !== 'function')) {
      const fallbackText = typeof geminiRequest === 'object' && geminiRequest.prompt ? geminiRequest.prompt : '';
      return { text: `Echo: ${String(fallbackText).slice(0, 200)}` };
    }

    // Structured client + structured request
    if (isStructuredGeminiClient(client) && geminiRequest?.type === 'structured') {
      return await client.generateContent(geminiRequest.request, { model: rawModelToUse });
    }

    // Legacy generate API
    if (typeof client.generate === 'function') {
      return await client.generate(geminiRequest.prompt || '', { model: rawModelToUse, maxOutputTokens: options.maxOutputTokens || config.gemini?.maxOutputTokens || 100 });
    }

    // Fallback to generateContent if available
    if (typeof client.generateContent === 'function' && geminiRequest?.type === 'structured') {
      return await client.generateContent(geminiRequest.request, { model: rawModelToUse });
    }

    throw new Error('Gemini client does not support generate or generateContent');
  }

  // For each model in order, try up to (maxRetries+1) attempts for transient errors; on 404 move to next model immediately
  let lastErr = null;
  for (const modelName of modelsToTry) {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        if (attempt > 0) {
          console.warn(`[geminiService] Retrying model ${modelName} attempt ${attempt + 1}/${maxRetries + 1}`);
        }
        const res = await attemptCallWithModel(modelName);
        return res;
      } catch (e) {
        lastErr = e;
        const status = e && (e.status || e.code || null);
        const msg = String(e && (e.message || ''));

        // Try to extract richer response body/details from common shapes
        let errorBody = null;
        try {
          errorBody = e && (e.response?.data || e.response?.body || e.body || e.data || e.rawResponse || null);
          if (!errorBody && e && e.response && typeof e.response.text === 'function') {
            // some SDKs expose a text() function on response
            try { errorBody = await e.response.text(); } catch (_) { /* ignore */ }
          }
        } catch (inner) {
          // ignore extraction errors
        }

        console.error(`[geminiService] Error for model ${modelName} -> status: ${status}, message: ${msg}`);
        if (errorBody) {
          try {
            console.error('[geminiService] Error body:', typeof errorBody === 'string' ? errorBody : JSON.stringify(errorBody));
          } catch (se) {
            console.error('[geminiService] Error body (stringify failed):', String(errorBody));
          }
        }

        // If 404 (model not found) then move to next model immediately
        if (status === 404 || /\b404\b/.test(msg) || /not available|no longer available|model not found/i.test(msg)) {
          console.warn(`[geminiService] Model ${modelName} returned 404 or not available. Trying next model in fallback list.`);
          break; // break retry loop and try next model
        }

        // For transient errors, allow retrying same model
        const isTransient = /timeout|network|ECONNRESET|ECONNREFUSED|5\d{2}/i.test(msg);
        if (!isTransient) {
          // Non-transient and not 404: abort entirely
          throw e;
        }

        // If this was the last attempt for this model, log and allow outer loop to try next model
        if (attempt === maxRetries) {
          console.warn(`[geminiService] Model ${modelName} failed after ${maxRetries + 1} attempts: ${msg}`);
        } else {
          // wait briefly before retry
          await new Promise((r) => setTimeout(r, attempt === 0 ? 500 : 1500));
          continue;
        }
      }
    }
  }

  throw lastErr || new Error('client failed');
}

export async function obtenerRespuestaIA(jid, mensaje, options = {}) {
  const client = options.client;
  const skipDebounce = Boolean(options.skipDebounce);
  const maxRetries = (typeof options.maxRetries === 'number') ? options.maxRetries : 1;
  const session = getOrCreateSession(jid);
  await ensureSessionLoaded(session);
  const now = Date.now();
  const sid = getSessionId(jid);
  const priorFailures = failureCounts.get(sid) || 0;
  // No debounce: process every incoming message immediately and keep session.lastUserMessageAt updated.
  session.lastUserMessageAt = now;
  session.history.push({ role: 'user', parts: [{ text: mensaje }] });
  session.history = session.history.slice(-MAX_HISTORY_MESSAGES);

  const geminiRequest = buildGeminiRequest(client, mensaje, session.history, jid, { ...options, session });

  try {
    const result = await callClientWithRetries(client, geminiRequest, maxRetries, options);
    const rawModelText = extractTextFromResult(result) || 'Disculpa, no pude procesar tu mensaje. ¿Puedes intentar decirlo de otra forma, por favor?';
    let rawText = rawModelText;
    // sanitize any JSON-wrapped or code-fenced responses from the model for user output only
    const sanitizedRawText = sanitizeModelTextOutput(rawModelText);

    let leadData = null;
    const leadRegex = /<<<LEAD_JSON>>>\s*([\s\S]*?)\s*<<<END_LEAD_JSON>>>/i;

    // If session already booked with a confirmed snapshot, do NOT re-parse or re-derive the fecha from history
    // unless the user explicitly expresses a reprogramming intent (cambiar, reprogramar, mover, posponer, reagendar, etc.).
    const reprogramPattern = /\b(cambiar|reprogramar|reagendar|mover|posponer|adelantar|cambio|cambiarlo|quiero cambiar|otro horario|otra hora|otra fecha|prefiero|mejor el|no puedo|no quiero|espera|esperame|después|despues|luego)\b/i;
    if (session && session.booked && session.leadSnapshot && session.leadSnapshot.fecha_hora_iso) {
      const alreadySnapshot = session.leadSnapshot;
      // If neither the user's message nor the model's raw text contains reprogram intent, return snapshot as the canonical leadData.
      if (!reprogramPattern.test(mensaje) && !reprogramPattern.test(rawText)) {
        try {
          leadData = finalizeLeadData({
            nombre: alreadySnapshot.nombre || null,
            telefono: alreadySnapshot.telefono || null,
            distrito: alreadySnapshot.distrito || null,
            fechaHora: alreadySnapshot.fecha_hora_texto || null,
            fechaHoraISO: alreadySnapshot.fecha_hora_iso || null,
            ready_to_notify: true
          });
        } catch (e) {
          leadData = null;
        }

        // Push the model text into history and return early to avoid any re-persistence or re-notification.
        session.history.push({ role: 'model', parts: [{ text: rawText }] });
        session.history = session.history.slice(-MAX_HISTORY_MESSAGES);
        const sid = getSessionId(jid);
        failureCounts.set(sid, 0);
        const texto = sanitizeModelTextOutput(rawText);
        return { texto, leadData, skipLeadPersistence: true };
      }
    }

    const match = leadRegex.exec(rawText);
    if (match && match[1]) {
      const jsonText = match[1].trim();
      // Extract candidate leads from other sources for fallbacks
      const rawLead = extractLeadDataFromText(rawText) || {};
      const messageLead = extractLeadDataFromText(mensaje) || {};
      const historyLead = extractLeadDataFromHistory(session.history) || {};
      const existingSnap = session.leadSnapshot || {};

      try {
          let parsed = normalizeLeadData(JSON.parse(jsonText));
          if (parsed && parsed.telefono) parsed.telefono = String(parsed.telefono).replace(/\D/g, '');

          // SECURITY: Do NOT trust model-provided nombre/telefono/distrito in LEAD_JSON.
          // Always prefer session.snapshot or historical validated values for these core fields.
          // Prefer validated snapshot/history/message values, but if none exist fall back to model-provided parsed values
          const finalNombre = existingSnap.nombre || historyLead.nombre || messageLead.nombre || parsed.nombre || null;
          const finalTelefono = existingSnap.telefono || historyLead.telefono || messageLead.telefono || parsed.telefono || null;

          // Sanitize district: prefer snapshot, else history, else message, but never accept generic/institutional phrases
          const candidateDistrito = existingSnap.distrito || historyLead.distrito || messageLead.distrito || parsed.distrito || null;
          const finalDistrito = (function(d) {
            if (!d || typeof d !== 'string') return null;
            const low = d.toLowerCase().trim();
            const banned = ['nuestra clínica', 'nuestra clinica', 'en lima', 'lima', 'no proporcionado', 'no proporcionada', 'el de siempre'];
            for (const b of banned) if (low.includes(b)) return null;
            if (!isLikelyDistrict(d)) return null;
            return d;
          })(candidateDistrito);

          // Only accept fecha from the model if it is present, but still validate/parse server-side
          const incomingFechaTexto = parsed.fechaHora || parsed.fecha_hora || parsed.fechaHoraTexto || null;

          const assembled = {
            nombre: finalNombre || null,
            telefono: finalTelefono || null,
            distrito: finalDistrito || null,
            fechaHora: incomingFechaTexto || null,
            ready_to_notify: false,
          };

          // finalize and validate lead data server-side (compute ISO and readiness)
          const finalized = finalizeLeadData(assembled);
          leadData = finalized;
        } catch (e) {
          console.warn('geminiService: failed to parse LEAD_JSON from model', e && e.message ? e.message : e);

          // Fallback: if parsing failed, build leadData from safe sources (session/history/message)
          const finalNombre = session.leadSnapshot?.nombre || historyLead.nombre || messageLead.nombre || null;
          const candidateDistrito = session.leadSnapshot?.distrito || historyLead.distrito || messageLead.distrito || null;
          const finalDistrito = (function(d) {
            if (!d || typeof d !== 'string') return null;
            const low = d.toLowerCase().trim();
            const banned = ['nuestra clínica', 'nuestra clinica', 'en lima', 'lima', 'no proporcionado', 'no proporcionada', 'el de siempre'];
            for (const b of banned) if (low.includes(b)) return null;
            if (!isLikelyDistrict(d)) return null;
            return d;
          })(candidateDistrito);

          const finalTelefono = session.leadSnapshot?.telefono || historyLead.telefono || messageLead.telefono || null;
          const finalFecha = messageLead.fechaHora || historyLead.fechaHora || null;

          leadData = finalizeLeadData({ nombre: finalNombre, telefono: finalTelefono, distrito: finalDistrito, fechaHora: finalFecha, ready_to_notify: false });
        }
      } else {
        const rawLead = extractLeadDataFromText(rawText) || {};
        const messageLead = extractLeadDataFromText(mensaje) || {};
        const historyLead = extractLeadDataFromHistory(session.history) || {};

        // SECURITY: do NOT trust dates extracted from the model's own output (rawLead) as a user confirmation.
        // Only accept fechaHora if it appears in the user's message (messageLead) or already in the conversation history (historyLead).
        const fechaFromUserOrHistory = messageLead.fechaHora || historyLead.fechaHora || null;

        leadData = {
          nombre: messageLead.nombre || rawLead.nombre || historyLead.nombre || null,
          telefono: messageLead.telefono || rawLead.telefono || historyLead.telefono || null,
          distrito: messageLead.distrito || rawLead.distrito || historyLead.distrito || null,
          fechaHora: fechaFromUserOrHistory,
        };

        // If any core field missing, enrich from history (but still do NOT accept rawLead.fechaHora as confirmation)
        if (!leadData.telefono || !leadData.nombre || !leadData.distrito || !leadData.fechaHora) {
          leadData = {
            nombre: leadData.nombre || historyLead.nombre || null,
            telefono: leadData.telefono || historyLead.telefono || null,
            distrito: leadData.distrito || historyLead.distrito || null,
            fechaHora: leadData.fechaHora || historyLead.fechaHora || null,
          };
        }
        // finalize and validate lead data server-side
        leadData = finalizeLeadData(leadData);
        if (!leadData || (!leadData.nombre && !leadData.telefono && !leadData.distrito && !leadData.fechaHora)) {
          leadData = null;
        }
      }

    // If we have a textual fechaHora, ensure fechaHoraISO is populated using parseTextToLimaISO
    if (leadData && leadData.fechaHora) {
      try {
        const iso = parseTextToLimaISO(leadData.fechaHora);
        if (iso) {
          leadData.fechaHoraISO = iso;
          const explicitText = formatLimaFechaHoraText(iso);
          if (explicitText) {
            leadData.fechaHora = explicitText;
          }
        }
      } catch (e) {
        console.warn('parseTextToLimaISO failed:', e && e.message ? e.message : e);
      }
    }

    session.history.push({ role: 'model', parts: [{ text: rawText }] });
    if (leadData && leadData.nombre && leadData.distrito && leadData.fechaHora && !session.history.some((h) => (h.parts || []).some((p) => typeof p.text === 'string' && p.text.includes('[SISTEMA - CITA REGISTRADA VERIFICADA:')))) {
      session.history.push({
        role: 'model',
        parts: [{ text: `[SISTEMA - CITA REGISTRADA VERIFICADA: Nombre: ${leadData.nombre}, Distrito: ${leadData.distrito}, Fecha/Hora Agendada: ${leadData.fechaHora}]` }]
      });

      // Mark session as booked and keep a snapshot of the confirmed lead data so follow-up turns do not re-ask core fields.
      try {
        // Only mark as booked and persist snapshot when not explicitly told to skip lead persistence (e.g., admin messages)
        if (!options || !options.skipLeadPersistence) {
          session.booked = true;
          session.leadSnapshot = {
            nombre: leadData.nombre || null,
            telefono: leadData.telefono || null,
            distrito: leadData.distrito || null,
            fecha_hora_texto: leadData.fechaHora || null,
            fecha_hora_iso: leadData.fechaHoraISO || null,
            confirmedAt: new Date().toISOString()
          };
          // Ensure timer respects booked TTL after marking booked
          try { resetSessionTimer(getSessionId(jid), session); } catch (e) { /* ignore */ }

          // Persist leadSnapshot to durable store so booked state survives restarts and TTL expiry
          try {
            const phoneFromJid = getSessionId(jid);
            // Dynamic import to avoid circular dependency
            const { saveLeadSnapshot } = await import('./leadService.js');
            // persist normalized phone + snapshot
            try {
              await saveLeadSnapshot(phoneFromJid, session.leadSnapshot);
            } catch (err) {
              console.warn('geminiService: failed to persist leadSnapshot', err && err.message ? err.message : err);
            }
          } catch (err) {
            // non fatal
          }
        } else {
          // Skip persistence for this session (e.g., admin sender). Still update in-memory history but do not mark booked or persist.
          console.log('geminiService: skipLeadPersistence option set for jid', jid);
        }
      } catch (e) { /* non fatal */ }
    }

    session.history = session.history.slice(-MAX_HISTORY_MESSAGES);

    const sid = getSessionId(jid);
    failureCounts.set(sid, 0);

    let texto = sanitizedRawText;

    // Protect against model hallucinations: if the model claims a booking ("ya quedó agendada", "tu cita quedó...", etc.)
    // but we do NOT have a confirmed fecha (neither in leadData nor in session.leadSnapshot), remove those assertions aggressively.
    try {
      const bookingClaimPattern = /\b(ya\s+qued[oó]\s+agendad[ao]|qued[oó]\s+agendad[ao]|tu\s+cita\b|tu\s+cita\s+(?:qued[oó]|est[aá]\s+agendada|ya\s+est[aá]))/i;
      const hasBookingClaim = bookingClaimPattern.test(texto || '');
      const hasConfirmedDate = Boolean((leadData && leadData.fechaHora) || (session.leadSnapshot && session.leadSnapshot.fecha_hora_texto));
      if (hasBookingClaim && !hasConfirmedDate) {
        // Remove any sentence that mentions 'cita' or booking verbs to be conservative
        const sentences = (texto || '').split(/[\.\?!]+/).map(s => s.trim()).filter(Boolean);
        const filtered = sentences.filter(s => !/\b(cita|qued[oó]|agendad|agendar|reservad|programad)\b/i.test(s));
        texto = (filtered.join('. ') || '').trim();
        if (!texto) texto = 'Gracias por tu mensaje. ¿Qué día y a qué hora prefieres para la cita?';
      }
    } catch (e) {
      // non-fatal: leave texto as-is
    }

    if (match) {
      texto = rawText.replace(leadRegex, '').trim();
      // sanitize again after removing LEAD_JSON block
      texto = sanitizeModelTextOutput(texto);
    }

    // Final safety net: if texto still contains booking claims but we have no confirmed fecha, replace with a neutral follow-up
    try {
      const bookingClaimPattern = /\b(ya\s+qued[oó]\s+agendad[ao]|qued[oó]\s+agendad[ao]|tu\s+cita\b|tu\s+cita\s+(?:qued[oó]|est[aá]\s+agendada|ya\s+est[aá]))/i;
      const hasBookingClaim = bookingClaimPattern.test(texto || '');
      const hasConfirmedDate = Boolean((leadData && leadData.fechaHora) || (session.leadSnapshot && session.leadSnapshot.fecha_hora_texto));
      if (hasBookingClaim && !hasConfirmedDate) {
        texto = 'Gracias por tu mensaje. ¿Qué día y a qué hora prefieres para la cita?';
      }
    } catch (e) {
      // ignore
    }

    return { texto, leadData, skipLeadPersistence: Boolean(options?.skipLeadPersistence) };
  } catch (e) {
    // Log detailed error and rethrow so controller can decide what to send to the user
    console.error('[geminiService] Gemini call failed (rethrowing):', e && (e.message || e));
    try {
      const sid = getSessionId(jid);
      const prev = failureCounts.get(sid) || 0;
      failureCounts.set(sid, prev + 1);
    } catch (_) { /* ignore */ }
    throw e;
  }
}

export async function generateResponseNoHistory(jid, mensaje, options = {}) {
  const client = options.client;
  // Ensure session exists and is loaded so we can access history for context (without mutating it)
  const session = getOrCreateSession(jid);
  await ensureSessionLoaded(session);

  const geminiRequest = buildGeminiRequest(client, mensaje, session.history || [], jid, { ...options, session });
  try {
    const result = await callClientWithRetries(client, geminiRequest, (typeof options.maxRetries === 'number') ? options.maxRetries : 1, options);
    const rawModelText = extractTextFromResult(result) || 'Disculpa, no pude procesar tu mensaje. ¿Puedes intentar decirlo de otra forma, por favor?';
    const texto = sanitizeModelTextOutput(rawModelText);

    // Try to extract lead JSON if present
    let leadData = null;
    try {
      const leadRegex = /<<<LEAD_JSON>>>\s*([\s\S]*?)\s*<<<END_LEAD_JSON>>>/i;
      const match = leadRegex.exec(rawModelText);
      if (match && match[1]) {
        try { leadData = normalizeLeadData(JSON.parse(match[1])); } catch (_) { leadData = null; }
      }
    } catch (_) { leadData = null; }

    return { texto, leadData };
  } catch (e) {
    console.error('[geminiService] generateResponseNoHistory failed:', e && (e.message || e));
    throw e;
  }
}

export default { obtenerRespuestaIA, generateResponseNoHistory, sanitizeModelTextOutput, isExplicitConfirmation, MAIN_MENU_TEXT, CONTINGENCY_MESSAGE, pauseSessionById, resumeSessionById, isSessionPaused };
