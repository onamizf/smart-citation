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
      const isGemini = provider === 'gemini';
      const model = process.env.AI_MODEL || (isGemini ? 'gemini-3.1-flash-lite' : 'llama-3.3-70b-versatile');
      let url;
      let headers;
      let payload;
      if (isGemini) {
        const modelId = encodeURIComponent(model.replace(/^models\//, ''));
        url = 'https://generativelanguage.googleapis.com/v1beta/models/' + modelId + ':generateContent';
        headers = { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY };
        payload = {
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: messages.map(message => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }]
          })),
          generationConfig: { maxOutputTokens: 600, temperature: 0.3 }
        };
      } else {
        url = 'https://api.groq.com/openai/v1/chat/completions';
        headers = { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.GROQ_API_KEY };
        payload = { model, max_tokens: 600, temperature: 0.3,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages] };
      }
      const r = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(isGemini ? 28000 : 15000)
      });
      if (!r.ok) {
        console.error(provider + ' API error', r.status);
        if (r.status === 429) {
          return res.status(429).json({ error: 'Достигнут лимит запросов к помощнику. Попробуйте позже.' });
        }
        return res.status(502).json({ error: 'Помощник временно недоступен. Попробуйте позже или задайте вопрос преподавателю.' });
      }
      const data = await r.json();
      text = isGemini
        ? (data.candidates?.[0]?.content?.parts || [])
          .filter(part => !part.thought && typeof part.text === 'string')
          .map(part => part.text).join('').trim()
        : (data.choices?.[0]?.message?.content || '').trim();
    }
    return res.status(200).json({ reply: text || 'Не получилось сформулировать ответ. Переформулируйте вопрос.' });
  } catch (e) {
    console.error('AI request failed', e.name);
    if (e.name === 'TimeoutError') {
      return res.status(504).json({ error: 'Цитатник не успел ответить. Попробуйте отправить вопрос ещё раз.' });
    }
    return res.status(502).json({ error: 'Нет связи с помощником. Проверьте интернет и попробуйте ещё раз.' });
  }
};
