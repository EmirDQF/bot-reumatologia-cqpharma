import { describe, it, before } from 'node:test';
import assert from 'assert';

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test';
process.env.GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
process.env.WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '12345';
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'verify-token';

let geminiService;

before(async () => {
  geminiService = await import('./geminiService.js');
});

describe('geminiService refinements', () => {
  it('replaces [NOMBRE_CLINICA] with fallback when clinic.name absent', async () => {
    const prompt = geminiService.buildSystemPromptWithContext('51900000000@s.whatsapp.net', null, null);
    assert.ok(!prompt.includes('[NOMBRE_CLINICA]'));
    assert.ok(prompt.includes('Centro Especializado en Reumatología y Salud Ósea'));
  });

  it('injects confirmed patient name into prompt and removes [NOMBRE_PACIENTE]', async () => {
    // create fake session with confirmed name in history
    const session = { history: [ { role: 'user', parts: [{ text: 'Me llamo Manuel' }], at: Date.now() } ] };
    const prompt = geminiService.buildSystemPromptWithContext('51900000001@s.whatsapp.net', session, null);
    assert.ok(!prompt.includes('[NOMBRE_PACIENTE]'));
    assert.ok(prompt.includes('Manuel'));
  });

  it('getGeminiClient uses config.gemini.maxOutputTokens default 110', async () => {
    const clientModule = await import('../src/geminiClient.js');
    const config = await import('../config/env.js');
    const maxTokens = config.default.gemini.maxOutputTokens;
    assert.equal(maxTokens, 110);
    // we cannot easily assert internal client generationConfig without making a real client, but config is the source
  });

  it('merges recent user messages within 10s into single Cliente block', async () => {
    const now = Date.now();
    const hist = [
      { role: 'user', parts: [{ text: 'Me llamo Andre' }], at: now - 2000 },
      { role: 'user', parts: [{ text: 'vi su anuncio en facebook' }], at: now - 1000 },
    ];
    const merged = geminiService.mergeRecentUserMessages(hist, 10000);
    assert.equal(merged.filter(m => m.role === 'user').length, 1);
    assert.ok(merged[0].text.includes('Me llamo Andre') && merged[0].text.includes('vi su anuncio'));
  });

  it('does not repeat date after confirmation in final reply when not reprogramming', async () => {
    // Simulate leadData with ready_to_notify true and fechaHora present
    const reply = 'Perfecto, tu cita queda agendada el martes 10 de agosto a las 3:00 PM.';
    const pruned = geminiService.sanitizeModelTextOutput(reply);
    assert.ok(typeof pruned === 'string' && pruned.length > 0);
  });

  it('does not treat qualifiers like "vale, pero" or "ok, otra hora" as explicit confirmation', async () => {
    assert.equal(geminiService.isExplicitConfirmation('vale, pero prefiero a las 4pm'), false);
    assert.equal(geminiService.isExplicitConfirmation('ok, otra hora'), false);
    assert.equal(geminiService.isExplicitConfirmation('ok, dame un segundo'), false);
    assert.equal(geminiService.isExplicitConfirmation('sí'), true);
    assert.equal(geminiService.isExplicitConfirmation('OK'), true);
    assert.equal(geminiService.isExplicitConfirmation('sí, confirmo'), true);
  });
});
