// Vercel Serverless Function: POST /api/chat
// Переменные окружения в Vercel (Settings → Environment Variables):
//   Нужен ОДИН ключ (проверяются по порядку):
//   GEMINI_API_KEY    — ключ Google AI Studio (модель gemini-3.1-flash-lite)
//   GROQ_API_KEY      — бесплатно, console.groq.com/keys (модель llama-3.3-70b-versatile)
//   ANTHROPIC_API_KEY — платно, console.anthropic.com (модель claude-haiku-4-5)
//   AI_MODEL          — необязательно: другая модель того же сервиса
//   ALLOWED_ORIGIN    — адрес сайта, если он открыт не с Vercel (например https://onamizf.github.io)
const SYSTEM_PROMPT = require('../lib/prompt');

const MAX_MESSAGES = 16;   // хранится только последняя часть диалога
const MAX_CHARS = 1500;    // длина одного сообщения студента

module.exports = async function handler(req, res) {
  const allowed = process.env.ALLOWED_ORIGIN || '';
  const origin = req.headers.origin || '';
  if (allowed) {
    res.setHeader('Vary', 'Origin');
    if (origin === allowed) res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Только POST' });

  const provider = process.env.GEMINI_API_KEY ? 'gemini' : process.env.GROQ_API_KEY ? 'groq' : process.env.ANTHROPIC_API_KEY ? 'claude' : null;
  if (!provider) return res.status(500).json({ error: 'Помощник ещё не подключён: в Vercel не задан ключ (GEMINI_API_KEY, GROQ_API_KEY или ANTHROPIC_API_KEY).' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const raw = Array.isArray(body && body.messages) ? body.messages : [];
  const messages = raw
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_MESSAGES)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Нет вопроса студента.' });
  }

  try {
    let text = '';
    if (provider === 'claude') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: process.env.AI_MODEL || 'claude-haiku-4-5', max_tokens: 600, temperature: 0.3, system: SYSTEM_PROMPT, messages }),
        signal: AbortSignal.timeout(15000)
      });
      const data = await r.json();
      if (!r.ok) { console.error('Claude API error', r.status); return res.status(502).json({ error: 'Помощник временно недоступен. Попробуйте позже или задайте вопрос преподавателю.' }); }
      text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    } else {
      // Gemini и Groq принимают одинаковый формат запроса (OpenAI-совместимый)
      const cfg = provider === 'gemini'
        ? { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: process.env.GEMINI_API_KEY, model: 'gemini-3.1-flash-lite' }
        : { url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY, model: 'llama-3.3-70b-versatile' };
      const r = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key },
        body: JSON.stringify({ model: process.env.AI_MODEL || cfg.model, max_tokens: 600, temperature: 0.3,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages] }),
        signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) {
        console.error(provider + ' API error', r.status);
        if (r.status === 429) {
          return res.status(429).json({ error: 'Достигнут лимит запросов к помощнику. Попробуйте позже.' });
        }
        return res.status(502).json({ error: 'Помощник временно недоступен. Попробуйте позже или задайте вопрос преподавателю.' });
      }
      const data = await r.json();
      text = ((data.choices || [])[0]?.message?.content || '').trim();
    }
    return res.status(200).json({ reply: text || 'Не получилось сформулировать ответ. Переформулируйте вопрос.' });
  } catch (e) {
    console.error('AI request failed', e.name);
    return res.status(502).json({ error: 'Нет связи с помощником. Проверьте интернет и попробуйте ещё раз.' });
  }
};
