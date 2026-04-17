const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Хранилища
const users = new Map();
const companies = new Map();
const companySessions = new Map();

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

// ========== ПРОКСИ С ИНЖЕКТОМ СКРИПТА СИНХРОНИЗАЦИИ ==========
const syncScript = `
<script>
(function() {
  if (window.__syncInjected) return;
  window.__syncInjected = true;

  const socket = io();
  const companyId = window.__COMPANY_ID__;
  const url = window.__CURRENT_URL__;

  socket.emit('join-sync', { companyId });

  // Отправка событий родителю
  function sendAction(type, payload) {
    socket.emit('browser-action', { companyId, type, payload });
  }

  // Слушаем входящие действия от других
  socket.on('browser-action', (data) => {
    if (data.type === 'scroll') {
      window.scrollTo({ left: data.payload.x, top: data.payload.y, behavior: 'auto' });
    } else if (data.type === 'click') {
      const el = document.elementFromPoint(data.payload.x, data.payload.y);
      if (el) {
        el.focus();
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
          // не симулируем клик по полям ввода, чтобы не мешать вводу
        } else {
          el.click();
        }
      }
    } else if (data.type === 'input') {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        el.value = data.payload.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (data.type === 'change') {
      const el = document.querySelector(data.payload.selector);
      if (el) {
        if (el.type === 'checkbox' || el.type === 'radio') el.checked = data.payload.checked;
        else el.value = data.payload.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else if (data.type === 'video') {
      const videos = document.querySelectorAll('video');
      videos.forEach(v => {
        if (data.payload.action === 'play') v.play();
        else if (data.payload.action === 'pause') v.pause();
        else if (data.payload.action === 'seek') v.currentTime = data.payload.time;
        else if (data.payload.action === 'volume') v.volume = data.payload.volume;
        else if (data.payload.action === 'muted') v.muted = data.payload.muted;
      });
      // YouTube API
      if (window.YT && window.YT.Player) {
        const players = YT.Player.getPlayers();
        for (let id in players) {
          const p = players[id];
          if (data.payload.action === 'play') p.playVideo();
          else if (data.payload.action === 'pause') p.pauseVideo();
          else if (data.payload.action === 'seek') p.seekTo(data.payload.time);
          else if (data.payload.action === 'volume') p.setVolume(data.payload.volume * 100);
          else if (data.payload.action === 'muted') p.mute();
        }
      }
    }
  });

  // Перехват событий
  window.addEventListener('scroll', () => {
    sendAction('scroll', { x: window.scrollX, y: window.scrollY });
  }, { passive: true });

  document.addEventListener('click', (e) => {
    sendAction('click', { x: e.clientX, y: e.clientY });
  }, true);

  document.addEventListener('input', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      sendAction('input', { value: e.target.value });
    }
  });

  document.addEventListener('change', (e) => {
    const el = e.target;
    let selector = el.id ? '#' + el.id : el.className ? '.' + el.className.split(' ')[0] : el.tagName;
    sendAction('change', { 
      selector: selector, 
      value: el.value, 
      checked: el.checked 
    });
  });

  // Медиа-элементы
  document.addEventListener('play', (e) => {
    if (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO') {
      sendAction('video', { action: 'play' });
    }
  }, true);
  document.addEventListener('pause', (e) => {
    if (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO') {
      sendAction('video', { action: 'pause' });
    }
  }, true);
  document.addEventListener('volumechange', (e) => {
    const v = e.target;
    sendAction('video', { action: 'volume', volume: v.volume, muted: v.muted });
  }, true);
  document.addEventListener('seeked', (e) => {
    sendAction('video', { action: 'seek', time: e.target.currentTime });
  }, true);

  // YouTube iframe API перехват (упрощённо)
  const originalPostMessage = window.postMessage;
  window.postMessage = function(msg, targetOrigin, transfer) {
    if (msg && typeof msg === 'string') {
      try {
        const data = JSON.parse(msg);
        if (data.event === 'infoDelivery' && data.info && data.info.playerState !== undefined) {
          // ловим состояние плеера
        }
      } catch(e) {}
    }
    return originalPostMessage.call(this, msg, targetOrigin, transfer);
  };

  console.log('Sync injected on', window.location.href);
})();
<\/script>
`;

// Middleware для инжекта скрипта в HTML ответы
const injectScript = (proxyRes, req, res) => {
  const contentType = proxyRes.headers['content-type'];
  if (contentType && contentType.includes('text/html')) {
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      // Внедряем скрипт перед </body> или </html>
      const injected = body.replace('</body>', `
        <script src="/socket.io/socket.io.js"></script>
        <script>window.__COMPANY_ID__ = '${req.__companyId || ''}'; window.__CURRENT_URL__ = '${req.__targetUrl || ''}';</script>
        ${syncScript}
        </body>
      `);
      res.setHeader('content-length', Buffer.byteLength(injected));
      res.end(injected);
    });
  } else {
    proxyRes.pipe(res);
  }
};

app.use('/sync-proxy', (req, res, next) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('url required');
  
  // Сохраняем companyId из query для инжекта
  req.__companyId = req.query.companyId || '';
  req.__targetUrl = targetUrl;

  const proxy = createProxyMiddleware({
    target: targetUrl,
    changeOrigin: true,
    secure: false,
    followRedirects: true,
    selfHandleResponse: true,
    onProxyRes: (proxyRes, req, res) => {
      delete proxyRes.headers['x-frame-options'];
      delete proxyRes.headers['content-security-policy'];
      proxyRes.headers['X-Frame-Options'] = 'ALLOWALL';
      injectScript(proxyRes, req, res);
    },
    pathRewrite: (path, req) => {
      const urlObj = new URL(targetUrl);
      return urlObj.pathname + urlObj.search + path.replace(/^\/sync-proxy/, '');
    },
    router: () => targetUrl
  });
  proxy(req, res, next);
});

// ========== WebSocket ==========
io.on('connection', (socket) => {
  let currentUser = null;

  socket.on('register-socket', ({ login }) => {
    currentUser = login;
    socket.join(`user-${login}`);
  });

  socket.on('join-company', ({ companyId, login }) => {
    const company = companies.get(companyId);
    if (!company || !company.members.has(login)) {
      socket.emit('error', 'Access denied');
      return;
    }
    socket.join(`company-${companyId}`);
    socket.emit('joined', { companyId, members: Array.from(company.members) });
    const session = companySessions.get(companyId) || { url: 'https://google.com' };
    socket.emit('sync-state', session);
  });

  socket.on('join-sync', ({ companyId }) => {
    socket.join(`company-${companyId}`);
  });

  socket.on('navigate', ({ companyId, url }) => {
    if (!companyId) return;
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
server.listen(PORT, () => console.log(`Server on ${PORT}`));
