import fs from 'fs/promises';
import path from 'path';

// Permite sobreescribir el archivo de leads para testing usando la variable de entorno LEADS_TEST_FILE
// Support configurable leads storage directory/file. In production it's recommended to set LEADS_DIR to a persistent mount (e.g., /data) or LEADS_FILE to an absolute path.
const defaultLeadsFileName = process.env.LEADS_TEST_FILE || 'leads.json';
const leadsDir = process.env.LEADS_DIR ? path.resolve(process.env.LEADS_DIR) : process.cwd();
const LEADS_FILE = process.env.LEADS_FILE ? path.resolve(process.env.LEADS_FILE) : path.resolve(leadsDir, defaultLeadsFileName);
const TEMP_LEADS_FILE = LEADS_FILE + '.tmp';

// Mutex en memoria simple: encadena operaciones para evitar race conditions en un solo proceso.
// Nota: esto es temporal; en producción con PM2 cluster se debe migrar a Postgres/Redis.
let leadsLock = Promise.resolve();
function withLeadsLock(fn) {
  const run = async () => fn();
  const next = leadsLock.then(run, run);
  leadsLock = next.catch(() => {});
  return next;
}

// Normaliza teléfonos a formato E.164 para Perú (+51...).
// Valida que el celular tenga exactamente 9 dígitos después del código de país.
// Devuelve cadena en E.164 (ej: +51987654321) o null si no es posible normalizar.
function normalizePhone(telefono) {
  if (!telefono && telefono !== 0) return null;
  const raw = telefono.toString().trim();
  // Eliminar espacios y caracteres no numéricos excepto leading +
  const cleaned = raw.replace(/[^+\d]/g, '');

  // Si empieza con +, remover y usar el resto
  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1).replace(/\D/g, '');
    // Si incluye código de país (51) y 9 dígitos de celular
    if (digits.startsWith('51') && digits.length === 11) {
      return `+${digits}`;
    }
    // O si ya viene con +51 y 9 dígitos (len 11)
    return null;
  }

  // Si viene con código de país sin +, ej 51987654321
  const onlyDigits = cleaned.replace(/\D/g, '');
  if (onlyDigits.length === 11 && onlyDigits.startsWith('51')) {
    return `+${onlyDigits}`;
  }

  // Si tiene 9 dígitos, asumir Perú (+51)
  if (onlyDigits.length === 9) {
    return `+51${onlyDigits}`;
  }

  // No es un número de celular peruano válido
  console.warn('normalizePhone: número no válido o no peruano:', telefono);
  return null;
}

async function loadLeads() {
  try {
    const raw = await fs.readFile(LEADS_FILE, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    console.warn('Leads corrupto o inválido, inicializando archivo vacío:', error?.message || error);
    return [];
  }
}

// Escribe el archivo de leads de forma atómica usando un archivo temporal para evitar corrupciones si el proceso falla.
async function safeWriteLeads(leads) {
  // Escritura atómica: escribe a archivo temporal y renombra.
  const payload = JSON.stringify(leads, null, 2);
  await fs.writeFile(TEMP_LEADS_FILE, payload, 'utf8');

  try {
    await fs.rename(TEMP_LEADS_FILE, LEADS_FILE);
  } catch (error) {
    await fs.rm(LEADS_FILE, { force: true });
    await fs.rename(TEMP_LEADS_FILE, LEADS_FILE);
  }
}

// Guarda o actualiza un lead de forma segura y atómica.
// Retorna { isNew, readyToNotify, lead }
// - isNew: true si el teléfono no existía previamente
// - readyToNotify: true solo si nombre, distrito y fechaHora están presentes (lista para notificar agenda)
// Guarda o actualiza un lead: evita duplicados por teléfono, actualiza timestamps y marca si la entrada incluye fecha/hora de cita.
export async function saveLead({ telefono, nombre, distrito, fechaHora, fechaHoraISO, fechaHoraTexto, fechaHoraConfirmada, servicio = null, servicioInteres = null }) {
  return withLeadsLock(async () => {
    try {
      const leads = await loadLeads();
      const normalizedPhone = normalizePhone(telefono);
      const now = new Date().toISOString();
      const resolvedServicio = (typeof servicio === 'string' && servicio.trim()) ? servicio.trim() : ((typeof servicioInteres === 'string' && servicioInteres.trim()) ? servicioInteres.trim() : null);

      // Buscar por telefono normalizado si está disponible, si no buscar por telefonoOriginal (si coincide)
      let existingLead = null;
      if (normalizedPhone) {
        existingLead = leads.find((lead) => lead.telefono && lead.telefono === normalizedPhone);
      } else if (telefono) {
        existingLead = leads.find((lead) => lead.telefonoOriginal && lead.telefonoOriginal === telefono.toString());
      }

      if (existingLead) {
        // Lead ya existente: actualizar datos parciales y marcar ultimoContacto
        existingLead.nombre = nombre || existingLead.nombre || null;
        existingLead.distrito = distrito || existingLead.distrito || null;
        existingLead.servicio = resolvedServicio || existingLead.servicio || null;
        existingLead.servicioInteres = resolvedServicio || existingLead.servicioInteres || null;
        // Mantener/actualizar campos de fechaHora
        existingLead.fechaHoraISO = fechaHoraISO ?? existingLead.fechaHoraISO ?? null;
        existingLead.fechaHoraTexto = fechaHoraTexto ?? existingLead.fechaHoraTexto ?? null;
        existingLead.fechaHoraConfirmada = (typeof fechaHoraConfirmada === 'boolean') ? fechaHoraConfirmada : (existingLead.fechaHoraConfirmada || false);
        existingLead.ultimoContacto = now;
        // Guardar telefonoOriginal si no tenemos telefono normalizado
        if (!existingLead.telefono && telefono) existingLead.telefonoOriginal = existingLead.telefonoOriginal || telefono.toString();

        await safeWriteLeads(leads);

        const readyToNotify = Boolean(existingLead.nombre && existingLead.distrito && (existingLead.fechaHoraISO || existingLead.fechaHoraTexto));
        return { isNew: false, readyToNotify, lead: existingLead };
      }

      // Nuevo lead
      const newLead = {
        telefono: normalizedPhone,
        telefonoOriginal: normalizedPhone ? null : (telefono ? telefono.toString() : null),
        nombre: nombre || null,
        distrito: distrito || null,
        servicio: resolvedServicio || null,
        servicioInteres: resolvedServicio || null,
        fechaHoraISO: fechaHoraISO || null,
        fechaHoraTexto: fechaHoraTexto || null,
        fechaHoraConfirmada: Boolean(fechaHoraConfirmada),
        creadoEn: now,
        ultimoContacto: now,
      };

      leads.push(newLead);
      await safeWriteLeads(leads);

      const readyToNotify = Boolean(newLead.nombre && newLead.distrito && (newLead.fechaHoraISO || newLead.fechaHoraTexto));
      return { isNew: true, readyToNotify, lead: newLead };
    } catch (error) {
      console.error('Error guardando lead:', error);
      return { isNew: false, readyToNotify: false, lead: null };
    }
  });
}
