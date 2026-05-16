const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

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

  // Sıra numarasını o gruptaki gerçek queue uzunluğuna göre ver
  const base = { green: 1000, yellow: 3000, red: 5000 };
  const max  = { green: 2999, yellow: 4999, red: 6999 };
  const mevcutSayisi = VERI[hastaneId].queues.filter(x => x.acil === acil).length;
  let num = base[acil] + mevcutSayisi;
  if (num > max[acil]) num = base[acil]; // taşarsa başa dön

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

// Hasta kendisi ayrıldığında çağrılan endpoint — called olsa bile sil
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

// TC sorgula — önündeki kişi sayısını sıra numarasına göre hesapla
app.post('/api/tc-sorgula', (req, res) => {
  const { tc } = req.body;
  if (!tc) return res.status(400).json({ bulundu: false });
  for (const [hastaneId, h] of Object.entries(VERI)) {
    const q = h.queues.find(x => x.tc === tc);
    if (q) {
      // Önündeki kişi: aynı aciliyet grubunda, sıra numarası daha küçük, henüz çağrılmamış
      const onunde = h.queues.filter(x =>
        x.acil === q.acil &&
        x.num < q.num &&
        !x.called
      ).length;
      return res.json({
        bulundu: true,
        hastaneId,
        num: q.num,
        acil: q.acil,
        oyku: q.oyku,
        called: q.called,
        onunde
      });
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
