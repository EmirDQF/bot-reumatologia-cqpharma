import config from '../config/env.js';
import geminiService from '../services/geminiService.js';
import leadService from '../services/leadService.js';
import notificationService from '../services/notificationService.js';
import whatsappService from '../services/whatsappService.js';
import chatwootService from '../services/chatwootService.js';
import { getGeminiClient } from '../src/geminiClient.js';
import { getSupabaseClient, getClinicByWabaPhoneId } from '../services/leadService.js';

function normalizeIncomingText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  if (typeof value === 'object') {
    const plain = extractPlainText(value);
    return typeof plain === 'string' ? plain.trim() : '';
  }
  return String(value).trim();
}

function extractPlainText(input) {
  let cleaned = typeof input === 'string' ? input : JSON.stringify(input);

  cleaned = cleaned.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

  if ((cleaned.startsWith('{') && cleaned.endsWith('}')) || (cleaned.startsWith('[') && cleaned.endsWith(']'))) {
    try {
      const parsed = JSON.parse(cleaned);
      if (parsed) {
        const possibleKeys = ['content', 'respuesta', 'response', 'texto', 'text', 'message'];
        for (const key of possibleKeys) {
          if (parsed[key] !== undefined && parsed[key] !== null) {
            if (typeof parsed[key] === 'string' && parsed[key].trim().length > 0) {
              return parsed[key].trim();
            }
            if (typeof parsed[key] === 'object') {
              const nested = extractPlainText(parsed[key]);
              if (nested && nested.trim().length > 0) {
                return nested.trim();
              }
            }
          }
        }

        if (Array.isArray(parsed)) {
          const arrayText = parsed.map((item) => extractPlainText(item)).filter(Boolean).join(' ');
          if (arrayText) return arrayText;
        }

        if (typeof parsed === 'object') {
          const traversed = Object.values(parsed)
            .map((value) => extractPlainText(value))
            .filter(Boolean)
            .join(' ')
            .trim();
          if (traversed) return traversed;
        }
      }
    } catch (e) {
      const malformedPrefixMatch = cleaned.match(/^\s*\{\s*"(?:content|respuesta|response|texto|text|message)"\s*:\s*"?(.*)$/i);
      if (malformedPrefixMatch && malformedPrefixMatch[1]) {
        return malformedPrefixMatch[1].replace(/\}?\s*$/,'').replace(/^"/, '').trim();
      }
      const match = cleaned.match(/"(?:content|respuesta|response|texto|text|message)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
      if (match && match[1]) return match[1].trim();
    }
  }

  return cleaned;
}

// Controller delgado que orquesta: Gemini -> lead -> WhatsApp -> admin notify
// IMPORTANT: respond 200 early to Meta, then continue processing asynchronously
export default async function webhookController(req, res, next) {
  try {
    // Prefer parsedBody attached by verifySignature middleware; parse defensively
    let payload = null;
    try {
      if (req.parsedBody) payload = req.parsedBody;
      else if (req.body) {
        if (req.body instanceof Buffer) {
          try { payload = JSON.parse(req.body.toString('utf8')); } catch (e) { payload = null; }
        } else {
          payload = req.body;
        }
      }
    } catch (e) {
      payload = null;
    }

    // Detect Chatwoot webhook (message_created)
    // Safe fallback for clinic name in case `clinic` is undefined in some webhook flows
    let clinicName = process.env.CLINIC_NAME_FALLBACK || 'Centro Especializado en Reumatología y Salud Ósea';
    if (payload?.event === 'message_created' && payload?.payload) {
      const p = payload.payload;
      const message = p?.message || p?.content || null;
      const conversation = p?.conversation || null;
      const inbox = p?.inbox || null;
      const contact = p?.sender || p?.contact || p?.sender_contact || p?.contact || null;

      // Build a simple identifier from contact phone if available
      const contactPhoneRaw = contact?.phone_number || contact?.phone || (p?.sender_contact?.phone_number) || null;
      const contactDigits = contactPhoneRaw ? String(contactPhoneRaw).replace(/\D/g, '') : null;

      // Lookup clinic by chatwoot_inbox_id or account. If Supabase is not configured or the clinic record is absent,
      // keep the conversation alive using the configured fallback clinic name instead of failing the flow.
      const phoneNumberId = String(inbox?.id || payload?.account_id || '').trim();
      let clinic = null;
      try {
        const client = getSupabaseClient();
        if (inbox?.id) {
          const { data, error } = await client.from('clinics').select('*').eq('chatwoot_inbox_id', inbox.id).maybeSingle();
          if (error) throw error;
          clinic = data || null;
        }
        if (!clinic && payload?.account_id) {
          const { data, error } = await client.from('clinics').select('*').eq('chatwoot_account_id', payload.account_id).maybeSingle();
          if (error) throw error;
          clinic = data || null;
        }
      } catch (e) {
        console.warn('webhookController: clinic lookup for chatwoot webhook failed or was unavailable; using fallback clinic name', e && e.message ? e.message : e);
        clinic = null;
      }

      // Update clinicName from clinic if available
      clinicName = (typeof clinic !== 'undefined' && clinic?.name) || clinicName;
      // If conversation is assigned to a human agent and open, skip bot
      const convStatus = conversation?.status || (p?.conversation?.status);
      const assigneeId = conversation?.meta?.assignee_id || conversation?.assignee_id || null;
      if (convStatus === 'open' && assigneeId) {
        // Human in the loop — do not bot-respond
        if (!res.headersSent) return res.status(200).json({ ok: true, reason: 'human_assigned' });
        return;
      }

      // If user requests human or conversation unassigned, mark for human handover
      const rawText = (message && (message.content || message.body || message.message)) ? (message.content || message.body || message.message) : (p?.content || null);
      const text = normalizeIncomingText(rawText);
      const wantsHuman = typeof text === 'string' && text.length > 0 && /asesor|humano|asesora|hablar con|asesor(a)?/i.test(text);
      if (wantsHuman || (!assigneeId && convStatus === 'open')) {
        try {
          const accountId = payload.account_id || payload?.account?.id || null;
          const convId = conversation?.id || p?.conversation?.id;
          const apiToken = (typeof clinic !== 'undefined' && clinic?.chatwoot_api_token) || process.env.CHATWOOT_API_TOKEN;
          if (accountId && convId) {
            await chatwootService.updateConversation(accountId, convId, apiToken, { status: 'open' });
            // add a tag or attribute indicating human handover
            // Chatwoot may support adding labels via separate endpoint; as fallback we set status 'open'
          }
        } catch (e) {
          console.error('webhookController: error updating chatwoot conversation for human handover', e && e.message ? e.message : e);
        }

        // Pause the bot for this contact's session in geminiService
        try {
          if (contactDigits) {
            geminiService.pauseSessionById(contactDigits);
          }
        } catch (e) {
          console.error('webhookController: failed to pause session', e && e.message ? e.message : e);
        }

        // Notify clinic admin via notificationService
        try {
          // Create a minimal lead object to notify admin that human handover requested
          const leadLike = { nombre: contact?.name || null, telefono: contactDigits || null, distrito: null, fecha_hora_texto: null };
          await notificationService.notifyAdminNewLead(leadLike, { whatsappService, leadService, clinic: (typeof clinic !== 'undefined' ? clinic : null) });
        } catch (e) {
          console.error('webhookController: error notifying admin about human handover', e && e.message ? e.message : e);
        }

        if (!res.headersSent) return res.status(200).json({ ok: true, reason: 'handover_requested' });
        return;
      }

      // Otherwise, treat as a regular incoming message and process through the bot
      // Map contact phone to jid style used by geminiService
      const jid = contactDigits ? `${contactDigits}@s.whatsapp.net` : (conversation?.id ? `cw-${conversation.id}` : null);

      // call geminiService to obtain reply; pass clinic config for system prompt
      const geminiClient = getGeminiClient();
      // Detect admin sender to avoid creating/updating leads or initiating scheduling flows for admin messages
      const ADMIN_WHATSAPP_NUMBER = (process.env.ADMIN_WHATSAPP_NUMBER || '').replace(/\D/g, '');
      const senderNumberNormalized = contactDigits ? String(contactDigits).replace(/\D/g, '') : (conversation?.id ? String(conversation.id).replace(/\D/g, '') : null);
      const isAdminSender = senderNumberNormalized && ADMIN_WHATSAPP_NUMBER && senderNumberNormalized === ADMIN_WHATSAPP_NUMBER;

      const geminiPromise = geminiService.obtenerRespuestaIA(jid, text || '', {
        client: geminiClient,
        clinic: (typeof clinic !== 'undefined' ? clinic : null),
        maxRetries: 1,
        maxOutputTokens: 100,
        skipLeadPersistence: Boolean(isAdminSender)
      });
      let texto = 'Disculpa, hubo un problema procesando tu mensaje.';
      let leadData = null;
      try {
        const result = await geminiPromise;
        if (result) {
          texto = result.texto || result.text || (typeof result === 'string' ? result : texto);
          leadData = result.leadData || null;
        }
      } catch (e) {
        console.error('webhookController: gemini call failed for chatwoot message', e && e.stack ? e.stack : e);
        if (e && e.response) console.error('[GEMINI RESPONSE]:', e.response);
      }

      // If leadData present, attempt to save lead using the contact's WhatsApp number as source-of-truth
      let leadResult = null;
      if (leadData) {
        try {
          const telefonoKey = contactDigits || null; // contactDigits is the remitente phone for Chatwoot events
          // If message came from admin, skip any DB lead creation/update and scheduling flows
          if (isAdminSender) {
            console.log('webhookController: message from admin detected; skipping lead save and scheduling for this sender');
          } else if (!telefonoKey) {
            console.warn('webhookController: no remitente phone found for chatwoot message; skipping lead save to avoid using model-extracted phone');
          } else {
            const shouldConfirm = typeof text === 'string' && geminiService.isExplicitConfirmation(text);
            leadResult = await leadService.saveLead({
              telefono: telefonoKey,
              nombre: leadData.nombre,
              distrito: leadData.distrito,
              fechaHoraISO: leadData.fechaHoraISO || leadData.fecha_hora_iso || null,
              fechaHoraTexto: leadData.fechaHora || leadData.fecha_hora || null,
              confirmed: true && shouldConfirm,
              clinicId: (typeof clinic !== 'undefined' && clinic?.id) || null,
              clinic: (typeof clinic !== 'undefined' ? clinic : null),
            });
            // If user explicitly confirmed, force an admin notify regardless
            if (shouldConfirm && leadResult && leadResult.lead) {
              try {
                await notificationService.notifyAdminNewLead(leadResult.lead, { whatsappService, leadService, clinic });
              } catch (err) {
                console.error('webhookController: forced admin notify after explicit confirmation failed', err && err.message ? err.message : err);
              }
            }
          }
        } catch (e) {
          console.error('webhookController: error saving lead from chatwoot message', e && e.message ? e.message : e);
        }
      }
 
      // Send response back via Chatwoot so it's recorded in inbox
      try {
        const accountId = (typeof clinic !== 'undefined' && clinic?.chatwoot_account_id) || payload.account_id || null;
        const convId = conversation?.id || p?.conversation?.id;
        const apiToken = (typeof clinic !== 'undefined' && clinic?.chatwoot_api_token) || process.env.CHATWOOT_API_TOKEN;
        if (accountId && convId && apiToken) {
          await chatwootService.sendMessageToConversation(accountId, convId, apiToken, texto);
        } else {
          // fallback: if we have contact phone and whatsapp service, send directly
          if (contactDigits) await whatsappService.sendWhatsAppMessage(contactDigits, texto, {});
        }
      } catch (e) {
        console.error('webhookController: failed to send reply via chatwoot/whatsapp', e && e.message ? e.message : e);
      }
 
      if (leadResult && leadResult.readyToNotify && leadResult.lead) {
        try {
          console.log('[NOTIFICACION] lead marked readyToNotify; notifying admin now');
          await notificationService.notifyAdminNewLead(leadResult.lead, { whatsappService, leadService, clinic });
        } catch (e) {
          console.error('webhookController: error notifying admin after lead save', e && e.message ? e.message : e);
        }
      }

      if (!res.headersSent) return res.status(200).json({ ok: true });
      return;
    }

    // Existing WhatsApp webhook handling follows unchanged
    const entry = payload?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value || {};
    const message = value?.messages?.[0] || null;

    if (!message) {
      // nothing to process
      if (!res.headersSent) return res.status(200).json({ ok: true, reason: 'no_message' });
      return;
    }

    const rawFrom = message?.from || message?.from_user_id || value?.contacts?.[0]?.wa_id || value?.contacts?.[0]?.user_id || null;
    let from = rawFrom ? String(rawFrom).trim().replace(/^PE\./i, '') : null;
    from = from ? from.replace(/\D/g, '') : null;
    if (!from) {
      console.warn('webhookController: invalid from, skipping');
      if (!res.headersSent) return res.status(200).json({ ok: false, reason: 'invalid_from' });
      return;
    }

    let messageText = '';
    if (message?.type === 'text') {
      messageText = normalizeIncomingText(message?.text?.body);
    } else if (message?.type === 'button') {
      messageText = normalizeIncomingText(message?.button?.text);
    } else if (message?.type === 'interactive') {
      messageText = normalizeIncomingText(message?.interactive?.button_reply?.title || message?.interactive?.list_reply?.title);
    } else {
      messageText = normalizeIncomingText(message?.text?.body);
    }

    if (!messageText) {
      console.warn('webhookController: message text missing');
      if (!res.headersSent) return res.status(200).json({ ok: false, reason: 'no_text' });
      return;
    }

    // At this point we have validated "from" and "messageText".
    // Respond immediately to Meta to avoid retries/duplication.
    if (!res || !res.headersSent) {
      try { return res.status(200).json({ ok: true }); } catch (e) { /* safe no-op */ }
    }
    // If headers already sent, continue silently
    

    // Continue processing in background without blocking the response.
    // Use an immediately-invoked async function and internal try/catch to avoid unhandled rejections.
    (async () => {
      try {
        const safeMessageText = normalizeIncomingText(messageText);

        // Prepare session and detect initial greetings vs active conversation
        const jid = `${from}@s.whatsapp.net`;
        const session = (() => { try { return geminiService.getOrCreateSession(jid); } catch (e) { return null; } })();

        // Greeting detection: only send menu on initial greeting when session has no history
        const greetingRE = /^\s*(hola|buenas?|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|buen\s?d[ií]a|hi|hello)\b/i;
        if (greetingRE.test(safeMessageText)) {
          const hasHistory = session && Array.isArray(session.history) && session.history.length > 0;
          if (!hasHistory) {
            // mark user's greeting in session history so we don't treat next message as initial again
            try { if (session && Array.isArray(session.history)) session.history.push({ role: 'user', parts: [{ text: safeMessageText }] }); } catch (_) {}
            // Send main menu and return early (do not call Gemini)
            try {
              await whatsappService.sendWhatsAppMessage(from, geminiService.MAIN_MENU_TEXT, {});
            } catch (e) {
              console.error('webhookController: failed sending initial MAIN_MENU_TEXT', e && e.message ? e.message : e);
            }
            return;
          }
        }

        // Option shortcuts: if user sends '1','2','3','4' or option keywords, handle with simulated dynamic flows
        const opt1 = /^\s*(?:1|opci[oó]n\s*1|atenci[oó]n\s+general|atencion\s+general)\b/i.test(safeMessageText);
        const opt2 = /^\s*(?:2|opci[oó]n\s*2|densitometr[ií]a|densitometria)\b/i.test(safeMessageText);
        const opt3 = /^\s*(?:3|opci[oó]n\s*3|consulta\s+medica|consulta\s+m[eé]dica|consulta\s+reumatol[oó]gica)\b/i.test(safeMessageText);
        const opt4 = /^\s*(?:4|opci[oó]n\s*4|medicamentos|suplementos|medicina|medicinas)\b/i.test(safeMessageText);

        if (opt1 || opt2 || opt3 || opt4) {
          let simulated = '';
          try {
            if (opt1) {
              simulated = '¡Gracias por confiar en nosotros! Cuéntame, ¿qué síntomas o molestias articulares/óseas estás sintiendo? Por ejemplo: dolor de rodillas, dolor de espalda, dolor en manos, o rigidez matutina.';
            } else if (opt2) {
              simulated = 'La densitometría ósea es una prueba que mide la densidad mineral ósea y ayuda a diagnosticar osteoporosis. ¿Tienes orden médica para la prueba o es un chequeo preventivo? Tenemos turnos disponibles este martes a las 10:00 AM y el jueves a las 4:00 PM, ¿alguno te sirve?';
            } else if (opt3) {
              simulated = 'Podemos agendarte con nuestros especialistas. Disponibles: Dr. Carlos Mendoza - Reumatólogo, Dra. Mariana Flores - Especialista en Artritis y Artrosis. ¿Qué día prefieres y en qué franja horaria (mañana/tarde)?';
            } else if (opt4) {
              simulated = 'Ofrecemos varios productos: Calcio Citrato + Vitamina D3, Colágeno Hidrolizado, Magnesio Quelado y fijadores óseos. ¿Buscas algo para prevención, ya te diagnosticaron osteoporosis, o quieres coordinar recojo/delivery?';
            }

            // Append user input and simulated bot reply to session history so Gemini keeps context
            try {
              if (session && Array.isArray(session.history)) {
                session.history.push({ role: 'user', parts: [{ text: safeMessageText }] });
                session.history.push({ role: 'model', parts: [{ text: simulated }] });
              }
            } catch (_) {}

            // Send simulated reply
            await whatsappService.sendWhatsAppMessage(from, simulated, {});
          } catch (e) {
            console.error('webhookController: error sending simulated option reply', e && e.message ? e.message : e);
          }
          return;
        }

        // Apply a 15s timeout to the Gemini call (requirement).
        const geminiClient = getGeminiClient();
        const geminiPromise = geminiService.obtenerRespuestaIA(jid, safeMessageText, { client: geminiClient, maxRetries: 1, maxOutputTokens: 100 });
        const timeoutMs = 25_000;
        const timeoutPromise = new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error('gemini timeout')), timeoutMs);
          // ensure timer doesn't keep process alive
          t.unref && t.unref();
        });
 
        const phoneNumberId = value?.metadata?.phone_number_id ? String(value.metadata.phone_number_id).trim() : (process.env.WHATSAPP_PHONE_NUMBER_ID ? String(process.env.WHATSAPP_PHONE_NUMBER_ID).trim() : null);
        let clinic = null;
        if (phoneNumberId) {
          try {
            clinic = await getClinicByWabaPhoneId(phoneNumberId);
          } catch (e) {
            console.warn('webhookController: clinic lookup by waba_phone_number_id failed; continuing with fallback clinic name', e && e.message ? e.message : e);
            clinic = null;
          }
        }
        clinicName = (clinic && clinic.name) || process.env.CLINIC_NAME_FALLBACK || config.clinicNameFallback || 'Centro Especializado en Reumatología y Salud Ósea';
 
        let texto = 'Disculpa, hubo un problema procesando tu mensaje.';
        let leadData = null;
        let skipResponse = false;
        let geminiResult = null;
        try {
          geminiResult = await Promise.race([geminiPromise, timeoutPromise]);
          if (geminiResult) {
            if (geminiResult.skipResponse) {
              skipResponse = true;
            } else {
              texto = geminiResult.texto || geminiResult.text || (typeof geminiResult === 'string' ? geminiResult : texto);
              leadData = geminiResult.leadData || null;
            }
          }
        } catch (e) {
          console.error('webhookController: gemini call failed or timed out', {
            message: e && e.message ? e.message : String(e),
            code: e && e.code ? e.code : null,
            status: e && e.status ? e.status : null,
            stack: e && e.stack ? e.stack : null,
          });
          if (e && e.response) console.error('[GEMINI RESPONSE]:', e.response);
          // On failure, fallback message is already in texto
        }
 
        if (skipResponse) {
          return;
        }
 
        // Save lead if leadData is present. Use the remitente phone ('from') as the canonical source-of-truth for telefono.
        let leadResult = null;
        if (leadData) {
          try {
            const telefonoKey = from || null;
            if (!telefonoKey) {
              console.warn('webhookController: no remitente phone available in WhatsApp event; skipping lead save to avoid using model-extracted phone');
            } else {
              const shouldConfirm = typeof messageText === 'string' && geminiService.isExplicitConfirmation(messageText);
              const servicioInteres = leadData.servicio || leadData.servicio_interes || leadData.opcion || leadData.option || leadData.servicioSolicitado || null;
              if (!geminiResult || !geminiResult.skipLeadPersistence) {
                leadResult = await leadService.saveLead({
                  telefono: telefonoKey,
                  nombre: leadData.nombre,
                  distrito: leadData.distrito,
                  fechaHoraISO: leadData.fechaHoraISO || leadData.fecha_hora_iso || null,
                  fechaHoraTexto: leadData.fechaHora || leadData.fecha_hora || null,
                  servicio: servicioInteres,
                  confirmed: shouldConfirm,
                  clinicId: clinic?.id || null,
                  clinic: clinic || null,
                });
              }
            }
          } catch (e) {
            console.error('webhookController: error saving lead', e && e.message ? e.message : e);
          }
        }

        // Send message to user (best-effort). Failures are logged but do not affect response to Meta.
        try {
          // === SANITIZACIÓN DEFENSIVA EN CONTROLADOR DE WEBHOOK ===
          let textoFinal = extractPlainText(texto);
 
          textoFinal = geminiService.sanitizeModelTextOutput(textoFinal);
          // Ensure admin-only alert text is never forwarded to the patient.
          textoFinal = textoFinal.replace(/🚨\s*¡NUEVO PACIENTE AGENDADO![\s\S]*$/gi, '').trim();

          // Defensive placeholder cleanup before sending to user
          // Use shared clinicName declared earlier (already contains env/default fallback); prefer clinic.name when available
          clinicName = (typeof clinic !== 'undefined' && clinic?.name) || clinicName;
          const session = (() => { try { return geminiService.getOrCreateSession(from + '@s.whatsapp.net'); } catch (e) { return null; } })();
          let patientName = null;
          try {
            if (session && Array.isArray(session.history)) {
              for (let i = session.history.length - 1; i >= 0; i--) {
                const h = session.history[i];
                if (h.role === 'user') {
                  const t = (h.parts || []).map(p => p.text || '').join(' ').trim();
                  const parsed = geminiService.extractLeadDataFromText ? geminiService.extractLeadDataFromText(t) : null;
                  if (parsed && parsed.nombre && geminiService.isValidName && geminiService.isValidName(parsed.nombre)) {
                    patientName = parsed.nombre;
                    break;
                  }
                }
              }
            }
          } catch (e) { patientName = null; }

          textoFinal = textoFinal.replace(/\[NOMBRE_CLINICA\]/g, clinicName);
          if (patientName) {
            textoFinal = textoFinal.replace(/\[NOMBRE_PACIENTE\]/g, patientName);
          } else {
            textoFinal = textoFinal.replace(/\[NOMBRE_PACIENTE\]/g, 'estimado/a paciente');
          }

          if (textoFinal && textoFinal.length > 0 && !skipResponse) {
            await whatsappService.sendWhatsAppMessage(from, textoFinal, {});
          }
        } catch (e) {
          console.error('webhookController: failed sending message to user', e && e.message ? e.message : e);
        }

        // Notify admin if needed (best-effort)
        try {
          if (leadResult && leadResult.readyToNotify && leadResult.lead) {
            const adminNumber = process.env.ADMIN_WHATSAPP_NUMBER || config.admin?.phone || 'unknown';
            console.log('[NOTIFICACION ENVIADA A ADMIN]:', adminNumber);
            await notificationService.notifyAdminNewLead(leadResult.lead, { whatsappService, leadService, clinic });
          }
        } catch (e) {
          console.error('webhookController: error in admin notify flow', e && e.message ? e.message : e);
        }
      } catch (err) {
        // This catch is for the entire background processing block.
        console.error('webhookController: unexpected background processing error', err && err.message ? err.message : err);
      }
    })();

    // We already sent response to Meta; do not await background work.
    return;
  } catch (err) {
    // If we reach here before sending response, pass to centralized error handler
    return next(err);
  }
}
