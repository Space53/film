const express = require('express');
const http = require('http');
const https = require('https');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const url = require('url');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

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
  companySessions.set(id, { url: 'https://google.com' });
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
  res.json({ success: true });
});

// ========== ФУНКЦИЯ ЗАГРУЗКИ КОНТЕНТА (аналог fetch_content из PHP) ==========
function fetchContent(targetUrl, callback) {
  const parsed = url.parse(targetUrl);
  const protocol = parsed.protocol === 'https:' ? https : http;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.path,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'identity'
    }
  };

  const req = protocol.request(options, (res) => {
    // Собираем заголовки, убираем запрещающие
    const responseHeaders = {};
    Object.keys(res.headers).forEach(key => {
      const lk = key.toLowerCase();
      if (lk !== 'x-frame-options' && 
          lk !== 'content-security-policy' && 
          lk !== 'content-security-policy-report-only') {
        responseHeaders[key] = res.headers[key];
      }
    });
    responseHeaders['X-Frame-Options'] = 'ALLOWALL';

    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      callback(null, body, responseHeaders, res.statusCode);
    });
  });

  req.on('error', (err) => callback(err));
  req.end();
}

// ========== ПЕРЕЗАПИСЬ URL (аналог rewrite_urls из PHP) ==========
function rewriteUrls(content, baseUrl, proxyBase) {
  // Атрибуты, которые могут содержать URL
  const pattern = /(href|src|action|url)=["']([^"']+)["']/gi;
  
  return content.replace(pattern, (match, attr, link) => {
    // Пропускаем data:, javascript:, mailto: и уже проксированные
    if (link.startsWith('data:') || 
        link.startsWith('javascript:') || 
        link.startsWith('mailto:') ||
        link.startsWith('#') ||
        link.includes('/proxy?url=')) {
      return match;
    }

    let absoluteUrl;
    if (link.startsWith('http://') || link.startsWith('https://')) {
      absoluteUrl = link;
    } else if (link.startsWith('//')) {
      absoluteUrl = (baseUrl.startsWith('https:') ? 'https:' : 'http:') + link;
    } else if (link.startsWith('/')) {
      const parsed = url.parse(baseUrl);
      absoluteUrl = parsed.protocol + '//' + parsed.host + link;
    } else {
      absoluteUrl = baseUrl + (baseUrl.endsWith('/') ? '' : '/') + link;
    }

    const proxiedUrl = proxyBase + encodeURIComponent(absoluteUrl);
    return attr + '="' + proxiedUrl + '"';
  });
}

// ========== ПЕРЕЗАПИСЬ JS ==========
function rewriteJsContent(content, baseUrl, proxyBase) {
  // window.location.href = "..."
  content = content.replace(/window\.location\.href\s*=\s*["']([^"']+)["']/gi, (match, link) => {
    if (link.startsWith('http')) {
      return 'window.location.href="' + proxyBase + encodeURIComponent(link) + '"';
    }
    return match;
  });

  // document.URL = "..."
  content = content.replace(/document\.URL\s*=\s*["']([^"']+)["']/gi, (match, link) => {
    if (link.startsWith('http')) {
      return 'document.URL="' + proxyBase + encodeURIComponent(link) + '"';
    }
    return match;
  });

  return content;
}

// ========== ПРОКСИ ЭНДПОИНТ ==========
app.use('/proxy', (req, res) => {
  let targetUrl = req.query.url;
  const companyId = req.query.companyId || '';

  if (!targetUrl) return res.status(400).send('url required');

  // Добавляем протокол если нет
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = 'https://' + targetUrl;
  }

  const parsed = url.parse(targetUrl);
  const baseUrl = parsed.protocol + '//' + parsed.host;
  const proxyBase = '/proxy?url=';

  fetchContent(targetUrl, (err, content, headers, statusCode) => {
    if (err) {
      return res.status(500).send('Proxy error: ' + err.message);
    }

    // Определяем тип контента
    const contentType = headers['content-type'] || '';

    // Устанавливаем заголовки ответа
    Object.keys(headers).forEach(key => {
      res.setHeader(key, headers[key]);
    });

    if (contentType.includes('text/html')) {
      // Внедряем скрипт синхронизации
      const syncScript = `
<script src="/socket.io/socket.io.js"></script>
<script>
(function(){
  if(window.__syncInjected) return;
  window.__syncInjected = true;
  const socket = io();
  const companyId = '${companyId}';
  socket.emit('join-sync', {companyId});

  function send(type, payload){
    socket.emit('browser-action', {companyId, type, payload});
  }

  socket.on('browser-action', data => {
    try{
      if(data.type === 'scroll') window.scrollTo(data.payload.x, data.payload.y);
      else if(data.type === 'click'){
        const el = document.elementFromPoint(data.payload.x, data.payload.y);
        if(el){ el.focus(); el.click(); }
      }else if(data.type === 'input'){
        const el = document.activeElement;
        if(el && (el.tagName==='INPUT'||el.tagName==='TEXTAREA')){
          el.value = data.payload.value;
          el.dispatchEvent(new Event('input', {bubbles:true}));
        }
      }else if(data.type === 'video'){
        document.querySelectorAll('video,audio').forEach(v=>{
          if(data.payload.action==='play') v.play();
          else if(data.payload.action==='pause') v.pause();
          else if(data.payload.action==='seek') v.currentTime=data.payload.time;
          else if(data.payload.action==='volume') v.volume=data.payload.volume;
        });
      }
    }catch(e){}
  });

  let st;
  window.addEventListener('scroll', ()=>{
    clearTimeout(st);
    st = setTimeout(()=>send('scroll',{x:scrollX,y:scrollY}), 50);
  }, {passive:true});
  document.addEventListener('click', e=>send('click',{x:e.clientX,y:e.clientY}), true);
  document.addEventListener('input', e=>{
    if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA')
      send('input',{value:e.target.value});
  });
  document.addEventListener('play', e=>{
    if(e.target.tagName==='VIDEO'||e.target.tagName==='AUDIO')
      send('video',{action:'play'});
  }, true);
  document.addEventListener('pause', e=>{
    if(e.target.tagName==='VIDEO'||e.target.tagName==='AUDIO')
      send('video',{action:'pause'});
  }, true);
  document.addEventListener('volumechange', e=>{
    if(e.target.tagName==='VIDEO'||e.target.tagName==='AUDIO')
      send('video',{action:'volume',volume:e.target.volume});
  }, true);
  document.addEventListener('seeked', e=>{
    if(e.target.tagName==='VIDEO'||e.target.tagName==='AUDIO')
      send('video',{action:'seek',time:e.target.currentTime});
  }, true);
})();
<\/script>
`;

      // Перезаписываем URL
      let processed = rewriteUrls(content, baseUrl, proxyBase);
      
      // Внедряем скрипт
      if (processed.includes('</head>')) {
        processed = processed.replace('</head>', syncScript + '</head>');
      } else if (processed.includes('<body')) {
        processed = processed.replace('<body', syncScript + '<body');
      } else {
        processed = syncScript + processed;
      }

      res.send(processed);
    } else if (contentType.includes('javascript') || contentType.includes('application/javascript')) {
      // Перезаписываем JS
      const processed = rewriteJsContent(content, baseUrl, proxyBase);
      res.send(processed);
    } else {
      // Отдаём как есть (CSS, изображения и т.д.)
      res.send(content);
    }
  });
});

// ========== WebSocket ==========
io.on('connection', (socket) => {
  socket.on('register-socket', ({ login }) => socket.join(`user-${login}`));

  socket.on('join-company', ({ companyId, login }) => {
    const company = companies.get(companyId);
    if (!company || !company.members.has(login)) return socket.emit('error', 'Access denied');
    socket.join(`company-${companyId}`);
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
    io.to(`company-${companyId}`).emit('chat-message', { from, text });
  });

  socket.on('voice-message', ({ companyId, from, audioData }) => {
    io.to(`company-${companyId}`).emit('voice-message', { from, audioData });
  });
});

// ========== HTML (сокращённый, полностью рабочий) ==========
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Sync Browser</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family:-apple-system, sans-serif; }
    body { background:#000; height:100vh; overflow:hidden; }
    #app { height:100vh; display:flex; flex-direction:column; background:#111; }
    #auth-screen { display:flex; align-items:center; justify-content:center; height:100vh; background:#0a0a0a; padding:16px; }
    .auth-card { background:#1c1c1e; padding:32px 20px; border-radius:32px; width:100%; max-width:400px; }
    .auth-logo { font-size:32px; font-weight:700; color:#fff; text-align:center; margin-bottom:32px; }
    .auth-logo i { color:#0a84ff; margin-right:8px; }
    .auth-tabs { display:flex; gap:8px; margin-bottom:24px; background:#0a0a0a; padding:4px; border-radius:40px; }
    .auth-tab { flex:1; padding:14px; text-align:center; color:#888; font-weight:600; font-size:17px; border-radius:36px; }
    .auth-tab.active { background:#0a84ff; color:#fff; }
    .auth-input { width:100%; padding:18px 20px; margin-bottom:12px; background:#0a0a0a; border:1px solid #333; border-radius:20px; color:#fff; font-size:17px; outline:none; }
    .auth-btn { width:100%; padding:18px; background:#0a84ff; color:#fff; border:none; border-radius:20px; font-size:18px; font-weight:700; margin-top:16px; }
    #main-screen { display:none; flex-direction:column; height:100vh; background:#000; }
    .top-bar { display:flex; align-items:center; padding:8px; background:#1c1c1e; gap:6px; }
    .nav-btn { width:44px; height:44px; border-radius:30px; background:#2c2c2e; border:none; color:#0a84ff; font-size:18px; }
    .url-box { flex:1; display:flex; align-items:center; background:#1c1c1e; border-radius:30px; padding:0 6px 0 16px; border:1px solid #333; }
    .url-box input { flex:1; background:transparent; border:none; color:#fff; font-size:15px; padding:12px 0; outline:none; }
    .url-box button { background:#0a84ff; border:none; color:#fff; padding:8px 16px; border-radius:26px; font-size:15px; font-weight:600; }
    .user-btn { background:#2c2c2e; border:none; color:#fff; padding:0 14px; height:44px; border-radius:30px; font-size:14px; display:flex; align-items:center; gap:6px; }
    .companies-row { padding:10px; background:#0a0a0a; display:flex; gap:8px; overflow-x:auto; }
    .chip { background:#1c1c1e; padding:10px 18px; border-radius:40px; color:#ccc; font-size:15px; display:inline-flex; align-items:center; gap:6px; border:1px solid #333; }
    .chip.active { background:#0a84ff; color:#fff; }
    .chip.create { background:transparent; border:1px dashed #0a84ff; color:#0a84ff; }
    .add-panel { display:flex; gap:8px; padding:10px; background:#0a0a0a; }
    .add-panel input { flex:1; background:#1c1c1e; border:1px solid #333; border-radius:30px; padding:14px 18px; color:#fff; font-size:15px; }
    .add-panel button { width:50px; height:50px; border-radius:30px; background:#0a84ff; border:none; color:#fff; font-size:20px; }
    iframe { flex:1; width:100%; border:none; background:#fff; }
    #chat-container { position:fixed; bottom:90px; right:12px; width:calc(100vw - 24px); max-width:340px; z-index:9999; touch-action:none; }
    .chat-window { background:#1c1c1e; border-radius:24px; overflow:hidden; display:none; flex-direction:column; height:480px; }
    .chat-window.open { display:flex; }
    .chat-header { padding:16px; background:#0a0a0a; color:#fff; display:flex; justify-content:space-between; cursor:grab; }
    .chat-msgs { flex:1; padding:14px; overflow-y:auto; background:#000; display:flex; flex-direction:column; gap:8px; }
    .msg { max-width:80%; padding:12px 16px; border-radius:20px; font-size:15px; }
    .msg.mine { align-self:flex-end; background:#0a84ff; color:#fff; }
    .msg.other { align-self:flex-start; background:#2c2c2e; color:#fff; }
    .msg .name { font-size:12px; opacity:0.7; margin-bottom:3px; }
    .voice { display:flex; align-items:center; gap:10px; }
    .play-btn { width:42px; height:42px; border-radius:30px; background:#0a84ff; border:none; color:#fff; }
    .chat-footer { padding:12px; background:#0a0a0a; display:flex; gap:8px; }
    .chat-footer input { flex:1; background:#1c1c1e; border:1px solid #333; border-radius:40px; padding:14px 18px; color:#fff; }
    .chat-footer button { width:50px; height:50px; border-radius:40px; background:#2c2c2e; border:none; color:#0a84ff; font-size:22px; }
    .chat-footer button.rec { background:#ff3b30; color:#fff; }
    .chat-toggle { position:fixed; bottom:20px; right:20px; width:65px; height:65px; border-radius:45px; background:#0a84ff; border:none; color:#fff; font-size:30px; z-index:10000; }
    .modal { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.9); display:none; align-items:center; justify-content:center; z-index:20000; padding:20px; }
    .modal-card { background:#1c1c1e; padding:28px 24px; border-radius:36px; width:100%; }
    .modal-card h3 { color:#fff; font-size:22px; margin-bottom:24px; }
    .modal-card input { width:100%; padding:18px; background:#0a0a0a; border:1px solid #333; border-radius:24px; color:#fff; font-size:17px; margin-bottom:24px; }
    .modal-actions { display:flex; gap:12px; }
    .modal-actions button { flex:1; padding:16px; border-radius:30px; border:none; font-size:17px; font-weight:600; }
    .modal-cancel { background:#3a3a3c; color:#fff; }
    .modal-ok { background:#0a84ff; color:#fff; }
    .toast { position:fixed; bottom:90px; left:20px; right:20px; background:#ff3b30; color:#fff; padding:14px; border-radius:40px; text-align:center; display:none; z-index:15000; }
  </style>
</head>
<body>
<div id="app">
  <div id="auth-screen">
    <div class="auth-card">
      <div class="auth-logo"><i class="fab fa-google"></i> Sync</div>
      <div class="auth-tabs">
        <div class="auth-tab active" data-tab="login">Вход</div>
        <div class="auth-tab" data-tab="register">Регистрация</div>
      </div>
      <div id="login-form">
        <input id="login-user" class="auth-input" placeholder="Логин">
        <input id="login-pass" class="auth-input" type="password" placeholder="Пароль">
        <button class="auth-btn" id="login-btn">Войти</button>
      </div>
      <div id="register-form" style="display:none">
        <input id="reg-user" class="auth-input" placeholder="Логин">
        <input id="reg-pass" class="auth-input" type="password" placeholder="Пароль">
        <button class="auth-btn" id="register-btn">Создать</button>
      </div>
    </div>
  </div>
  <div id="main-screen">
    <div class="top-bar">
      <button class="nav-btn" onclick="history.back()"><i class="fas fa-chevron-left"></i></button>
      <button class="nav-btn" onclick="history.forward()"><i class="fas fa-chevron-right"></i></button>
      <button class="nav-btn" onclick="iframe.src=iframe.src"><i class="fas fa-arrow-rotate-right"></i></button>
      <div class="url-box">
        <input id="url-input" value="google.com">
        <button onclick="navTo(urlInput.value)">→</button>
      </div>
      <button class="user-btn" onclick="logout()"><i class="fas fa-user"></i> <span id="user-name"></span></button>
    </div>
    <div class="companies-row">
      <div class="chip create" onclick="showCreateModal()"><i class="fas fa-plus"></i> Новая</div>
      <div id="company-chips" style="display:flex; gap:8px;"></div>
    </div>
    <div class="add-panel" id="add-member-panel" style="display:none">
      <input id="add-member-input" placeholder="Логин участника">
      <button onclick="addMember()"><i class="fas fa-user-plus"></i></button>
    </div>
    <iframe id="browser-iframe"></iframe>
    <div id="chat-container">
      <div class="chat-window" id="chat-window">
        <div class="chat-header" id="chat-drag"><span><i class="fas fa-comment"></i> Чат</span><i class="fas fa-times" onclick="chatWin.classList.remove('open')" style="padding:8px"></i></div>
        <div class="chat-msgs" id="chat-msgs"></div>
        <div class="chat-footer">
          <input id="chat-input" placeholder="Сообщение...">
          <button id="mic-btn" onclick="toggleMic()"><i class="fas fa-microphone"></i></button>
          <button onclick="sendMsg()"><i class="fas fa-paper-plane"></i></button>
        </div>
      </div>
    </div>
    <button class="chat-toggle" onclick="chatWin.classList.toggle('open')"><i class="fas fa-comment-dots"></i></button>
  </div>
  <div class="modal" id="company-modal">
    <div class="modal-card">
      <h3>Новая компания</h3>
      <input id="new-company-name" placeholder="Название">
      <div class="modal-actions">
        <button class="modal-cancel" onclick="modal.style.display='none'">Отмена</button>
        <button class="modal-ok" onclick="createCompany()">Создать</button>
      </div>
    </div>
  </div>
  <div class="toast" id="toast"></div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  let currentUser = null, currentCompany = null, companies = [];
  let mediaRecorder = null, audioChunks = [], recording = false;
  const authScr = document.getElementById('auth-screen');
  const mainScr = document.getElementById('main-screen');
  const loginForm = document.getElementById('login-form');
  const regForm = document.getElementById('register-form');
  const userName = document.getElementById('user-name');
  const urlInput = document.getElementById('url-input');
  const iframe = document.getElementById('browser-iframe');
  const chipsDiv = document.getElementById('company-chips');
  const addPanel = document.getElementById('add-member-panel');
  const toast = document.getElementById('toast');
  const chatWin = document.getElementById('chat-window');
  const chatMsgs = document.getElementById('chat-msgs');
  const chatInput = document.getElementById('chat-input');
  const modal = document.getElementById('company-modal');

  // Drag chat
  const chatCont = document.getElementById('chat-container');
  const dragEl = document.getElementById('chat-drag');
  let drag = false, sx, sy, sl, st;
  dragEl.addEventListener('touchstart', e=>{
    drag=true; const t=e.touches[0];
    sx=t.clientX; sy=t.clientY;
    const r=chatCont.getBoundingClientRect();
    sl=r.left; st=r.top;
    chatCont.style.right='auto'; chatCont.style.bottom='auto';
    chatCont.style.left=sl+'px'; chatCont.style.top=st+'px';
    e.preventDefault();
  }, {passive:false});
  window.addEventListener('touchmove', e=>{
    if(!drag)return; e.preventDefault();
    const t=e.touches[0];
    chatCont.style.left=Math.max(0, Math.min(window.innerWidth-chatCont.offsetWidth, sl+(t.clientX-sx)))+'px';
    chatCont.style.top=Math.max(0, Math.min(window.innerHeight-chatCont.offsetHeight, st+(t.clientY-sy)))+'px';
  });
  window.addEventListener('touchend', ()=>drag=false);

  document.querySelectorAll('.auth-tab').forEach(t=>{
    t.onclick = ()=>{
      document.querySelectorAll('.auth-tab').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      loginForm.style.display = t.dataset.tab==='login'?'block':'none';
      regForm.style.display = t.dataset.tab==='login'?'none':'block';
    };
  });

  function showToast(msg){ toast.style.display='block'; toast.textContent=msg; setTimeout(()=>toast.style.display='none',2500); }
  async function api(url, method, body){
    const r = await fetch(url, {method, headers:{'Content-Type':'application/json'}, body:body?JSON.stringify(body):undefined});
    return r.json();
  }

  document.getElementById('login-btn').onclick = async ()=>{
    const l = document.getElementById('login-user').value.trim();
    const p = document.getElementById('login-pass').value;
    if(!l||!p) return showToast('Введите данные');
    const res = await api('/api/login','POST',{login:l,password:p});
    if(res.success){ currentUser=l; socket.emit('register-socket',{login:l}); loadCompanies(); mainScr.style.display='flex'; authScr.style.display='none'; userName.textContent=l; }
    else showToast(res.error||'Ошибка');
  };

  document.getElementById('register-btn').onclick = async ()=>{
    const l = document.getElementById('reg-user').value.trim();
    const p = document.getElementById('reg-pass').value;
    if(!l||!p) return showToast('Введите данные');
    const res = await api('/api/register','POST',{login:l,password:p});
    if(res.success){ document.querySelector('[data-tab="login"]').click(); showToast('Готово!'); }
    else showToast(res.error||'Ошибка');
  };

  window.logout = ()=>{ currentUser=null; currentCompany=null; authScr.style.display='flex'; mainScr.style.display='none'; };

  async function loadCompanies(){
    if(!currentUser) return;
    companies = await api('/api/companies/'+currentUser,'GET');
    renderChips();
  }

  function renderChips(){
    chipsDiv.innerHTML = '';
    companies.forEach(c=>{
      const chip = document.createElement('div');
      chip.className = 'chip' + (currentCompany===c.id?' active':'');
      chip.innerHTML = '<i class="fas fa-users"></i> '+c.name;
      chip.onclick = ()=> switchCompany(c.id);
      chipsDiv.appendChild(chip);
    });
  }

  function switchCompany(id){
    const c = companies.find(x=>x.id===id);
    if(!c) return;
    currentCompany = id;
    socket.emit('join-company', {companyId:id, login:currentUser});
    renderChips();
    addPanel.style.display = c.owner===currentUser ? 'flex' : 'none';
    chatMsgs.innerHTML = '';
  }

  socket.on('sync-state', s=>{ if(s&&s.url){ urlInput.value=s.url.replace('https://',''); navTo(s.url); } });
  socket.on('navigate', d=>{ urlInput.value=d.url.replace('https://',''); navTo(d.url); });

  window.navTo = function(url){
    if(!url.includes('://')) url='https://'+url;
    urlInput.value = url.replace('https://','');
    iframe.src = '/proxy?url=' + encodeURIComponent(url) + '&companyId=' + (currentCompany||'');
    if(currentCompany) socket.emit('navigate',{companyId:currentCompany, url});
  };

  window.showCreateModal = ()=> modal.style.display='flex';
  window.createCompany = async ()=>{
    const name = document.getElementById('new-company-name').value.trim();
    if(!name) return showToast('Название?');
    const res = await api('/api/companies','POST',{owner:currentUser,name});
    if(res.success){ modal.style.display='none'; loadCompanies(); }
    else showToast(res.error);
  };

  window.addMember = async ()=>{
    const login = document.getElementById('add-member-input').value.trim();
    if(!login) return;
    const res = await api('/api/companies/'+currentCompany+'/add-member','POST',{login, addedBy:currentUser});
    if(res.success){ document.getElementById('add-member-input').value=''; loadCompanies(); showToast('Добавлен'); }
    else showToast(res.error);
  };

  socket.on('member-added', ()=> loadCompanies());

  function addMsg(from, txt, mine){
    const d=document.createElement('div');
    d.className = 'msg '+(mine?'mine':'other');
    d.innerHTML = '<div class="name">'+from+'</div>'+txt;
    chatMsgs.appendChild(d);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }

  function addVoice(from, data, mine){
    const d=document.createElement('div');
    d.className = 'msg '+(mine?'mine':'other');
    d.innerHTML = '<div class="name">'+from+'</div>';
    const v=document.createElement('div');
    v.className='voice';
    const b=document.createElement('button');
    b.className='play-btn';
    b.innerHTML='<i class="fas fa-play"></i>';
    const a=new Audio(data);
    b.onclick=()=>a.play();
    v.appendChild(b);
    v.appendChild(document.createTextNode('Голосовое'));
    d.appendChild(v);
    chatMsgs.appendChild(d);
    chatMsgs.scrollTop = chatMsgs.scrollHeight;
  }

  window.sendMsg = ()=>{
    const txt = chatInput.value.trim();
    if(!txt||!currentCompany) return;
    socket.emit('chat-message',{companyId:currentCompany, from:currentUser, text:txt});
    addMsg(currentUser, txt, true);
    chatInput.value = '';
  };

  socket.on('chat-message', d=>{ if(d.from!==currentUser) addMsg(d.from, d.text, false); });

  window.toggleMic = async ()=>{
    const btn = document.getElementById('mic-btn');
    if(!recording){
      try{
        const stream = await navigator.mediaDevices.getUserMedia({audio:true});
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        mediaRecorder.ondataavailable = e=> audioChunks.push(e.data);
        mediaRecorder.onstop = ()=>{
          const blob = new Blob(audioChunks, {type:'audio/webm'});
          const r = new FileReader();
          r.onloadend = ()=>{
            socket.emit('voice-message',{companyId:currentCompany, from:currentUser, audioData:r.result});
            addVoice(currentUser, r.result, true);
          };
          r.readAsDataURL(blob);
          stream.getTracks().forEach(t=>t.stop());
        };
        mediaRecorder.start();
        btn.classList.add('rec');
        recording = true;
      }catch(e){ showToast('Нет доступа к микрофону'); }
    } else {
      mediaRecorder.stop();
      btn.classList.remove('rec');
      recording = false;
    }
  };

  socket.on('voice-message', d=>{ if(d.from!==currentUser) addVoice(d.from, d.audioData, false); });

  navTo('google.com');
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
