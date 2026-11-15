/* CamFeed voice / video calls (1-to-1, WebRTC). Load on any page: it rings when someone calls. */
(function () {
  'use strict';
  if (window.CamCall || window.self !== window.top) return;
  var me = null;
  try { me = JSON.parse(localStorage.getItem('camfeed_user') || 'null'); } catch (e) {}
  if (!me || !me.email) return;

  var S = { call: null, pc: null, local: null, remote: null, incoming: null, poll: null, tick: null, t0: 0,
    iceCache: null, iceAt: 0, pendingIce: [], remoteIce: [], answerSet: false, facing: 'user', ac: null, ring: null, wake: null, ended: false };
  var DEF_PIC = 'data:image/svg+xml;utf8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Crect width=%22100%22 height=%22100%22 fill=%22%23475569%22/%3E%3Ccircle cx=%2250%22 cy=%2238%22 r=%2218%22 fill=%22%2394a3b8%22/%3E%3Cellipse cx=%2250%22 cy=%2286%22 rx=%2232%22 ry=%2226%22 fill=%22%2394a3b8%22/%3E%3C/svg%3E';

  var css = document.createElement('style');
  css.textContent = '\
#ccUI{position:fixed;inset:0;z-index:2147483000;background:#0b1220;color:#fff;display:none;flex-direction:column;font-family:inherit;-webkit-user-select:none;user-select:none}\
#ccUI.show{display:flex}\
#ccRemote{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#0b1220}\
#ccRemote.off{opacity:0;pointer-events:none}\
#ccLocal{position:absolute;right:14px;top:calc(env(safe-area-inset-top,0px) + 14px);width:104px;height:150px;object-fit:cover;border-radius:14px;border:2px solid rgba(255,255,255,.7);background:#1e293b;z-index:3;transform:scaleX(-1);box-shadow:0 6px 20px rgba(0,0,0,.4)}\
#ccLocal.back{transform:none}\
#ccLocal.hide{display:none}\
#ccInfo{position:relative;z-index:2;margin-top:calc(env(safe-area-inset-top,0px) + 56px);text-align:center;padding:0 20px;text-shadow:0 2px 10px rgba(0,0,0,.6)}\
#ccInfo img{width:112px;height:112px;border-radius:50%;object-fit:cover;border:3px solid rgba(255,255,255,.35);background:#334155}\
#ccName{font-size:24px;font-weight:800;margin-top:12px}\
#ccStatus{font-size:15px;opacity:.9;margin-top:6px}\
#ccInfo.mini{margin-top:calc(env(safe-area-inset-top,0px) + 14px);text-align:left;position:absolute;left:16px}\
#ccInfo.mini img{display:none}\
#ccInfo.mini #ccName{font-size:17px;margin:0}\
#ccInfo.mini #ccStatus{font-size:13px;margin:2px 0 0}\
#ccBar{position:absolute;left:0;right:0;bottom:0;z-index:4;display:flex;justify-content:center;gap:18px;padding:18px 16px calc(env(safe-area-inset-bottom,0px) + 28px);background:linear-gradient(transparent,rgba(0,0,0,.55))}\
.ccBtn{width:62px;height:62px;border-radius:50%;border:none;font-size:26px;cursor:pointer;color:#fff;background:rgba(255,255,255,.18);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;-webkit-tap-highlight-color:transparent}\
.ccBtn.off{background:#fff;color:#0f172a}\
.ccBtn.red{background:#ef4444}\
.ccBtn.green{background:#22c55e;animation:ccPulse 1.2s infinite}\
.ccBtn.hidden{display:none}\
.ccLbl{font-size:11px;text-align:center;margin-top:6px;opacity:.85}\
.ccCol{display:flex;flex-direction:column;align-items:center}\
@keyframes ccPulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.6)}70%{box-shadow:0 0 0 18px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}\
#ccToast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#0f172a;color:#fff;padding:10px 16px;border-radius:12px;font-size:14px;z-index:2147483100;display:none;max-width:86vw;text-align:center}';
  document.head.appendChild(css);

  var ui = null;
  function el(id) { return document.getElementById(id); }
  function buildUI() {
    if (ui) return ui;
    ui = document.createElement('div'); ui.id = 'ccUI';
    ui.innerHTML = '<video id="ccRemote" autoplay playsinline></video><video id="ccLocal" autoplay playsinline muted class="hide"></video>' +
      '<div id="ccInfo"><img id="ccPic" alt=""><div id="ccName"></div><div id="ccStatus"></div></div><div style="flex:1"></div>' +
      '<div id="ccBar">' +
      '<div class="ccCol"><button class="ccBtn" id="ccMic" type="button">🎤</button><div class="ccLbl">មីក្រូ</div></div>' +
      '<div class="ccCol" id="ccCamWrap"><button class="ccBtn" id="ccCam" type="button">📹</button><div class="ccLbl">កាមេរ៉ា</div></div>' +
      '<div class="ccCol" id="ccFlipWrap"><button class="ccBtn" id="ccFlip" type="button">🔄</button><div class="ccLbl">ប្ដូរកាមេរ៉ា</div></div>' +
      '<div class="ccCol"><button class="ccBtn red" id="ccEnd" type="button">📞</button><div class="ccLbl" id="ccEndLbl">បញ្ចប់</div></div>' +
      '<div class="ccCol" id="ccAccWrap" style="display:none"><button class="ccBtn green" id="ccAcc" type="button">📞</button><div class="ccLbl">ទទួល</div></div>' +
      '</div>';
    document.body.appendChild(ui);
    var t = document.createElement('div'); t.id = 'ccToast'; document.body.appendChild(t);
    el('ccMic').onclick = toggleMic; el('ccCam').onclick = toggleCam; el('ccFlip').onclick = flipCam;
    el('ccEnd').onclick = function () { hangup(true); };
    el('ccAcc').onclick = accept;
    return ui;
  }
  function toast(msg) {
    buildUI(); var t = el('ccToast'); t.textContent = msg; t.style.display = 'block';
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.style.display = 'none'; }, 3500);
  }
  function setStatus(s) { var n = el('ccStatus'); if (n) n.textContent = s; }
  function fmt(sec) { var m = Math.floor(sec / 60), s = sec % 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; }

  // always resolves: {success, ..., _status} (_status 0 = network error)
  function api(path, method, body) {
    return fetch(path, { method: method || 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j = (j && typeof j === 'object') ? j : {}; j._status = r.status; return j; }); })
      .catch(function () { return { success: false, _status: 0 }; });
  }
  function transient(j) { return j._status === 0 || j._status === 429 || j._status >= 500; }
  function apiRetry(path, method, body, tries) {
    return api(path, method, body).then(function (j) {
      if (transient(j) && tries > 1) return new Promise(function (ok) { setTimeout(ok, 1200); }).then(function () { return apiRetry(path, method, body, tries - 1); });
      return j;
    });
  }
  S.dismissed = {};

  // ---------- ringing sounds ----------
  function stopTone() { if (S.ring) { clearInterval(S.ring); S.ring = null; } try { navigator.vibrate && navigator.vibrate(0); } catch (e) {} }
  function startTone(incoming) {
    stopTone();
    function beep() {
      try {
        S.ac = S.ac || new (window.AudioContext || window.webkitAudioContext)();
        if (S.ac.state === 'suspended') S.ac.resume();
        var freqs = incoming ? [880, 660] : [440, 480], vol = incoming ? 0.22 : 0.1;
        freqs.forEach(function (fq, i) {
          var o = S.ac.createOscillator(), g = S.ac.createGain();
          o.frequency.value = fq; o.type = 'sine'; o.connect(g); g.connect(S.ac.destination);
          var t = S.ac.currentTime + i * 0.28;
          g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.03); g.gain.linearRampToValueAtTime(0, t + 0.24);
          o.start(t); o.stop(t + 0.26);
        });
      } catch (e) {}
      if (incoming) { try { navigator.vibrate && navigator.vibrate([400, 200, 400]); } catch (e) {} }
    }
    beep(); S.ring = setInterval(beep, incoming ? 1800 : 3000);
  }

  // ---------- media + peer ----------
  function mediaError(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'PermissionDeniedError') return 'សូមអនុញ្ញាតឱ្យប្រើមីក្រូ/កាមេរ៉ា ក្នុងការកំណត់ browser';
    if (n === 'NotFoundError') return 'រកមិនឃើញមីក្រូ ឬកាមេរ៉ា';
    return 'មិនអាចបើកមីក្រូ/កាមេរ៉ាបានទេ';
  }
  function getMedia(kind) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.reject({ name: 'NotSupported' });
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: kind === 'video' ? { facingMode: S.facing, width: { ideal: 960 }, height: { ideal: 540 } } : false });
  }
  function getIce() {
    if (S.iceCache && Date.now() - S.iceAt < 10 * 60 * 1000) return Promise.resolve(S.iceCache);
    return api('/api/calls/ice').then(function (j) {
      S.iceCache = (j && j.iceServers) || [{ urls: 'stun:stun.l.google.com:19302' }]; S.turn = !!(j && j.turn); S.iceAt = Date.now(); return S.iceCache;
    }).catch(function () { return [{ urls: 'stun:stun.l.google.com:19302' }]; });
  }
  function makePC(servers, kind) {
    var pc = new RTCPeerConnection({ iceServers: servers });
    S.pc = pc; S.answerSet = false; S.remoteIce = []; S.pendingIce = []; S.ended = false;
    S.remote = new MediaStream();
    pc.ontrack = function (e) {
      (e.streams[0] ? e.streams[0].getTracks() : [e.track]).forEach(function (t) { if (!S.remote.getTracks().includes(t)) S.remote.addTrack(t); });
      var rv = el('ccRemote'); rv.srcObject = S.remote; var p = rv.play(); if (p && p.catch) p.catch(function () {});
      if (e.track.kind === 'video') { rv.classList.remove('off'); el('ccInfo').classList.add('mini'); }
    };
    pc.onicecandidate = function (e) {
      if (!e.candidate) return;
      var c = e.candidate.toJSON ? e.candidate.toJSON() : e.candidate;
      if (S.call && S.call.id) apiRetry('/api/calls/' + S.call.id + '/ice', 'POST', { candidate: c }, 3); else S.pendingIce.push(c);
    };
    var dis = null;
    pc.onconnectionstatechange = function () {
      var st = pc.connectionState;
      if (st === 'connected') { clearTimeout(dis); onConnected(); }
      else if (st === 'disconnected') { setStatus('កំពុងតភ្ជាប់ឡើងវិញ…'); clearTimeout(dis); dis = setTimeout(function () { if (S.pc === pc && pc.connectionState !== 'connected') hangup(true, 'ការតភ្ជាប់ដាច់ · TURN ' + (S.turn ? 'មាន' : 'គ្មាន')); }, 9000); }
      else if (st === 'failed') { hangup(true, 'ការតភ្ជាប់បរាជ័យ · TURN ' + (S.turn ? 'មាន' : 'គ្មាន')); }
    };
    S.local.getTracks().forEach(function (t) { pc.addTrack(t, S.local); });
    return pc;
  }
  function onConnected() {
    stopTone();
    if (!S.t0) {
      S.t0 = Date.now();
      S.tick = setInterval(function () { setStatus(fmt(Math.round((Date.now() - S.t0) / 1000))); }, 1000);
      setStatus('00:00');
    }
  }
  function showCallUI(name, pic, kind, mode) {
    buildUI();
    el('ccName').textContent = name || 'CamFeed';
    el('ccPic').src = pic || DEF_PIC;
    el('ccInfo').classList.remove('mini');
    el('ccRemote').classList.add('off');
    var vid = kind === 'video';
    el('ccCamWrap').style.display = vid && mode !== 'ring' ? '' : 'none';
    el('ccFlipWrap').style.display = vid && mode !== 'ring' ? '' : 'none';
    el('ccMic').parentNode.style.display = mode === 'ring' ? 'none' : '';
    el('ccAccWrap').style.display = mode === 'ring' ? '' : 'none';
    el('ccEndLbl').textContent = mode === 'ring' ? 'បដិសេធ' : 'បញ្ចប់';
    el('ccMic').classList.remove('off'); el('ccCam').classList.remove('off');
    el('ccMic').textContent = '🎤'; el('ccCam').textContent = '📹';
    var lv = el('ccLocal');
    if (vid && S.local && mode !== 'ring') { lv.srcObject = S.local; lv.classList.remove('hide'); lv.classList.remove('back'); var p = lv.play(); if (p && p.catch) p.catch(function () {}); }
    else lv.classList.add('hide');
    ui.classList.add('show');
    try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (w) { S.wake = w; }).catch(function () {}); } catch (e) {}
  }
  function cleanup(msg) {
    stopTone(); clearInterval(S.poll); clearInterval(S.tick); S.poll = null; S.tick = null;
    try { S.local && S.local.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { S.pc && S.pc.close(); } catch (e) {}
    try { S.wake && S.wake.release(); } catch (e) {}
    S.local = null; S.pc = null; S.call = null; S.incoming = null; S.t0 = 0; S.wake = null; S.answerSet = false;
    if (ui) { ui.classList.remove('show'); var rv = el('ccRemote'); if (rv) rv.srcObject = null; var lv = el('ccLocal'); if (lv) lv.srcObject = null; }
    if (msg) toast(msg);
    schedulePoll(800);
  }
  function hangup(notify, msg) {
    if (S.ended) return; S.ended = true;
    var id = (S.call && S.call.id) || (S.incoming && S.incoming.id);
    if (id) S.dismissed[id] = Date.now();
    if (notify && id) apiRetry('/api/calls/' + id + '/end', 'POST', { why: msg || 'user' }, 5);
    cleanup(msg);
  }

  // ---------- outgoing ----------
  function start(peer, kind, name, pic) {
    if (S.call || S.incoming) { toast('កំពុងមានការហៅមួយរួចហើយ'); return; }
    if (!window.RTCPeerConnection) { toast('browser នេះមិនគាំទ្រការហៅទេ'); return; }
    kind = kind === 'video' ? 'video' : 'audio';
    var call = S.call = { id: null, role: 'caller', peer: peer, kind: kind, icIdx: 0 };   // reserve the slot immediately
    S.ended = false; S.facing = 'user';
    getMedia(kind).then(function (stream) {
      if (S.call !== call) { stream.getTracks().forEach(function (t) { t.stop(); }); return null; }
      S.local = stream;
      showCallUI(name, pic, kind, 'out');
      setStatus('កំពុងហៅ…'); startTone(false);
      return getIce().then(function (servers) {
        var pc = makePC(servers, kind);
        return pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).then(function () {
          return apiRetry('/api/calls/start', 'POST', { peer_email: peer, kind: kind, offer: JSON.stringify(pc.localDescription) }, 3);
        });
      });
    }).then(function (j) {
      if (!j) return;
      if (S.call !== call) { if (j.success && j.id) apiRetry('/api/calls/' + j.id + '/end', 'POST', {}, 5); return; }   // caller gave up before the id arrived
      if (!j.success) { hangup(false, j.code === 'chat_restricted' ? j.error : j.error === 'busy' ? 'គេកំពុងនិយាយទូរស័ព្ទជាមួយអ្នកផ្សេង' : j.error === 'blocked' ? 'មិនអាចហៅអ្នកប្រើនេះបានទេ' : j._status === 401 ? 'សូមចូលគណនីម្ដងទៀត' : 'ហៅមិនបាន សូមព្យាយាមម្ដងទៀត (កូដ ' + j._status + ')'); return; }
      S.call.id = j.id;
      S.pendingIce.forEach(function (c) { apiRetry('/api/calls/' + j.id + '/ice', 'POST', { candidate: c }, 3); }); S.pendingIce = [];
      S.poll = setInterval(pollCall, 1000);
    }).catch(function (e) { console.error('[call]', e); S.call = null; cleanupSilent(); toast(e && e.name ? mediaError(e) : 'ហៅមិនបាន សូមព្យាយាមម្ដងទៀត'); });
  }
  function cleanupSilent() { S.ended = true; cleanup(); }

  // ---------- incoming ----------
  function showIncoming(inc) {
    S.incoming = inc; S.ended = false;
    showCallUI(inc.name || inc.from_email, inc.pic, inc.kind, 'ring');
    setStatus(inc.kind === 'video' ? 'ការហៅវីដេអូចូល…' : 'ការហៅសំឡេងចូល…');
    startTone(true);
    try { document.title = '📞 ' + (inc.name || '') + ' · CamFeed'; } catch (e) {}
  }
  function accept() {
    var inc = S.incoming; if (!inc) return;
    stopTone(); S.facing = 'user'; S.dismissed[inc.id] = Date.now();
    getMedia(inc.kind).then(function (stream) {
      S.local = stream;
      S.call = { id: inc.id, role: 'callee', peer: inc.from_email, kind: inc.kind, icIdx: 0 };
      S.incoming = null;
      showCallUI(inc.name || inc.from_email, inc.pic, inc.kind, 'out');
      setStatus('កំពុងតភ្ជាប់…');
      return getIce().then(function (servers) {
        var pc = makePC(servers, inc.kind);
        return pc.setRemoteDescription(JSON.parse(inc.offer)).then(function () { S.answerSet = true; return pc.createAnswer(); })
          .then(function (a) { return pc.setLocalDescription(a); })
          .then(function () { return apiRetry('/api/calls/' + inc.id + '/answer', 'POST', { answer: JSON.stringify(pc.localDescription) }, 3); });
      });
    }).then(function (j) {
      if (!j) return;
      if (!j.success) { hangup(true, transient(j) ? 'បណ្ដាញមានបញ្ហា សូមព្យាយាមម្ដងទៀត (កូដ ' + j._status + ')' : 'ការហៅបានបញ្ចប់ហើយ [' + (j.why || j._status) + ']'); return; }
      S.poll = setInterval(pollCall, 1000);
    }).catch(function (e) {
      console.error('[call]', e);
      apiRetry('/api/calls/' + inc.id + '/end', 'POST', {}, 5);
      S.call = null; cleanupSilent(); toast(e && e.name ? mediaError(e) : 'ទទួលការហៅមិនបាន សូមព្យាយាមម្ដងទៀត');
    });
  }

  // ---------- in-call polling ----------
  function addRemoteIce(list) {
    list.forEach(function (c) {
      if (S.answerSet) S.pc.addIceCandidate(c).catch(function () {}); else S.remoteIce.push(c);
    });
  }
  function pollCall() {
    var c = S.call; if (!c || !c.id || !S.pc) return;
    api('/api/calls/' + c.id + '?ic=' + c.icIdx).then(function (j) {
      if (!S.call || S.call.id !== c.id) return;
      if (!j.success) {
        if (j._status === 404) { hangup(false, 'ការហៅបានបញ្ចប់ [404]'); return; }
        c.fails = (c.fails || 0) + 1;                       // network hiccup / rate limit: keep the call, only give up after ~25 s
        if (c.fails > 25) hangup(true, 'ការតភ្ជាប់ដាច់');
        return;
      }
      c.fails = 0;
      if (j.status === 'accepted' && c.role === 'caller' && !S.answerSet && j.answer) {
        stopTone(); setStatus('កំពុងតភ្ជាប់…');
        S.pc.setRemoteDescription(JSON.parse(j.answer)).then(function () {
          S.answerSet = true; var q = S.remoteIce; S.remoteIce = []; q.forEach(function (x) { S.pc.addIceCandidate(x).catch(function () {}); });
        }).catch(function (e) { hangup(true, 'ការតភ្ជាប់បរាជ័យ sdp:' + ((e && (e.name || e.message)) || '')); });
      }
      if (j.ice && j.ice.length) { addRemoteIce(j.ice); c.icIdx = j.icTotal; }
      if (j.status !== 'ringing' && j.status !== 'accepted') {
        var m = { declined: 'គេបានបដិសេធការហៅ', missed: 'គ្មានអ្នកទទួល', cancelled: 'ការហៅត្រូវបានបោះបង់', ended: 'ការហៅបានបញ្ចប់' }[j.status];
        hangup(false, m + (j.why ? ' [' + j.why + ']' : ''));
      }
    }).catch(function () {});
  }

  // ---------- controls ----------
  function toggleMic() {
    if (!S.local) return; var t = S.local.getAudioTracks()[0]; if (!t) return;
    t.enabled = !t.enabled; el('ccMic').classList.toggle('off', !t.enabled); el('ccMic').textContent = t.enabled ? '🎤' : '🔇';
  }
  function toggleCam() {
    if (!S.local) return; var t = S.local.getVideoTracks()[0]; if (!t) return;
    t.enabled = !t.enabled; el('ccCam').classList.toggle('off', !t.enabled); el('ccCam').textContent = t.enabled ? '📹' : '🚫';
  }
  function flipCam() {
    if (!S.local || !S.pc) return;
    var next = S.facing === 'user' ? 'environment' : 'user';
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: next } }, audio: false }).then(function (ns) {
      var nt = ns.getVideoTracks()[0], old = S.local.getVideoTracks()[0];
      var sender = S.pc.getSenders().find(function (s) { return s.track && s.track.kind === 'video'; });
      if (sender) sender.replaceTrack(nt);
      if (old) { S.local.removeTrack(old); old.stop(); }
      S.local.addTrack(nt); S.facing = next;
      var lv = el('ccLocal'); lv.srcObject = S.local; lv.classList.toggle('back', next === 'environment');
    }).catch(function () { toast('មិនអាចប្ដូរកាមេរ៉ាបានទេ'); });
  }

  // ---------- idle polling for incoming calls ----------
  var pollTimer = null;
  function schedulePoll(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(idlePoll, ms); }
  function idlePoll() {
    if (S.call) { schedulePoll(3000); return; }
    if (document.hidden && !S.incoming) { schedulePoll(8000); return; }
    api('/api/calls/poll').then(function (j) {
      if (S.call) return;
      if (!j || !j.success) return;                           // errors never close a ringing screen
      var inc = j.incoming;
      if (inc && S.dismissed[inc.id]) inc = null;
      if (inc && !S.incoming) showIncoming(inc);
      else if (!inc && S.incoming) { S.ended = true; var nm = S.incoming.name; cleanup('ខកខានការហៅពី ' + (nm || '')); try { document.title = document.title.replace(/^📞 /, ''); } catch (e) {} }
    }).catch(function () {}).then(function () { schedulePoll(S.incoming ? 1500 : 4000); });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && !S.call) schedulePoll(200); });
  window.addEventListener('beforeunload', function () { var id = (S.call && S.call.id) || (S.incoming && S.incoming.id); if (id) { try { navigator.sendBeacon('/api/calls/' + id + '/end', new Blob(['{}'], { type: 'application/json' })); } catch (e) {} } });

  window.CamCall = { start: start, busy: function () { return !!(S.call || S.incoming); } };
  schedulePoll(2500);
})();
