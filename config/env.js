// Centralized environment loader and validator
// - Validates presence of required variables (fail-fast)
// - Exposes a config object for the app
// - Exposes helpers to mask secrets in logs

const required = [
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
  'SUPABASE_URL',
];

const missing = required.filter((k) => !process.env[k]);
const missingServiceRoleKey = !process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_SERVICE_ROLE;
if (missingServiceRoleKey) {
  missing.push('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE');
}

const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();
const isTest = nodeEnv === 'test';
const isProd = nodeEnv === 'production';

// In production require WHATSAPP_TOKEN and ADMIN_WHATSAPP_NUMBER to ensure outbound notifications work
if (isProd) {
  if (!process.env.WHATSAPP_TOKEN) missing.push('WHATSAPP_TOKEN');
  if (!process.env.ADMIN_WHATSAPP_NUMBER) missing.push('ADMIN_WHATSAPP_NUMBER');
}

// In test environment allow missing vars to facilitate unit tests
if (missing.length) {
  if (isTest) {
    // warn but don't throw in tests
    console.warn(`(test mode) Missing env vars: ${missing.join(', ')} — continuing for tests.`);
  } else {
    // Fail-fast with a concise message that does NOT print secret values
    throw new Error(`Missing required environment variables: ${missing.join(', ')}. Add them to your .env or env provider before starting.`);
  }
}

function maskSecret(value) {
  if (!value) return value;
  // show only last 4 chars for tokens
  if (value.length <= 8) return '<redacted>';
  return '****' + value.slice(-4);
}

function maskPhone(phone) {
  if (!phone) return phone;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return '****' + digits.slice(-4);
}

export default {
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || '',
    maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 110),
  },
  clinicNameFallback: process.env.CLINIC_NAME_FALLBACK || 'Centro Especializado en Reumatología y Salud Ósea',
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN || null,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    appSecret: process.env.WHATSAPP_APP_SECRET || null,
    webhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  },
  supabase: {
    url: process.env.SUPABASE_URL || null,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || null,
  },
  admin: {
    phone: process.env.ADMIN_WHATSAPP_NUMBER || null,
  },
  server: {
    port: Number(process.env.PORT || 3000),
  },
  clinicHours: {
    // Default clinic schedule: lunes(1) .. sábado(6). Domingo (0) no atendemos.
    diasAtencion: [1,2,3,4,5,6],
    horaInicio: process.env.CLINIC_HOUR_START || '09:00',
    horaFin: process.env.CLINIC_HOUR_END || '19:00'
  },
  helpers: {
    maskSecret,
    maskPhone,
  },
};
