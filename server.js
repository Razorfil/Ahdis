const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const https = require('https');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const HASTANE_KIMLIKLER = {
  hacettepe: { sifre: 'hast123', name: 'Hacettepe Üniversitesi Hastanesi' },
  mamak:     { sifre: 'mamak456', name: 'Mamak Devlet Hastanesi' },
  ankara:    { sifre: 'anka789', name: 'Ankara Şehir Hastanesi' }
};

const VERI = {
  hacettepe: { capacity: 200, counts: { green:5, yellow:3, red:2 }, queues: [] },
  mamak:     { capacity: 150, counts: { green:3, yellow:2, red:1 }, queues: [] },
  ankara:    { capacity: 300, counts: { green:8, yellow:5, red:4 }, queues: [] }
};

const qCounters = { green:999, yellow:2999, red:4999 };

function nextNum(acil) {
  qCounters[acil]++;
  if (acil==='green'  && qCounters[acil]>2999) qCounters[acil]=1000;
  if (acil==='yellow' && qCounters[acil]>4999) qCounters[acil]=3000;
  if (acil==='red'    && qCounters[acil]>6999) qCounters[acil]=5000;
  return qCounters[acil];
}

app.get('/api/hastaneler', (req, res) => {
  const ozet = {};
  for (const [id, h] of Object.entries(VERI)) {
    const total = h.counts.green + h.counts.yellow + h.counts.red;
    const fill  = Math.min(100, Math.round((total / h.capacity) * 100));
    ozet[id] = { name: HASTANE_KIMLIKLER[id].name, fill, capacity: h.capacity, counts: h.counts, siraCount: h.queues.filter(q=>!q.called).length };
  }
  res.json(ozet);
});

app.post('/api/giris', (req, res) => {
  const { hastaneId, sifre } = req.body;
  const h = HASTANE_KIMLIKLER[hastaneId];
  if (!h || h.sifre !== sifre) return res.status(401).json({ hata: 'Kimlik hatalı' });
  res.json({ ok: true, name: h.name });
});

app.post('/api/hasta-ekle', (req, res) => {
  const { hastaneId, sifre, name, tc, oyku, acil } = req.body;
  const h = HASTANE_KIMLIKLER[hastaneId];
  if (!h || h.sifre !== sifre) return res.status(401).json({ hata: 'Yetkisiz' });
  if (!['green','yellow','red'].includes(acil)) return res.status(400).json({ hata: 'Geçersiz aciliyet' });
  const base = { green: 1000, yellow: 3000, red: 5000 };
  const max  = { green: 2999, yellow: 4999, red: 6999 };
  let num = base[acil] + VERI[hastaneId].counts[acil];
  if (num > max[acil]) num = base[acil];
  VERI[hastaneId].queues.push({ name, tc, oyku, acil, num, called: false });
  VERI[hastaneId].counts[acil]++;
  yayinla();
  res.json({ ok: true, num });
});

app.post('/api/cagir', (req, res) => {
  const { hastaneId, sifre, num } = req.body;
  const h = HASTANE_KIMLIKLER[hastaneId];
  if (!h || h.sifre !== sifre) return res.status(401).json({ hata: 'Yetkisiz' });
  const q = VERI[hastaneId].queues.find(x=>x.num===num);
  if (q) q.called = true;
  yayinla();
  res.json({ ok: true });
});

app.post('/api/sil', (req, res) => {
  const { hastaneId, sifre, num } = req.body;
  const h = HASTANE_KIMLIKLER[hastaneId];
  if (!h || h.sifre !== sifre) return res.status(401).json({ hata: 'Yetkisiz' });
  const q = VERI[hastaneId].queues.find(x=>x.num===num);
  if (q) {
    VERI[hastaneId].counts[q.acil] = Math.max(0, VERI[hastaneId].counts[q.acil]-1);
    VERI[hastaneId].queues = VERI[hastaneId].queues.filter(x=>x.num!==num);
  }
  yayinla();
  res.json({ ok: true });
});

app.post('/api/ayril', (req, res) => {
  const { tc } = req.body;
  if (!tc) return res.status(400).json({ ok: false });
  for (const [hastaneId, h] of Object.entries(VERI)) {
    const idx = h.queues.findIndex(x => x.tc === tc);
    if (idx !== -1) {
      const q = h.queues[idx];
      h.counts[q.acil] = Math.max(0, h.counts[q.acil] - 1);
      h.queues.splice(idx, 1);
      yayinla();
      return res.json({ ok: true });
    }
  }
  res.json({ ok: false });
});

app.post('/api/sayac', (req, res) => {
  const { hastaneId, sifre, acil, deger } = req.body;
  const h = HASTANE_KIMLIKLER[hastaneId];
  if (!h || h.sifre !== sifre) return res.status(401).json({ hata: 'Yetkisiz' });
  VERI[hastaneId].counts[acil] = Math.max(0, parseInt(deger)||0);
  yayinla();
  res.json({ ok: true });
});

app.post('/api/kapasite', (req, res) => {
  const { hastaneId, sifre, kapasite } = req.body;
  const h = HASTANE_KIMLIKLER[hastaneId];
  if (!h || h.sifre !== sifre) return res.status(401).json({ hata: 'Yetkisiz' });
  VERI[hastaneId].capacity = Math.max(1, parseInt(kapasite)||1);
  yayinla();
  res.json({ ok: true });
});

app.post('/api/tc-sorgula', (req, res) => {
  const { tc } = req.body;
  if (!tc) return res.status(400).json({ bulundu: false });
  for (const [hastaneId, h] of Object.entries(VERI)) {
    const q = h.queues.find(x => x.tc === tc);
    if (q) {
      const onunde = h.queues.filter(x => x.acil === q.acil && x.num < q.num && !x.called).length;
      const queuedCount = h.queues.filter(x => x.acil === q.acil).length;
      const extraOnunde = Math.max(0, h.counts[q.acil] - queuedCount);
      const toplamOnunde = onunde + extraOnunde;
      return res.json({ bulundu: true, hastaneId, num: q.num, acil: q.acil, oyku: q.oyku, called: q.called, onunde: toplamOnunde });
    }
  }
  res.json({ bulundu: false });
});

app.post('/api/siralar', (req, res) => {
  const { hastaneId, sifre } = req.body;
  const h = HASTANE_KIMLIKLER[hastaneId];
  if (!h || h.sifre !== sifre) return res.status(401).json({ hata: 'Yetkisiz' });
  res.json({ queues: VERI[hastaneId].queues });
});

// ── Razorbill Maskot — OpenRouter API ──
app.post('/api/maskot', async (req, res) => {
  const { mesajlar } = req.body;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ hata: 'API anahtarı eksik' });

  const systemPrompt = `Sen AHDİS uygulamasının maskotu Razorbill'sin. Razorbill, Kuzey Atlantik'te yaşayan, zeki ve çevik bir deniz kuşudur.

Görevin: Kullanıcıların semptomlarını dinleyip hastaneye gitmeleri gerekip gerekmediği konusunda genel bilgi vermek.

KESİNLİKLE UYULACAK KURALLAR:
1. Teşhis KOYMA. Sadece genel bilgi ver.
2. Her yanıtın sonunda şunu ekle: "⚠️ Bu değerlendirme yapay zeka tarafından üretilmiştir ve tıbbi tavsiye niteliği taşımaz. Kesin tanı için mutlaka bir sağlık kuruluşuna başvurunuz."
3. Acil belirtilerde (göğüs ağrısı, nefes darlığı, bilinç kaybı, felç belirtileri, şiddetli kanama) HER ZAMAN "🚨 ACİL: Hemen 112'yi arayın!" uyarısı ver.
4. Türkçe konuş, sıcak ve sakin bir dil kullan.
5. Yanıtların kısa ve anlaşılır olsun, 3-4 cümleyi geçme.
6. Hastaneye gitmeyi önereceğinde:
   - ACİL (hemen git): göğüs ağrısı, nefes darlığı, bilinç kaybı, 39C+ ateş, şiddetli kanama
   - BUGÜN GİT: orta ateş, 3+ gün süren semptomlar, şiddetlenen ağrı
   - BEKLEYEBİLİRSİN: hafif semptomlar, soğuk algınlığı başlangıcı`;

  const body = JSON.stringify({
    model: 'mistralai/mistral-7b-instruct:free',
    messages: [
      { role: 'system', content: systemPrompt },
      ...mesajlar.map(m => ({
        role: m.rol === 'user' ? 'user' : 'assistant',
        content: m.metin
      }))
    ],
    max_tokens: 400,
    temperature: 0.4
  });

  const options = {
    hostname: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
      'HTTP-Referer': 'https://ahdis.onrender.com',
      'X-Title': 'AHDIS Razorbill',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  try {
    const yanit = await new Promise((resolve, reject) => {
      const request = https.request(options, response => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            console.log('OpenRouter yanit:', JSON.stringify(parsed).substring(0, 300));
            if (parsed.choices && parsed.choices[0]) {
              resolve(parsed.choices[0].message.content);
            } else {
              reject(new Error('Beklenmedik yanit: ' + JSON.stringify(parsed)));
            }
          } catch(e) { reject(e); }
        });
      });
      request.on('error', reject);
      request.write(body);
      request.end();
    });
    res.json({ yanit });
  } catch(e) {
    console.error('OpenRouter hata:', e.message);
    res.status(500).json({ hata: e.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Set();

wss.on('connection', ws => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.send(JSON.stringify({ tip: 'guncelle', veri: getOzet() }));
});

function getOzet() {
  const ozet = {};
  for (const [id, h] of Object.entries(VERI)) {
    const total = h.counts.green + h.counts.yellow + h.counts.red;
    ozet[id] = {
      name: HASTANE_KIMLIKLER[id].name,
      fill: Math.min(100, Math.round((total / h.capacity) * 100)),
      capacity: h.capacity, counts: h.counts,
      siraCount: h.queues.filter(q=>!q.called).length
    };
  }
  return ozet;
}

function yayinla() {
  const msg = JSON.stringify({ tip: 'guncelle', veri: getOzet() });
  clients.forEach(c => { if (c.readyState===WebSocket.OPEN) c.send(msg); });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('✅ AHDİS çalışıyor. PORT: ' + PORT);
});
