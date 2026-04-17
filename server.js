const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Хранилища в памяти
const users = new Map();
const companies = new Map();
const companySessions = new Map();

// ========== ОТДАЁМ HTML ==========
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.status(404).send('index.html not found. Create it next to server.js');
  }
});

// ========== API ==========
app.post('/api/register', (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'login and password required' });
  if (users.has(login)) return res.status(400).json({ error: 'user exists' });
  users.set(login, { password, companies: new Set() });
  res.json({ success: true });
});

app.post('/api/login', (req, res) => {
  const { login, password } = req.body;
  const user = users.get(login);
  if (!user || user.password !== password) return res.status(401).json({ error: 'invalid credentials' });
  res.json({ success: true });
});

app.post('/api/companies', (req, res) => {
  const { owner, name } = req.body;
  const user = users.get(owner);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const id = uuidv4().slice(0, 8);
  const members = new Set([owner]);
  companies.set(id, { id, name, owner, members });
  user.companies.add(id);
  res.json({ success: true, company: { id, name, owner } });
});

app.get('/api/companies/:owner', (req, res) => {
  const user = users.get(req.params.owner);
  if (!user) return res.json([]);
  const list = [];
  for (let cid of user.companies) {
    const c = companies.get(cid);
    if (c) list.push({ id: c.id, name: c.name, owner: c.owner, members: Array.from(c.members) });
  }
  res.json(list);
});

app.post('/api/companies/:id/add-member', (req, res) => {
  const { id } = req.params;
  const { login, addedBy } = req.body;
  const company = companies.get(id);
  if (!company) return res.status(404).json({ error: 'company not found' });
  if (company.owner !== addedBy) return res.status(403).json({ error: 'only owner can add' });
  const targetUser = users.get(login);
  if (!targetUser) return res.status(404).json({ error: 'user not found' });
  company.members.add(login);
  targetUser.companies.add(id);
  io.to(`company-${id}`).emit('member-added', { login });
  res.json({ success: true, members: Array.from(company.members) });
});

// ========== ПРОКСИ (не ломает файлы) ==========
const syncScript = `
<script src="/socket.io/socket.io.js"></script>
<script>
(function() {
  if (window.__syncInjected) return;
  window.__syncInjected = true;
  const socket = io();
  const companyId = window.__COMPANY_ID__;
  socket.emit('join-sync', { companyId });

  function sendAction(type, payload) {
    socket.emit('browser-action', { companyId, type, payload });
  }

  socket.on('browser-action', (data) => {
    try {
      if (data.type === 'scroll') window.scrollTo(data.payload.x, data.payload.y);
      else if (data.type === 'click') {
        const el = document.elementFromPoint(data.payload.x, data.payload.y);
        if (el) { el.focus(); el.click(); }
      } else if (data.type === 'input') {
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
          el.value = data.payload.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } else if (data.type === 'video') {
        const vids = document.querySelectorAll('video, audio');
        vids.forEach(v => {
          if (data.payload.action === 'play') v.play();
          else if (data.payload.action === 'pause') v.pause();
          else if (data.payload.action === 'seek') v.currentTime = data.payload.time;
          else if (data.payload.action === 'volume') v.volume = data.payload.volume;
          else if (data.payload.action === 'muted') v.muted = data.payload.muted;
        });
        // YouTube iframe
        if (window.YT && window.YT.Player) {
          const players = YT.Player.getPlayers();
          for (let id in players) {
            const p = players[id];
            if (data.payload.action === 'play') p.playVideo();
            else if (data.payload.action === 'pause') p.pauseVideo();
            else if (data.payload.action === 'seek') p.seekTo(data.payload.time);
            else if (data.payload.action === 'volume') p.setVolume(data.payload.volume * 100);
          }
        }
      }
    } catch(e) { console.log('Sync error:', e); }
  });

  let scrollTimer;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => sendAction('scroll', {x:scrollX, y:scrollY}), 50);
  }, {passive:true});

  document.addEventListener('click', e => sendAction('click', {x:e.clientX, y:e.clientY}), true);
  document.addEventListener('input', e => {
    if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') sendAction('input',{value:e.target.value});
  });

  document.addEventListener('play', e => { if(e.target.tagName==='VIDEO'||e.target.tagName==='AUDIO') sendAction('video',{action:'play'}); }, true);
  document.addEventListener('pause', e => { if(e.target.tagName==='VIDEO'||e.target.tagName==='AUDIO') sendAction('video',{action:'pause'}); }, true);
  document.addEventListener('volumechange', e => { if(e.target.tagName==='VIDEO'||e.target.tagName==='AUDIO') sendAction('video',{action:'volume',volume:e.target.volume,muted:e.target.muted}); }, true);
  document.addEventListener('seeked', e => { if(e.target.tagName==='VIDEO'||e.target.tagName==='AUDIO') sendAction('video',{action:'seek',time:e.target.currentTime}); }, true);
})();
<\/script>
`;

app.use('/proxy', (req, res) => {
  const targetUrl = req.query.url;
  const companyId = req.query.companyId || '';
  if (!targetUrl) return res.status(400).send('url required');

  const proxy = createProxyMiddleware({
    target: targetUrl,
    changeOrigin: true,
    secure: false,
    followRedirects: true,
    selfHandleResponse: true,
    onProxyRes: (proxyRes, req, res) => {
      const contentType = proxyRes.headers['content-type'] || '';
      const isHtml = contentType.includes('text/html');

      delete proxyRes.headers['x-frame-options'];
      delete proxyRes.headers['content-security-policy'];
      proxyRes.headers['X-Frame-Options'] = 'ALLOWALL';

      if (isHtml) {
        let body = '';
        proxyRes.on('data', chunk => body += chunk.toString());
        proxyRes.on('end', () => {
          const injected = body
            .replace('<head>', `<head><script>window.__COMPANY_ID__='${companyId}';</script>`)
            .replace('</head>', `${syncScript}</head>`);
          res.setHeader('content-type', 'text/html');
          res.end(injected);
        });
      } else {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
    },
    onError: (err, req, res) => res.status(500).send('Proxy error'),
    pathRewrite: (path, req) => {
      const urlObj = new URL(targetUrl);
      return urlObj.pathname + urlObj.search + path.replace(/^\/proxy/, '');
    }
  });

  proxy(req, res);
});

// ========== WebSocket ==========
io.on('connection', (socket) => {
  socket.on('register-socket', ({ login }) => socket.join(`user-${login}`));

  socket.on('join-company', ({ companyId, login }) => {
    const company = companies.get(companyId);
    if (!company || !company.members.has(login)) return socket.emit('error', 'Access denied');
    socket.join(`company-${companyId}`);
    socket.emit('joined', { companyId, members: Array.from(company.members) });
    const session = companySessions.get(companyId) || { url: 'https://google.com' };
    socket.emit('sync-state', session);
  });

  socket.on('join-sync', ({ companyId }) => socket.join(`company-${companyId}`));

  socket.on('navigate', ({ companyId, url }) => {
    companySessions.set(companyId, { url });
    socket.to(`company-${companyId}`).emit('navigate', { url });
  });

  socket.on('browser-action', ({ companyId, type, payload }) => {
    socket.to(`company-${companyId}`).emit('browser-action', { type, payload });
  });

  socket.on('chat-message', ({ companyId, from, text }) => {
    io.to(`company-${companyId}`).emit('chat-message', { from, text, timestamp: Date.now() });
  });

  socket.on('voice-message', ({ companyId, from, audioData }) => {
    io.to(`company-${companyId}`).emit('voice-message', { from, audioData, timestamp: Date.now() });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
