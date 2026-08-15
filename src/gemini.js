import './envLoader.js';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { SYSTEM_PROMPT } from './config.js';
import { saveLead } from './leads.js';


const apiKey = process.env.GEMINI_API_KEY;
// Preferred model order when a model is missing: try newest flash models first
const ALLOWED_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash-exp',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash-8b',
];
// Clean any possible "models/" prefix from env var; fall back to first allowed model
const geminiModelRaw = String(process.env.GEMINI_MODEL || '').trim();
const geminiModel = geminiModelRaw ? geminiModelRaw.replace(/^models\//i, '') : ALLOWED_MODELS[0];
console.info(`[src/gemini.js] GEMINI_MODEL raw: "${geminiModelRaw}" -> cleaned: "${geminiModel}"`);
console.info(`[src/gemini.js] ALLOWED_MODELS: ${JSON.stringify(ALLOWED_MODELS)}`);
const ttlMs = 30 * 60 * 1000;
const contingencyMessage = 'En este momento nuestro sistema está ocupado, un asesor te responderá a la brevedad.';
const chatSessions = new Map();
const MAX_HISTORY_MESSAGES = 8;
let model;

// Inicializa y cachea el modelo con configuración limitada de tokens y temperatura
// (Evita crear nuevas instancias repetidamente y controla maxOutputTokens para ahorrar tokens).
function getModel() {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY no está definido en las variables de entorno. Agrega la clave en .env o en el entorno.');
  }

  if (!model) {
    const genAI = new GoogleGenerativeAI(apiKey);
    model = genAI.getGenerativeModel({
      model: geminiModel,
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: {
        maxOutputTokens: 150,
        temperature: 0.7,
      },
    });
  }

  return model;
}

async function generateContentWithModelFallback(request) {
  const configured = geminiModel;
  const modelsToTry = [configured, ...ALLOWED_MODELS.filter((m) => m !== configured)];
  let lastErr = null;

  for (const modelName of modelsToTry) {
    try {
      const cleanModelName = String(modelName || '').replace(/^models\//i, '');
      const genAI = new GoogleGenerativeAI(apiKey);
      const m = genAI.getGenerativeModel({
        model: cleanModelName,
        systemInstruction: SYSTEM_PROMPT,
        generationConfig: { maxOutputTokens: 150, temperature: 0.7 },
      });
      return await m.generateContent(request);
    } catch (e) {
      lastErr = e;
      const status = e && (e.status || e.code || null);
      const msg = String(e && (e.message || ''));

      // Try to extract richer response body/details
      let errorBody = null;
      try {
        errorBody = e && (e.response?.data || e.response?.body || e.body || e.data || e.rawResponse || null);
        if (!errorBody && e && e.response && typeof e.response.text === 'function') {
          try { errorBody = await e.response.text(); } catch (_) { /* ignore */ }
        }
      } catch (_) { /* ignore */ }

      console.error(`[src/gemini.js] Error for model ${modelName} (clean: ${String(modelName || '').replace(/^models\//i, '')}) -> status: ${status}, message: ${msg}`);
      if (errorBody) {
        try {
          console.error('[src/gemini.js] Error body:', typeof errorBody === 'string' ? errorBody : JSON.stringify(errorBody));
        } catch (se) {
          console.error('[src/gemini.js] Error body (stringify failed):', String(errorBody));
        }
      }

      if (status === 404 || /\b404\b/.test(msg) || /not available|no longer available|model not found/i.test(msg)) {
        console.warn(`[src/gemini.js] Model ${modelName} not available (${msg}). Trying next model.`);
        continue;
      }
      const isTransient = /timeout|network|ECONNRESET|ECONNREFUSED|5\d{2}/i.test(msg);
      if (isTransient) {
        console.warn(`[src/gemini.js] Transient error for model ${modelName}: ${msg} — trying next model.`);
        continue;
      }
      throw e;
    }
  }

  throw lastErr || new Error('All Gemini models failed');
}

function extractTextFromCandidate(candidate) {
  if (!candidate?.content?.parts) {
    return '';
  }

  return candidate.content.parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
}

function getSessionId(jid) {
  return (jid || '').split('@')[0];
}

function resetSessionTimer(sessionId, sessionEntry) {
  if (sessionEntry.timer) {
    clearTimeout(sessionEntry.timer);
  }

  sessionEntry.timer = setTimeout(() => {
    chatSessions.delete(sessionId);
    console.log(`🧹 Historial limpiado por inactividad para ${sessionId}`);
  }, ttlMs);
}

function formatConversationHistory(history) {
  return history
    .map((entry) => {
      const text = (entry.parts || [])
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join(' ')
        .trim();

      const roleLabel = entry.role === 'user' ? 'Cliente' : 'Camila';
      return text ? `${roleLabel}: ${text}` : null;
    })
    .filter(Boolean)
    .join('\n');
}

// Verifica intención de agendar con keywords baratas para evitar gastar tokens en Gemini innecesariamente
function hasSchedulingIntent(mensajeUsuario, history) {
  if (!mensajeUsuario) return false;

  const text = [mensajeUsuario, formatConversationHistory(history)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const schedulingKeywords = [
    'cita',
    'agendar',
    'reservar',
    'agenda',
    'horario',
    'fecha',
    'turno',
    'consulta',
    'consultar',
  ];

  return schedulingKeywords.some((keyword) => text.includes(keyword));
}

// Convierte el historial a un prompt compacto (Cliente/Camila) para pasar al modelo
function extractConversationPrompt(history) {
  const conversationText = formatConversationHistory(history);
  return `Extrae los datos de agendamiento de esta conversación. Devuelve SOLO un objeto JSON válido con las claves: nombre, telefono, distrito, fechaHora. Si el campo no aparece, usa null. No agregues explicaciones ni texto adicional. No inventes datos.\n\nConversación:\n${conversationText}`;
}

// Extrae datos de agendamiento usando Function Calling (guardar_datos_paciente).
// Retorna objeto con campos o null si no hubo resultado válido. Maneja el fallback sin romper el flujo.
async function extractLeadData(history) {
  const conversationText = formatConversationHistory(history);
  if (!conversationText) return null;

  const functionDeclaration = {
    name: 'guardar_datos_paciente',
    description: 'Devuelve los campos del paciente extraídos de la conversación en formato JSON',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        nombre: { type: SchemaType.STRING, nullable: true },
        telefono: { type: SchemaType.STRING, nullable: true },
        distrito: { type: SchemaType.STRING, nullable: true },
        fechaHora: { type: SchemaType.STRING, nullable: true },
      },
      required: [],
    },
  };

  const contentPrompt = extractConversationPrompt(history);

  // Si no hay API key (modo test/local), usar parser heurístico liviano para pruebas sin llamar a Gemini
  if (!apiKey) {
    try {
      const text = contentPrompt.toLowerCase();
      // nombre: 'me llamo X' or 'soy X'
      const nombreMatch = text.match(/me llamo\s+([a-záéíóúñü\s]{2,60})(?:[,\.\n]|$)/i) || text.match(/soy\s+([a-záéíóúñü\s]{2,60})(?:[,\.\n]|$)/i);
      const nombre = nombreMatch ? nombreMatch[1].trim().replace(/\s+/g, ' ') : null;

      // telefono: 9 dígitos o con código 51
      const telefonoMatch = text.match(/(\+?51)?\s*(9\d{8}|\b\d{9}\b)/);
      const telefono = telefonoMatch ? telefonoMatch[2] || telefonoMatch[0] : null;

      // distrito: 'vivo en X' or 'en X' (simple heurística)
      const distritoMatch = text.match(/vivo en\s+([a-záéíóúñü\s]{2,60})(?:[,\.\n]|$)/i) || text.match(/en\s+([a-záéíóúñü\s]{2,60})(?:[,\.\n]|$)/i);
      const distrito = distritoMatch ? distritoMatch[1].trim() : null;

      // fechaHora: buscaremos frases como 'el jueves a las 3pm' o 'puedo el jueves a las 3pm' o 'mañana a las 3'
      const fechaMatch = text.match(/(?:puedo\s+)?(el\s+)?((?:hoy|mañana|pasado\s+mañana|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)|\d{1,2}\s+de\s+\w+)(?:\s+(?:a\s+las)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i);
      const fechaHora = fechaMatch ? fechaMatch[0].trim() : null;

      return {
        nombre: nombre ?? null,
        telefono: telefono ?? null,
        distrito: distrito ?? null,
        fechaHora: fechaHora ?? null,
      };
    } catch (e) {
      console.warn('Fallback parser falló:', e?.message || e);
      return null;
    }
  }

  try {
    const request = {
      contents: [{ role: 'user', parts: [{ text: contentPrompt }] }],
      tools: [{ functionDeclarations: [functionDeclaration] }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    };

    try {
      const result = await generateContentWithModelFallback(request);

      // Preferir extracción formal desde response.functionCalls/toolCalls (más fiable que parsear texto)
    let argsObj = null;

    const functionCalls = result?.response?.functionCalls || result?.response?.toolCalls;
    if (Array.isArray(functionCalls) && functionCalls.length > 0) {
      const fc = functionCalls[0];
      // Algunos SDKs exponen los argumentos bajo 'arguments' o 'args'
      argsObj = fc?.arguments ?? fc?.args ?? null;
      if (typeof argsObj === 'string') {
        try {
          argsObj = JSON.parse(argsObj);
        } catch (e) {
          console.warn('Function call arguments no son JSON parsable:', e?.message || e);
          argsObj = null;
        }
      }
    } else {
      // Fallback a buscar functionCall dentro de los partes del candidato (compatibilidad con distintas versiones)
      const candidate = result?.response?.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const fcPart = parts.find((p) => p.functionCall || p.function_call);
      const fcData = fcPart?.functionCall ?? fcPart?.function_call;
      if (fcData && (fcData.args || fcData.arguments)) {
        argsObj = fcData.args ?? fcData.arguments;
        if (typeof argsObj === 'string') {
          try {
            argsObj = JSON.parse(argsObj);
          } catch (e) {
            console.warn('Function call args no son JSON parsables (fallback):', e?.message || e);
            argsObj = null;
          }
        }
      }
    }

      if (argsObj) {
        return {
          nombre: argsObj.nombre ?? null,
          telefono: argsObj.telefono ?? null,
          distrito: argsObj.distrito ?? null,
          fechaHora: argsObj.fechaHora ?? null,
        };
      }

      // Fallback: si no hay functionCall, retornamos null sin interrumpir el flujo
      return null;
    } catch (e) {
      console.error('[src/gemini.js] Gemini generateContent failed while extracting lead data', {
        message: e && e.message ? e.message : String(e),
        code: e && e.code ? e.code : null,
        status: e && e.status ? e.status : null,
        stack: e && e.stack ? e.stack : null,
      });
      return null;
    }
  } catch (error) {
    console.error('[src/gemini.js] Error extrayendo los datos de agendamiento (function calling):', {
      message: error && error.message ? error.message : String(error),
      code: error && error.code ? error.code : null,
      status: error && error.status ? error.status : null,
      stack: error && error.stack ? error.stack : null,
    });

    // Fallback heurístico reducido: solo usar cuando el error parece ser de red/timeout/servidor (no por modelo inexistente)
    // Por ejemplo: status undefined (network), 408 (timeout), >=500 (server error), o mensajes que contengan 'timeout'/'network'/'ECONNRESET'.
    const isNetworkOrServerError = !error || typeof error.status === 'undefined' || error.status === 408 || (typeof error.status === 'number' && error.status >= 500) || /timeout|network|ECONNRESET|ECONNREFUSED/i.test(String(error.message || ''));

    if (isNetworkOrServerError) {
      // En producción debemos loguear la advertencia con un emoji visible
      if (process.env.NODE_ENV === 'production') {
        console.warn('⚠️ Fallback heurístico activado por error de red/servidor. Usando parser local como medida de seguridad. Revisa la integridad de Function Calling.');
      } else {
        console.warn('Fallback heurístico activado por error de red/servidor. Usando parser local como medida de seguridad.');
      }

      try {
        const text = contentPrompt.toLowerCase();
        const nombreMatch = text.match(/me llamo\s+([a-záéíóúñü\s]{2,60})(?:[,\.\n]|$)/i) || text.match(/soy\s+([a-záéíóúñü\s]{2,60})(?:[,\.\n]|$)/i);
        const nombre = nombreMatch ? nombreMatch[1].trim().replace(/\s+/g, ' ') : null;
        const telefonoMatch = text.match(/(\+?51)?\s*(9\d{8}|\b\d{9}\b)/);
        const telefono = telefonoMatch ? telefonoMatch[2] || telefonoMatch[0] : null;
        const distritoMatch = text.match(/vivo en\s+([a-záéíóúñü\s]{2,60})(?:[,\.\n]|$)/i) || text.match(/en\s+([a-záéíóúñü\s]{2,60})(?:[,\.\n]|$)/i);
        const distrito = distritoMatch ? distritoMatch[1].trim() : null;
        const fechaMatch = text.match(/(?:puedo\s+)?(el\s+)?((?:hoy|mañana|pasado\s+mañana|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)|\d{1,2}\s+de\s+\w+)(?:\s+(?:a\s+las)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i);
        const fechaHora = fechaMatch ? fechaMatch[0].trim() : null;

        return {
          nombre: nombre ?? null,
          telefono: telefono ?? null,
          distrito: distrito ?? null,
          fechaHora: fechaHora ?? null,
        };
      } catch (e) {
        console.warn('Fallback local falló:', e?.message || e);
        return null;
      }
    }

    // No usamos fallback en casos de error por modelo inexistente/403/404; devolvemos null y que el flujo lo trate como fallo.
    return null;
  }
}

function getOrCreateSession(jid) {
  // Maneja sesiones por número (limpia el sufijo @...), guarda chat y history en memoria
  const sessionId = getSessionId(jid);
  const existingSession = chatSessions.get(sessionId);
  if (existingSession?.chat) {
    resetSessionTimer(sessionId, existingSession);
    return existingSession;
  }

  const history = existingSession?.history ?? [];
  const chat = getModel().startChat({ history });
  const sessionEntry = { chat, history, timer: null };
  chatSessions.set(sessionId, sessionEntry);
  resetSessionTimer(sessionId, sessionEntry);
  return sessionEntry;
}

// Parsea expresiones de fecha/hora en español en zona America/Lima para obtener un Date
function parseFechaHora(textoFecha, fechaReferencia = new Date()) {
  if (!textoFecha) return null;
  const tzOffset = -5; // America/Lima (UTC-5), sin DST
  const txt = textoFecha.toString().toLowerCase().trim();

  const now = new Date(fechaReferencia);
  // Default hours: si no se especifica hora, usar 15:00 (3pm) como hora por defecto para citas.
  // Para expresiones que indiquen 'tarde', usar 16:00 (4pm) como hora por defecto.
  // Estas decisiones buscan coherencia con horarios típicos de consulta.
  const DEFAULT_HOUR_NO_TIME = 15;
  const DEFAULT_HOUR_TARDE = 16;

  // Helper para obtener el UTC timestamp desde componentes de fecha/hora en zona Lima
  function buildDate(year, monthIndex, day, hour = DEFAULT_HOUR_NO_TIME, minute = 0) {
    // utcMillis for local wall clock in Lima: Date.UTC(year,month,day,hour - tzOffset)
    const utcMillis = Date.UTC(year, monthIndex, day, hour - tzOffset, minute);
    return new Date(utcMillis);
  }

  // meses en español
  const months = {
    enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
    julio: 6, agosto: 7, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
  };

  // Detectar hora (ej: 3pm, 3:30pm, 15:00, a las 3pm)
  const timeRegex = /(?:a\s+las\s*)?(\d{1,2})(?::(\d{2}))?\s*(?:h|hrs?|:)?\s*(am|pm|a\.m\.|p\.m\.)?/i;
  const timeMatch = txt.match(timeRegex);
  let hour = null;
  let minute = 0;
  if (timeMatch) {
    hour = parseInt(timeMatch[1], 10);
    if (timeMatch[2]) minute = parseInt(timeMatch[2], 10);
    const ampm = (timeMatch[3] || '').replace(/\./g, '').toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
  }

  // Relativos: hoy, mañana, pasado mañana
  if (txt.includes('pasado') && txt.includes('mañana') || txt.includes('pasadomañana') || txt.includes('pasado mañana')) {
    const target = new Date(now);
    target.setDate(now.getDate() + 2);
    const y = target.getFullYear(); const m = target.getMonth(); const d = target.getDate();
    const defaultHour = txt.includes('tarde') ? DEFAULT_HOUR_TARDE : DEFAULT_HOUR_NO_TIME;
    return buildDate(y, m, d, hour ?? defaultHour, minute);
  }

  if (txt.includes('mañana')) {
    const target = new Date(now);
    target.setDate(now.getDate() + 1);
    const y = target.getFullYear(); const m = target.getMonth(); const d = target.getDate();
    const defaultHour = txt.includes('tarde') ? DEFAULT_HOUR_TARDE : DEFAULT_HOUR_NO_TIME;
    return buildDate(y, m, d, hour ?? defaultHour, minute);
  }

  if (txt.includes('hoy')) {
    const y = now.getFullYear(); const m = now.getMonth(); const d = now.getDate();
    const defaultHour = txt.includes('tarde') ? DEFAULT_HOUR_TARDE : DEFAULT_HOUR_NO_TIME;
    return buildDate(y, m, d, hour ?? defaultHour, minute);
  }

  // Dias de la semana: lunes..domingo -> encontrar el siguiente día que coincida
  const weekdayNames = { lunes:1, martes:2, miercoles:3, miércoles:3, jueves:4, viernes:5, sabado:6, sábado:6, domingo:0 };
  for (const name of Object.keys(weekdayNames)) {
    if (txt.includes(name)) {
      const desired = weekdayNames[name];
      const current = now.getDay(); // 0=domingo
      // calcular dias a sumar para el próximo desired weekday (incluye hoy si coincide y hora futura?)
      let daysAhead = (desired - current + 7) % 7;
      if (daysAhead === 0) {
        // si es hoy, pero la hora ya pasó, tomar la siguiente semana
        if (hour !== null) {
          const candidate = new Date(now);
          const candidateDate = buildDate(candidate.getFullYear(), candidate.getMonth(), candidate.getDate(), hour, minute);
          if (candidateDate <= now) daysAhead = 7;
        }
      }
      const target = new Date(now);
      target.setDate(now.getDate() + daysAhead);
      const y = target.getFullYear(); const m = target.getMonth(); const d = target.getDate();
      const defaultHourForWeekday = txt.includes('tarde') ? DEFAULT_HOUR_TARDE : DEFAULT_HOUR_NO_TIME;
      return buildDate(y, m, d, hour ?? defaultHourForWeekday, minute);
    }
  }

  // Fecha explícita: e.g., 15 de agosto, 15 agosto, 15/08/2026
  const explicitDateRegex1 = /(\d{1,2})\s*(?:de\s*)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s*(?:de\s*(\d{4}))?/i;
  const ed1 = txt.match(explicitDateRegex1);
  if (ed1) {
    const day = parseInt(ed1[1], 10);
    const month = months[ed1[2].toLowerCase()];
    const year = ed1[3] ? parseInt(ed1[3], 10) : now.getFullYear();
    // si la fecha ya pasó en el año actual, asumimos el próximo año
    let targetYear = year;
    const tentative = buildDate(year, month, day, hour ?? DEFAULT_HOUR_NO_TIME, minute);
    if (tentative <= now && year === now.getFullYear()) {
      targetYear = year + 1;
    }
    return buildDate(targetYear, month, day, hour ?? DEFAULT_HOUR_NO_TIME, minute);
  }

  // Formato tipo DD/MM[/YYYY]
  const explicitDateRegex2 = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/;
  const ed2 = txt.match(explicitDateRegex2);
  if (ed2) {
    const day = parseInt(ed2[1], 10);
    const month = parseInt(ed2[2], 10) - 1;
    const year = ed2[3] ? parseInt(ed2[3], 10) : now.getFullYear();
    const y = year < 100 ? 2000 + year : year;
    return buildDate(y, month, day, hour ?? DEFAULT_HOUR_NO_TIME, minute);
  }

  // Si no se pudo parsear, retornar null
  return null;
}

export async function obtenerRespuestaIA(jid, mensajeUsuario) {
  const sessionEntry = getOrCreateSession(jid);
  try {
    const result = await sessionEntry.chat.sendMessage(mensajeUsuario);
    const texto = extractTextFromCandidate(result?.response?.candidates?.[0]);

    sessionEntry.history.push({ role: 'user', parts: [{ text: mensajeUsuario }] });
    if (texto) {
      sessionEntry.history.push({ role: 'model', parts: [{ text: texto }] });
    }
    sessionEntry.history = sessionEntry.history.slice(-MAX_HISTORY_MESSAGES);
    resetSessionTimer(getSessionId(jid), sessionEntry);

    let leadResult = null;
    if (hasSchedulingIntent(mensajeUsuario, sessionEntry.history)) {
      const leadData = await extractLeadData(sessionEntry.history);
      if (leadData?.telefono) {
        // Intent: parsear fechaHora detectada por el modelo
        const fechaTexto = leadData.fechaHora ?? null;
        const parsedDate = parseFechaHora(fechaTexto);
        const fechaHoraISO = parsedDate ? parsedDate.toISOString() : null;
        const fechaHoraConfirmada = Boolean(parsedDate);

        leadResult = await saveLead({
          telefono: leadData.telefono,
          nombre: leadData.nombre,
          distrito: leadData.distrito,
          fechaHoraISO,
          fechaHoraTexto: fechaTexto,
          fechaHoraConfirmada,
        });
      }
    }

    return {
      texto: texto || 'Disculpa, no pude procesar tu mensaje. ¿Puedes intentar decirlo de otra forma, por favor?',
      leadResult,
    };
  } catch (error) {
    console.error('Error obteniendo respuesta de Gemini:', error);
    return { texto: contingencyMessage, leadResult: null };
  }
}

// Exportar helpers para tests y reutilización
export { hasSchedulingIntent, parseFechaHora, extractLeadData };
