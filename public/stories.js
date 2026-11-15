/* CamFeed Stories: a picture, a short video or a text card that disappears after 24 hours.
   Shows a row of circles above the feed, a full-screen viewer, and a small maker. Needs: window user in localStorage (camfeed_user). */
(function () {
  'use strict';
  var user = null; try { user = JSON.parse(localStorage.getItem('camfeed_user')); } catch (e) {}
  if (!user || !user.email) return;
  var lang = localStorage.getItem('camfeed_lang') === 'en' ? 'en' : 'km';
  var TX = {
    km: { your: 'រឿងរបស់អ្នក', create: 'បង្កើត Story', photo: '📷 រូប/វីដេអូ', textcard: '✍️ អត្ថបទ', pick: 'ជ្រើសរូប ឬវីដេអូ', cap: 'សរសេរអត្ថបទលើរូប (មិនបង្ខំ)', textPh: 'សរសេរអ្វីមួយ…', pub: '🌐 សាធារណៈ', fr: '👥 មិត្តភក្តិ (តាមដានគ្នា)', share: 'ចែករំលែក', cancel: 'បោះបង់', uploading: 'កំពុងបង្ហោះ…', long: 'វីដេអូវែងពេក។ Story វីដេអូត្រូវតែមិនលើស 30 វិនាទី។', bad: 'សូមជ្រើសរូប ឬវីដេអូ។', fail: 'មិនអាចបង្ហោះបាន សូមព្យាយាមម្តងទៀត។', reply: 'ឆ្លើយតបទៅ…', send: 'ផ្ញើ', sent: 'បានផ្ញើហើយ ✓', views: 'អ្នកមើល', noViews: 'មិនទាន់មានអ្នកមើលទេ', del: 'លុប Story នេះមែនទេ?', close: 'បិទ', ago: '' },
    en: { your: 'Your story', create: 'Create story', photo: '📷 Photo/Video', textcard: '✍️ Text', pick: 'Choose a photo or video', cap: 'Write a caption (optional)', textPh: 'Write something…', pub: '🌐 Public', fr: '👥 Friends (follow each other)', share: 'Share', cancel: 'Cancel', uploading: 'Posting…', long: 'This video is too long. A story video can be 30 seconds at most.', bad: 'Please choose a photo or a video.', fail: 'Could not post. Please try again.', reply: 'Reply to…', send: 'Send', sent: 'Sent ✓', views: 'Viewers', noViews: 'No viewers yet', del: 'Delete this story?', close: 'Close', ago: '' }
  };
  var t = function (k) { return TX[lang][k]; };
  var BG = { blue: 'linear-gradient(135deg,#1877f2,#00c6ff)', pink: 'linear-gradient(135deg,#ff5f9e,#ff9a5a)', green: 'linear-gradient(135deg,#11998e,#38ef7d)', orange: 'linear-gradient(135deg,#f7971e,#ffd200)', purple: 'linear-gradient(135deg,#654ea3,#eaafc8)', dark: 'linear-gradient(135deg,#232526,#414345)' };
  var EMOJI = ['❤️', '😂', '😮', '😢', '👏', '🔥'];
  var DEFAULT_PIC = "data:image/svg+xml;utf8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Crect width=%22100%22 height=%22100%22 fill=%22%23dfe3ea%22/%3E%3Ccircle cx=%2250%22 cy=%2238%22 r=%2218%22 fill=%22%23aab1bd%22/%3E%3Cellipse cx=%2250%22 cy=%2286%22 rx=%2232%22 ry=%2226%22 fill=%22%23aab1bd%22/%3E%3C/svg%3E";
  var groups = [], bar = null, lives = [], canGoLive = false;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function safe(u) { return /^https?:\/\//i.test(u || '') ? u : ''; }
  function ago(d) { return window.timeAgo ? window.timeAgo(d) : new Date(d).toLocaleTimeString(); }
  function api(path, opt) { opt = opt || {}; var o = { method: opt.method || 'GET', headers: {} }; if (opt.body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opt.body); } return fetch(path, o).then(function (r) { return r.json().catch(function () { return { success: false }; }); }).catch(function () { return { success: false }; }); }

  var css = document.createElement('style');
  css.textContent = '\
#storyBar{display:flex;gap:10px;overflow-x:auto;padding:10px 12px;background:#fff;margin:8px 0;border-radius:12px;scrollbar-width:none;-webkit-overflow-scrolling:touch}#storyBar::-webkit-scrollbar{display:none}\
.sb-item{flex:0 0 auto;width:74px;text-align:center;cursor:pointer}.sb-ring{width:68px;height:68px;border-radius:50%;padding:3px;margin:0 auto;background:linear-gradient(135deg,#1877f2,#e91e63,#ff9800)}.sb-ring.seen{background:#c9ccd1}.sb-ring.live{background:linear-gradient(135deg,#e41e3f,#ff5a36)}.sb-ring.add{background:#e4e6eb;position:relative}\
.sb-ring img{width:100%;height:100%;border-radius:50%;object-fit:cover;border:2px solid #fff;background:#e4e6eb;display:block}.sb-plus{position:absolute;right:-2px;bottom:-2px;width:24px;height:24px;border-radius:50%;background:#1877f2;color:#fff;font-weight:800;font-size:18px;line-height:23px;border:2px solid #fff}\
.sb-name{font-size:11.5px;margin-top:5px;color:#050505;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\
#stView{position:fixed;inset:0;background:#000;z-index:100000;display:none;flex-direction:column;touch-action:pan-y;user-select:none;-webkit-user-select:none}#stView.on{display:flex}\
.st-bars{display:flex;gap:4px;padding:10px 10px 0;position:absolute;top:env(safe-area-inset-top,0);left:0;right:0;z-index:3}.st-bar{flex:1;height:3px;background:rgba(255,255,255,.35);border-radius:2px;overflow:hidden}.st-bar i{display:block;height:100%;width:0;background:#fff}\
.st-head{position:absolute;top:calc(env(safe-area-inset-top,0px) + 20px);left:0;right:0;display:flex;align-items:center;gap:10px;padding:8px 12px;z-index:3;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.6)}.st-head img{width:38px;height:38px;border-radius:50%;object-fit:cover;border:2px solid #fff}.st-head b{font-size:15px}.st-head small{display:block;opacity:.85;font-size:12px}.st-head .sp{flex:1}.st-x{background:none;border:0;color:#fff;font-size:28px;cursor:pointer;padding:0 6px;text-shadow:0 1px 3px rgba(0,0,0,.6)}\
.st-stage{flex:1;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}.st-stage img,.st-stage video{max-width:100%;max-height:100%;object-fit:contain}.st-text{width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:30px;color:#fff;font-size:28px;font-weight:800;text-align:center;line-height:1.4;word-break:break-word}\
.st-cap{position:absolute;left:0;right:0;bottom:90px;text-align:center;padding:0 22px;z-index:2}.st-cap span{display:inline-block;background:rgba(0,0,0,.55);color:#fff;padding:8px 14px;border-radius:12px;font-size:17px;font-weight:700;word-break:break-word;max-width:100%}\
.st-tap{position:absolute;top:70px;bottom:110px;width:38%;z-index:2}.st-tap.l{left:0}.st-tap.r{right:0}\
.st-foot{position:absolute;left:0;right:0;bottom:0;padding:10px 12px calc(env(safe-area-inset-bottom,0px) + 12px);z-index:4;background:linear-gradient(transparent,rgba(0,0,0,.65));color:#fff}\
.st-emo{display:flex;justify-content:space-around;margin-bottom:8px}.st-emo button{background:none;border:0;font-size:28px;cursor:pointer;transition:transform .12s}.st-emo button.on{transform:scale(1.35)}\
.st-rep{display:flex;gap:8px}.st-rep input{flex:1;border:1.5px solid rgba(255,255,255,.7);background:rgba(0,0,0,.35);color:#fff;border-radius:22px;padding:10px 14px;font-size:15px;outline:none}.st-rep input::placeholder{color:#ddd}.st-rep button{border:0;background:#1877f2;color:#fff;border-radius:22px;padding:0 18px;font-weight:800;cursor:pointer}\
.st-mine{display:flex;justify-content:space-between;align-items:center}.st-mine button{background:rgba(255,255,255,.18);border:0;color:#fff;border-radius:18px;padding:9px 16px;font-weight:700;font-size:14px;cursor:pointer}\
.st-sheet{position:absolute;left:0;right:0;bottom:0;max-height:65%;background:#fff;color:#050505;border-radius:18px 18px 0 0;z-index:6;overflow:auto;padding:14px}.st-sheet h4{margin-bottom:8px}.st-v{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid #f0f2f5}.st-v img{width:38px;height:38px;border-radius:50%;object-fit:cover}.st-v span{flex:1}.st-v small{color:#65676b;display:block}\
#stMake{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100001;display:none;align-items:flex-end;justify-content:center}#stMake.on{display:flex}.stm-box{background:#fff;width:100%;max-width:520px;border-radius:18px 18px 0 0;padding:16px;max-height:92vh;overflow:auto}\
.stm-tabs{display:flex;gap:8px;margin-bottom:12px}.stm-tabs button{flex:1;border:0;background:#e4e6eb;border-radius:20px;padding:10px;font-weight:700;cursor:pointer}.stm-tabs button.on{background:#1877f2;color:#fff}\
.stm-prev{height:300px;border-radius:14px;background:#e4e6eb;display:flex;align-items:center;justify-content:center;overflow:hidden;margin-bottom:10px;position:relative;text-align:center;color:#65676b;cursor:pointer}.stm-prev img,.stm-prev video{width:100%;height:100%;object-fit:contain;background:#000}.stm-prev textarea{width:100%;height:100%;border:0;background:transparent;color:#fff;font-size:24px;font-weight:800;text-align:center;resize:none;padding:30px;outline:none}.stm-prev textarea::placeholder{color:rgba(255,255,255,.7)}\
.stm-in,.stm-box select{width:100%;border:1.5px solid #dadde1;border-radius:10px;padding:10px 12px;font-size:15px;margin-bottom:10px;font-family:inherit}.stm-bgs{display:flex;gap:8px;margin-bottom:10px}.stm-bgs i{width:30px;height:30px;border-radius:50%;cursor:pointer;border:3px solid transparent}.stm-bgs i.on{border-color:#050505}\
.stm-row{display:flex;gap:10px}.stm-row button{flex:1;border:0;border-radius:10px;padding:12px;font-weight:800;font-size:15px;cursor:pointer;background:#e4e6eb}.stm-row button.p{background:#1877f2;color:#fff}.stm-row button:disabled{opacity:.6}.stm-msg{color:#c0152f;font-size:13.5px;min-height:18px;margin-bottom:6px}';
  css.textContent += '\
#storyBar{gap:8px!important;padding:10px 10px!important}\
.sc{flex:0 0 auto;width:92px;height:148px;border-radius:12px;position:relative;overflow:hidden;cursor:pointer;background:#cfd3d9 center/cover no-repeat;box-shadow:0 1px 3px rgba(0,0,0,.2)}\
.sc:after{content:"";position:absolute;inset:0;background:linear-gradient(transparent 45%,rgba(0,0,0,.62));pointer-events:none}\
.sc .sca{position:absolute;left:6px;top:6px;width:32px;height:32px;border-radius:50%;border:3px solid #1877f2;background:#fff;object-fit:cover;z-index:2}.sc.seen .sca{border-color:#b0b3b8}\
.sc .scn{position:absolute;left:6px;right:6px;bottom:6px;color:#fff;font-size:12px;font-weight:700;z-index:2;line-height:1.2;text-shadow:0 1px 2px rgba(0,0,0,.6);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}\
.sc.mine{background-color:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25)}.sc.mine:after{display:none}.sc.mine .top{position:absolute;left:0;right:0;top:0;height:98px;background:center/cover no-repeat #e4e6eb}\
.sc.mine .scn{color:#050505;text-shadow:none;text-align:center;bottom:5px;font-size:12px}.sc.mine .scp{position:absolute;left:50%;top:80px;transform:translateX(-50%);width:34px;height:34px;border-radius:50%;background:#1877f2;color:#fff;font-size:24px;font-weight:700;display:flex;align-items:center;justify-content:center;border:3px solid #fff;z-index:3;line-height:1}\
.sc.live{background:linear-gradient(160deg,#e41e3f,#ff7a45)}.sc.live .sca{border-color:#fff}.sc .lv{position:absolute;right:6px;top:8px;background:#e41e3f;color:#fff;font-size:9.5px;font-weight:800;padding:1px 6px;border-radius:5px;z-index:2;border:1.5px solid #fff}.sc.golive{background:linear-gradient(160deg,#fff1f3,#ffd9de)}.sc.golive:after{display:none}.sc.golive .gi{position:absolute;left:0;right:0;top:34px;text-align:center;font-size:38px}.sc.golive .scn{color:#e41e3f;text-shadow:none;text-align:center}\
.st-stage .st-bg{position:absolute!important;inset:0;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;object-fit:cover!important;filter:blur(28px) brightness(.72);transform:scale(1.25);z-index:0;pointer-events:none}\
.st-stage .st-main{position:relative;z-index:1}\
.st-snd{position:absolute;top:calc(env(safe-area-inset-top,0px) + 72px);left:12px;z-index:3;background:rgba(0,0,0,.45);color:#fff;border-radius:16px;padding:4px 10px;font-size:12.5px;max-width:70%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\
#sndPick{position:fixed;inset:0;background:#fff;z-index:100003;display:none;flex-direction:column;color:#050505}#sndPick.on{display:flex}\
.sp-top{display:flex;align-items:center;gap:8px;padding:calc(env(safe-area-inset-top,0px) + 10px) 10px 8px}.sp-top button{border:0;background:#e4e6eb;border-radius:50%;width:38px;height:38px;font-size:18px;cursor:pointer}.sp-top input{flex:1;border:0;background:#e4e6eb;border-radius:20px;padding:10px 14px;font-size:15px;outline:none;min-width:0}\
.sp-tabs{display:flex;gap:8px;padding:0 12px 8px}.sp-tabs button{border:0;border-radius:16px;padding:6px 14px;font-weight:700;font-size:13.5px;background:#e4e6eb;cursor:pointer}.sp-tabs button.on{background:#1877f2;color:#fff}\
.sp-list{flex:1;overflow:auto;padding:0 10px 20px}.sp-row{display:flex;align-items:center;gap:10px;padding:8px 4px;border-bottom:1px solid #f0f2f5;cursor:pointer}.sp-cov{width:48px;height:48px;border-radius:8px;background:linear-gradient(135deg,#7c4dff,#1877f2);color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;object-fit:cover}\
.sp-inf{flex:1;min-width:0}.sp-inf b{display:block;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sp-inf small{color:#65676b;font-size:12.5px}.sp-row button{border:0;background:none;font-size:22px;cursor:pointer;padding:6px}.sp-empty{text-align:center;color:#65676b;padding:40px 16px;font-size:14px}\
.sp-trim{padding:14px 16px calc(env(safe-area-inset-bottom,0px) + 16px);border-top:1px solid #e4e6eb;background:#fff}.sp-bars{display:flex;align-items:center;gap:2px;height:56px;margin:10px 0}.sp-bars i{flex:1;background:#c9ccd1;border-radius:2px}.sp-bars i.on{background:#1877f2}\
.sp-trim input[type=range]{width:100%}.sp-trim .row{display:flex;gap:8px;margin-top:10px}.sp-trim .row button{flex:1;border:0;border-radius:10px;padding:12px;font-weight:800;font-size:15px;cursor:pointer;background:#e4e6eb}.sp-trim .row .p{background:#1877f2;color:#fff}.sp-lens{display:flex;gap:8px;margin-top:6px}.sp-lens button{border:0;border-radius:14px;padding:5px 12px;font-weight:700;background:#e4e6eb;cursor:pointer}.sp-lens button.on{background:#1877f2;color:#fff}\
.stm-snd{display:flex;align-items:center;gap:8px;background:#f0f2f5;border-radius:10px;padding:9px 12px;font-size:14px;cursor:pointer}.stm-snd b{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}.stm-snd span.x{color:#65676b;padding:0 4px}';
  document.head.appendChild(css);

  /* ---------- the row above the feed ---------- */
  function sc(cls) { return el('div', 'sc ' + (cls || '')); }
  function avatar(pic) { var i = el('img', 'sca'); i.src = safe(pic) || DEFAULT_PIC; i.alt = ''; i.onerror = function () { this.onerror = null; this.src = DEFAULT_PIC; }; return i; }
  function cardBg(g) {
    var st = g.stories || []; for (var i = st.length - 1; i >= 0; i--) { if (st[i].mediaType === 'image' && safe(st[i].mediaUrl)) return { img: safe(st[i].mediaUrl) }; }
    for (var j = st.length - 1; j >= 0; j--) { if (st[j].mediaType === 'text') return { grad: BG[st[j].bg] || BG.blue }; }
    return { img: safe(g.profile_pic) || '' };
  }
  function renderBar() {
    if (!bar) return; bar.textContent = '';
    var mineG = groups.filter(function (g) { return g.mine; })[0];
    var add = sc('mine'); var top = el('div', 'top'); top.style.backgroundImage = 'url("' + (safe(user.profile_pic) || DEFAULT_PIC).replace(/"/g, '') + '")'; add.appendChild(top); add.appendChild(el('div', 'scp', '+')); add.appendChild(el('div', 'scn', t(mineG ? 'your' : 'create')));
    add.onclick = function () { openMaker(); };
    bar.appendChild(add);
    if (mineG) { var my = sc(''); var mb = cardBg(mineG); if (mb.grad) my.style.background = mb.grad; else if (mb.img) my.style.backgroundImage = 'url("' + mb.img.replace(/"/g, '') + '")'; my.appendChild(avatar(user.profile_pic)); my.appendChild(el('div', 'scn', t('your'))); my.onclick = function () { openViewer(groups.indexOf(mineG)); }; bar.appendChild(my); }
    if (canGoLive && !lives.some(function (l) { return l.mine; })) { var gl = sc('golive'); gl.appendChild(el('div', 'gi', '🔴')); gl.appendChild(el('div', 'scn', lang === 'en' ? 'Go Live' : 'ផ្សាយផ្ទាល់')); gl.onclick = function () { location.href = 'live.html?host=1'; }; bar.appendChild(gl); }
    lives.forEach(function (l) {
      var it = sc('live'); it.appendChild(avatar(l.profile_pic)); it.appendChild(el('div', 'lv', 'LIVE')); it.appendChild(el('div', 'scn', l.mine ? (lang === 'en' ? 'Your live' : 'Live របស់អ្នក') : (l.name || '')));
      it.onclick = function () { location.href = 'live.html?id=' + l.id; }; bar.appendChild(it);
    });
    groups.forEach(function (g, idx) {
      if (g.mine) return;
      var it = sc(g.allSeen ? 'seen' : ''); var cb = cardBg(g); if (cb.grad) it.style.background = cb.grad; else if (cb.img) it.style.backgroundImage = 'url("' + cb.img.replace(/"/g, '') + '")';
      it.appendChild(avatar(g.profile_pic)); it.appendChild(el('div', 'scn', g.name || '')); it.onclick = function () { openViewer(idx); }; bar.appendChild(it);
    });
  }
  function loadLives() { return api('/api/live/active').then(function (d) { if (d && d.success) { lives = d.lives || []; canGoLive = !!d.canGoLive; renderBar(); } }).catch(function () {}); }
  function load() { loadLives(); return api('/api/stories/feed').then(function (d) { if (d.success) { groups = d.groups || []; renderBar(); } }); }
  setInterval(function () { if (!document.hidden) loadLives(); }, 30000);

  /* ---------- the viewer ---------- */
  var curAudio = null, audioStart = 0, audioEnd = 0;
  function stopAudio() { if (curAudio) { try { curAudio.pause(); } catch (e) {} curAudio = null; } }
  var view = null, gi = 0, si = 0, timer = null, started = 0, dur = 5000, paused = false, pausedAt = 0, elapsedBefore = 0, curVideo = null, sheetOpen = false;
  function buildViewer() {
    if (view) return; view = el('div'); view.id = 'stView';
    document.body.appendChild(view);
  }
  function stopTimer() { if (timer) { cancelAnimationFrame(timer); timer = null; } stopAudio(); }
  function openViewer(g) { buildViewer(); gi = g; si = Math.max(0, firstUnseen(groups[g])); view.classList.add('on'); document.body.style.overflow = 'hidden'; showStory(); }
  function firstUnseen(g) { for (var i = 0; i < g.stories.length; i++) if (!g.stories[i].seen) return i; return 0; }
  function closeViewer() { stopTimer(); stopAudio(); if (curVideo) { try { curVideo.pause(); } catch (e) {} curVideo = null; } if (view) { view.classList.remove('on'); view.textContent = ''; } document.body.style.overflow = ''; renderBar(); }
  function next() { var g = groups[gi]; if (si < g.stories.length - 1) { si++; showStory(); return; } for (var k = gi + 1; k < groups.length; k++) { gi = k; si = Math.max(0, firstUnseen(groups[k])); showStory(); return; } closeViewer(); }
  function prev() { if (si > 0) { si--; showStory(); } else { for (var k = gi - 1; k >= 0; k--) { gi = k; si = groups[k].stories.length - 1; showStory(); return; } showStory(); } }
  function setBar(p) { var b = view.querySelectorAll('.st-bar i'); for (var i = 0; i < b.length; i++) b[i].style.width = i < si ? '100%' : i === si ? Math.min(100, p * 100) + '%' : '0'; }
  function tick() {
    if (paused) { timer = requestAnimationFrame(tick); return; }
    var p;
    if (curVideo && curVideo.duration && isFinite(curVideo.duration)) p = curVideo.currentTime / curVideo.duration; else p = (performance.now() - started + elapsedBefore) / dur;
    if (curAudio && curAudio.currentTime >= audioEnd) { try { curAudio.currentTime = audioStart; } catch (e) {} }
    setBar(p); if (p >= 1) { next(); return; } timer = requestAnimationFrame(tick);
  }
  function setPaused(v) {
    if (paused === v) return; paused = v;
    if (v) { pausedAt = performance.now(); if (curVideo) try { curVideo.pause(); } catch (e) {} if (curAudio) try { curAudio.pause(); } catch (e) {} }
    else { started += performance.now() - pausedAt; if (curVideo) try { curVideo.play(); } catch (e) {} if (curAudio) try { curAudio.play(); } catch (e) {} }
  }
  function showStory() {
    stopTimer(); stopAudio(); if (curVideo) { try { curVideo.pause(); } catch (e) {} curVideo = null; }
    var g = groups[gi], s = g.stories[si]; view.textContent = ''; paused = false; elapsedBefore = 0; sheetOpen = false;
    var bars = el('div', 'st-bars'); g.stories.forEach(function () { var b = el('div', 'st-bar'); b.appendChild(el('i')); bars.appendChild(b); }); view.appendChild(bars);
    var head = el('div', 'st-head'); var im = el('img'); im.src = safe(g.profile_pic) || DEFAULT_PIC; im.onerror = function () { this.onerror = null; this.src = DEFAULT_PIC; }; head.appendChild(im);
    var nm = el('div'); nm.appendChild(el('b', '', g.name)); nm.appendChild(el('small', '', ago(s.created_at) + (s.privacy === 'friends' ? ' · 👥' : ''))); head.appendChild(nm); head.appendChild(el('div', 'sp'));
    var x = el('button', 'st-x', '✕'); x.onclick = closeViewer; head.appendChild(x); view.appendChild(head);
    var stage = el('div', 'st-stage'); view.appendChild(stage);
    if (s.mediaType === 'text') { var tx = el('div', 'st-text', s.caption); tx.style.background = BG[s.bg] || BG.blue; stage.appendChild(tx); dur = 5000; started = performance.now(); }
    else if (s.mediaType === 'video' && safe(s.mediaUrl)) {
      var bv = document.createElement('video'); bv.className = 'st-bg'; bv.src = safe(s.mediaUrl); bv.muted = true; bv.loop = true; bv.playsInline = true; bv.setAttribute('playsinline', ''); bv.autoplay = true; bv.play && bv.play().catch(function () {}); stage.appendChild(bv);
      var v = document.createElement('video'); v.className = 'st-main'; v.src = safe(s.mediaUrl); v.playsInline = true; v.setAttribute('playsinline', ''); v.autoplay = true; v.preload = 'auto'; v.muted = !!(s.sound && s.sound.url); curVideo = v;
      v.onended = function () { next(); }; v.onerror = function () { curVideo = null; dur = 4000; started = performance.now(); };
      var pl = v.play(); if (pl && pl.catch) pl.catch(function () { v.muted = true; v.play().catch(function () {}); });
      stage.appendChild(v); started = performance.now();
    } else { var bgEl = el('img', 'st-bg'); bgEl.src = safe(s.mediaUrl); bgEl.alt = ''; stage.appendChild(bgEl); var imgEl = el('img', 'st-main'); imgEl.src = safe(s.mediaUrl); imgEl.draggable = false; stage.appendChild(imgEl); dur = 5000; started = performance.now(); }
    if (s.caption && s.mediaType !== 'text') { var c = el('div', 'st-cap'); c.appendChild(el('span', '', s.caption)); view.appendChild(c); }
    if (s.sound && s.sound.url) { view.appendChild(el('div', 'st-snd', '🎵 ' + s.sound.title + (s.sound.artist ? ' · ' + s.sound.artist : ''))); startSound(s.sound); }
    var l = el('div', 'st-tap l'), r = el('div', 'st-tap r'); l.onclick = prev; r.onclick = next; view.appendChild(l); view.appendChild(r);
    [l, r].forEach(function (z) { z.addEventListener('pointerdown', function () { setPaused(true); }); z.addEventListener('pointerup', function () { setPaused(false); }); z.addEventListener('pointerleave', function () { setPaused(false); }); z.addEventListener('pointercancel', function () { setPaused(false); }); });
    view.appendChild(footer(g, s));
    if (!g.mine && !s.seen) { s.seen = true; api('/api/stories/' + s.id + '/view', { method: 'POST', body: {} }); g.allSeen = g.stories.every(function (q) { return q.seen; }); }
    timer = requestAnimationFrame(tick);
  }
  function startSound(sn) {
    try {
      var a = new Audio(safe(sn.url)); a.preload = 'auto'; audioStart = sn.start || 0; audioEnd = audioStart + (sn.len || 15); curAudio = a;
      a.addEventListener('loadedmetadata', function () { try { a.currentTime = audioStart; } catch (e) {} });
      var pl = a.play(); if (pl && pl.catch) pl.catch(function () {});
    } catch (e) {}
  }
  function footer(g, s) {
    var f = el('div', 'st-foot');
    if (g.mine) {
      var row = el('div', 'st-mine'); var vb = el('button', '', '👁 ' + (s.views || 0) + ' ' + t('views') + (s.reactions ? ' · ' + s.reactions + ' ❤' : '')); vb.onclick = function () { showViewers(s); };
      var db = el('button', '', '🗑'); db.onclick = function () { setPaused(true); if (!confirm(t('del'))) { setPaused(false); return; } api('/api/stories/' + s.id, { method: 'DELETE' }).then(function () { g.stories.splice(si, 1); if (!g.stories.length) { groups.splice(gi, 1); closeViewer(); renderBar(); return; } if (si >= g.stories.length) si = g.stories.length - 1; showStory(); }); };
      row.appendChild(vb); row.appendChild(db); f.appendChild(row); return f;
    }
    var em = el('div', 'st-emo'); EMOJI.forEach(function (e) { var b = el('button', s.myReaction === e ? 'on' : '', e); b.onclick = function () { s.myReaction = e; Array.prototype.forEach.call(em.children, function (c) { c.className = c.textContent === e ? 'on' : ''; }); api('/api/stories/' + s.id + '/react', { method: 'POST', body: { emoji: e } }); }; em.appendChild(b); }); f.appendChild(em);
    var rep = el('div', 'st-rep'); var inp = el('input'); inp.type = 'text'; inp.maxLength = 500; inp.placeholder = t('reply') + (g.name || '').split(' ')[0]; var sb = el('button', '', t('send'));
    inp.addEventListener('focus', function () { setPaused(true); }); inp.addEventListener('blur', function () { if (!sheetOpen) setPaused(false); });
    function send() { var v = inp.value.trim(); if (!v) return; sb.disabled = true; api('/api/stories/' + s.id + '/reply', { method: 'POST', body: { text: v } }).then(function (d) { sb.disabled = false; if (d.success) { inp.value = ''; inp.placeholder = t('sent'); inp.blur(); } }); }
    sb.onclick = send; inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); }); rep.appendChild(inp); rep.appendChild(sb); f.appendChild(rep); return f;
  }
  function showViewers(s) {
    setPaused(true); sheetOpen = true;
    var sh = el('div', 'st-sheet'); var h = el('div'); h.style.cssText = 'display:flex;justify-content:space-between;align-items:center'; h.appendChild(el('h4', '', '👁 ' + t('views'))); var cx = el('button', 'st-x', '✕'); cx.style.color = '#050505'; cx.style.textShadow = 'none'; cx.onclick = function () { sh.remove(); sheetOpen = false; setPaused(false); }; h.appendChild(cx); sh.appendChild(h);
    var box = el('div'); sh.appendChild(box); view.appendChild(sh);
    api('/api/stories/' + s.id + '/viewers').then(function (d) {
      if (!d.success || !d.viewers.length) { box.appendChild(el('div', '', t('noViews'))); return; }
      d.viewers.forEach(function (u) { var row = el('div', 'st-v'); var im = el('img'); im.src = safe(u.profile_pic) || DEFAULT_PIC; im.onerror = function () { this.onerror = null; this.src = DEFAULT_PIC; }; row.appendChild(im); var sp = el('span'); sp.appendChild(el('b', '', u.name)); sp.appendChild(el('small', '', ago(u.viewed_at))); row.appendChild(sp); if (u.emoji) row.appendChild(el('span', '', u.emoji)); row.lastChild.style.flex = '0'; row.lastChild.style.fontSize = '22px'; box.appendChild(row); });
    });
  }
  document.addEventListener('visibilitychange', function () { if (view && view.classList.contains('on')) setPaused(document.hidden || sheetOpen); });
  document.addEventListener('keydown', function (e) { if (!view || !view.classList.contains('on')) return; if (e.key === 'Escape') closeViewer(); else if (e.key === 'ArrowRight') next(); else if (e.key === 'ArrowLeft') prev(); });
  (function swipe() { var y0 = null; document.addEventListener('touchstart', function (e) { if (view && view.classList.contains('on') && !e.target.closest('.st-sheet,.st-foot')) y0 = e.touches[0].clientY; else y0 = null; }, { passive: true }); document.addEventListener('touchend', function (e) { if (y0 !== null && e.changedTouches[0].clientY - y0 > 110) closeViewer(); y0 = null; }, { passive: true }); })();

  /* ---------- music picker: search, saved sounds, choose which part to play ---------- */
  var L2 = function (km, en) { return lang === 'en' ? en : km; };
  var pick = null, pvAudio = null;
  function stopPv() { if (pvAudio) { try { pvAudio.pause(); } catch (e) {} pvAudio = null; } }
  function fmtT(n) { n = Math.max(0, Math.round(n)); return Math.floor(n / 60) + ':' + ('0' + (n % 60)).slice(-2); }
  function openSoundPicker(done) {
    if (!pick) { pick = el('div'); pick.id = 'sndPick'; document.body.appendChild(pick); }
    pick.textContent = ''; pick.classList.add('on'); var tab = 'all', q = '', timer2 = null;
    function close() { stopPv(); pick.classList.remove('on'); pick.textContent = ''; }
    var top = el('div', 'sp-top'), back = el('button', '', '←'), inp = el('input'); inp.type = 'search'; inp.placeholder = L2('ស្វែងរកបទចម្រៀង ឬសិល្បករ', 'Search songs or artists'); top.appendChild(back); top.appendChild(inp); pick.appendChild(top);
    var tabs = el('div', 'sp-tabs'), tAll = el('button', 'on', L2('សម្រាប់អ្នក', 'For you')), tSv = el('button', '', '🔖 ' + L2('បានរក្សាទុក', 'Saved')); tabs.appendChild(tAll); tabs.appendChild(tSv); pick.appendChild(tabs);
    var list = el('div', 'sp-list'); pick.appendChild(list);
    back.onclick = close;
    function setTab(x) { tab = x; tAll.className = x === 'all' ? 'on' : ''; tSv.className = x === 'saved' ? 'on' : ''; stopPv(); loadList(); }
    tAll.onclick = function () { setTab('all'); }; tSv.onclick = function () { setTab('saved'); };
    inp.addEventListener('input', function () { clearTimeout(timer2); timer2 = setTimeout(function () { q = inp.value.trim(); loadList(); }, 300); });
    function loadList() {
      list.textContent = ''; list.appendChild(el('div', 'sp-empty', '…'));
      api('/api/sounds?tab=' + tab + '&q=' + encodeURIComponent(q)).then(function (d) {
        list.textContent = ''; var arr = (d && d.sounds) || [];
        if (!arr.length) { list.appendChild(el('div', 'sp-empty', tab === 'saved' ? L2('មិនទាន់មានសំឡេងដែលបានរក្សាទុកទេ។ ចុច 🔖 នៅក្បែរបទណាមួយ។', 'No saved sounds yet. Tap 🔖 next to a song.') : L2('រកមិនឃើញសំឡេងទេ', 'No sounds found'))); return; }
        arr.forEach(function (sn) {
          var row = el('div', 'sp-row'), cov = sn.cover && safe(sn.cover) ? el('img', 'sp-cov') : el('div', 'sp-cov', '🎵'); if (cov.tagName === 'IMG') cov.src = safe(sn.cover);
          var inf = el('div', 'sp-inf'); inf.appendChild(el('b', '', sn.title)); inf.appendChild(el('small', '', (sn.artist ? sn.artist + ' · ' : '') + fmtT(sn.duration)));
          var pl = el('button', '', '▶'), sv = el('button', '', sn.saved ? '🔖' : '🏷️'); sv.title = L2('រក្សាទុក', 'Save'); if (!sn.saved) sv.style.opacity = '.45';
          pl.onclick = function (e) { e.stopPropagation(); if (pvAudio && pvAudio._id === sn.id) { stopPv(); list.querySelectorAll('.sp-row button:nth-of-type(1)').forEach(function (b) { b.textContent = '▶'; }); return; } stopPv(); list.querySelectorAll('.sp-row button:nth-of-type(1)').forEach(function (b) { b.textContent = '▶'; }); pvAudio = new Audio(safe(sn.url)); pvAudio._id = sn.id; pvAudio.play().catch(function () {}); pl.textContent = '⏸'; pvAudio.onended = function () { pl.textContent = '▶'; }; };
          sv.onclick = function (e) { e.stopPropagation(); api('/api/sounds/' + sn.id + '/save', { method: 'POST', body: {} }).then(function (x) { if (x && x.success) { sn.saved = x.saved; sv.textContent = x.saved ? '🔖' : '🏷️'; sv.style.opacity = x.saved ? '1' : '.45'; if (tab === 'saved' && !x.saved) row.remove(); } else if (x && x.error) alert(x.error); }); };
          row.onclick = function () { stopPv(); trim(sn); };
          row.appendChild(cov); row.appendChild(inf); row.appendChild(pl); row.appendChild(sv); list.appendChild(row);
        });
      });
    }
    function trim(sn) {
      var len = Math.min(15, sn.duration), start = 0, box = el('div', 'sp-trim'); pick.appendChild(box);
      box.appendChild(el('b', '', sn.title)); if (sn.artist) box.appendChild(el('div', '', sn.artist)).style.cssText = 'color:#65676b;font-size:13px';
      var bars = el('div', 'sp-bars'), N = 44, seed = sn.id * 9301 + 49297, hs = []; for (var i = 0; i < N; i++) { seed = (seed * 9301 + 49297) % 233280; hs.push(18 + Math.round(seed / 233280 * 82)); var b = el('i'); b.style.height = hs[i] + '%'; bars.appendChild(b); } box.appendChild(bars);
      var rg = el('input'); rg.type = 'range'; rg.min = 0; rg.step = 1; box.appendChild(rg);
      var info = el('div', ''); info.style.cssText = 'font-size:13px;color:#65676b;margin-top:2px;text-align:center'; box.appendChild(info);
      var lens = el('div', 'sp-lens'); [15, 30].forEach(function (n) { if (n > sn.duration && n !== 15) return; var bt = el('button', n === len ? 'on' : '', n + 's'); bt.onclick = function () { len = Math.min(n, sn.duration); Array.prototype.forEach.call(lens.children, function (c) { c.className = c === bt ? 'on' : ''; }); paint(); }; lens.appendChild(bt); }); box.appendChild(lens);
      function paint() { rg.max = Math.max(0, sn.duration - len); if (start > +rg.max) start = +rg.max; rg.value = start; info.textContent = fmtT(start) + ' – ' + fmtT(start + len); var on0 = Math.floor(start / sn.duration * N), on1 = Math.ceil((start + len) / sn.duration * N); Array.prototype.forEach.call(bars.children, function (b, i) { b.className = i >= on0 && i < on1 ? 'on' : ''; }); }
      var pa = null; function stopPa() { if (pa) { try { pa.pause(); } catch (e) {} pa = null; } }
      function play() { stopPa(); pa = new Audio(safe(sn.url)); pa.addEventListener('loadedmetadata', function () { try { pa.currentTime = start; } catch (e) {} }); pa.ontimeupdate = function () { if (pa && pa.currentTime >= start + len) { try { pa.currentTime = start; } catch (e) {} } }; pa.play().catch(function () {}); }
      rg.oninput = function () { start = +rg.value; paint(); }; rg.onchange = play;
      var row = el('div', 'row'), cn = el('button', '', L2('បោះបង់', 'Cancel')), ok = el('button', 'p', L2('រួចរាល់', 'Done')); row.appendChild(cn); row.appendChild(ok); box.appendChild(row);
      cn.onclick = function () { stopPa(); box.remove(); }; ok.onclick = function () { stopPa(); close(); done({ id: sn.id, title: sn.title, artist: sn.artist, url: sn.url, start: start, len: len }); };
      paint(); play();
    }
    loadList(); setTimeout(function () { try { inp.focus(); } catch (e) {} }, 100);
  }

  /* ---------- the maker ---------- */
  var mk = null;
  function openMaker() {
    if (!mk) { mk = el('div'); mk.id = 'stMake'; document.body.appendChild(mk); mk.addEventListener('click', function (e) { if (e.target === mk) closeMaker(); }); }
    mk.textContent = ''; mk.classList.add('on');
    var st = { mode: 'media', file: null, bg: 'blue', objUrl: '' };
    var box = el('div', 'stm-box'); mk.appendChild(box);
    var tabs = el('div', 'stm-tabs'); var tm = el('button', 'on', t('photo')), tt = el('button', '', t('textcard')); tabs.appendChild(tm); tabs.appendChild(tt); box.appendChild(tabs);
    var prev = el('div', 'stm-prev'); box.appendChild(prev);
    var file = el('input'); file.type = 'file'; file.accept = 'image/*,video/*'; file.style.display = 'none'; box.appendChild(file);
    var bgs = el('div', 'stm-bgs'); Object.keys(BG).forEach(function (k) { var i = el('i'); i.style.background = BG[k]; if (k === st.bg) i.className = 'on'; i.onclick = function () { st.bg = k; Array.prototype.forEach.call(bgs.children, function (c) { c.className = ''; }); i.className = 'on'; paintPrev(); }; bgs.appendChild(i); });
    var cap = el('input', 'stm-in'); cap.maxLength = 200; cap.placeholder = t('cap'); box.appendChild(cap);
    var sndRow = el('div', 'stm-snd'); function paintSnd() { sndRow.textContent = ''; if (st.sound) { sndRow.appendChild(el('span', '', '🎵')); sndRow.appendChild(el('b', '', st.sound.title + (st.sound.artist ? ' · ' + st.sound.artist : ''))); var xx = el('span', 'x', '✕'); xx.onclick = function (e) { e.stopPropagation(); st.sound = null; paintSnd(); }; sndRow.appendChild(xx); } else { sndRow.appendChild(el('span', '', '🎵')); sndRow.appendChild(el('b', '', L2('បន្ថែមសំឡេង (Music)', 'Add music'))); sndRow.appendChild(el('span', 'x', '›')); } }
    sndRow.onclick = function () { openSoundPicker(function (sn) { st.sound = sn; paintSnd(); }); }; paintSnd(); box.appendChild(sndRow);
    var pr = el('select'); [['public', t('pub')], ['friends', t('fr')]].forEach(function (o) { var op = el('option', '', o[1]); op.value = o[0]; pr.appendChild(op); }); box.appendChild(pr);
    var msg = el('div', 'stm-msg'); box.appendChild(msg);
    var row = el('div', 'stm-row'); var cancel = el('button', '', t('cancel')), share = el('button', 'p', t('share')); row.appendChild(cancel); row.appendChild(share); box.appendChild(row);
    var ta = null;
    function paintPrev() {
      prev.textContent = ''; prev.style.background = '#e4e6eb';
      if (st.mode === 'text') { prev.style.background = BG[st.bg]; ta = el('textarea'); ta.maxLength = 200; ta.placeholder = t('textPh'); prev.appendChild(ta); cap.style.display = 'none'; }
      else { cap.style.display = ''; if (st.file) { if (st.objUrl) URL.revokeObjectURL(st.objUrl); st.objUrl = URL.createObjectURL(st.file); var m = st.file.type.indexOf('video') === 0 ? el('video') : el('img'); m.src = st.objUrl; if (m.tagName === 'VIDEO') { m.muted = true; m.controls = true; m.playsInline = true; } prev.appendChild(m); } else prev.appendChild(el('div', '', '📷 ' + t('pick'))); }
    }
    function setMode(m) { st.mode = m; tm.className = m === 'media' ? 'on' : ''; tt.className = m === 'text' ? 'on' : ''; if (m === 'text') { box.insertBefore(bgs, cap); } else if (bgs.parentNode) bgs.remove(); paintPrev(); }
    tm.onclick = function () { setMode('media'); }; tt.onclick = function () { setMode('text'); };
    prev.onclick = function (e) { if (st.mode === 'media' && e.target.tagName !== 'VIDEO') file.click(); };
    file.onchange = function () {
      msg.textContent = ''; var f = file.files[0]; if (!f) return;
      if (f.type.indexOf('video') === 0) { var tmp = document.createElement('video'); tmp.preload = 'metadata'; tmp.onloadedmetadata = function () { URL.revokeObjectURL(tmp.src); if (tmp.duration > 30.5) { msg.textContent = t('long'); file.value = ''; st.file = null; paintPrev(); } else { st.file = f; paintPrev(); } }; tmp.onerror = function () { st.file = f; paintPrev(); }; tmp.src = URL.createObjectURL(f); }
      else { st.file = f; paintPrev(); }
    };
    cancel.onclick = closeMaker;
    share.onclick = async function () {
      msg.textContent = '';
      var body = { privacy: pr.value }; if (st.sound) { body.soundId = st.sound.id; body.soundStart = st.sound.start; body.soundLen = st.sound.len; }
      if (st.mode === 'text') { body.mediaType = 'text'; body.caption = (ta && ta.value || '').trim(); body.bg = st.bg; if (!body.caption) { msg.textContent = t('textPh'); return; } }
      else {
        if (!st.file) { msg.textContent = t('bad'); return; }
        share.disabled = true; cancel.disabled = true; share.textContent = t('uploading');
        try { var fd = new FormData(); fd.append('user_email', user.email); fd.append('file', st.file); var up = await fetch('/api/videos/upload-direct', { method: 'POST', body: fd }); var ud = await up.json(); if (!up.ok || !ud.publicUrl) throw new Error(ud.error || 'upload'); body.mediaType = ud.type === 'video' ? 'video' : 'image'; body.mediaUrl = ud.publicUrl; body.caption = cap.value.trim(); }
        catch (e) { share.disabled = false; cancel.disabled = false; share.textContent = t('share'); msg.textContent = t('fail'); return; }
      }
      var d = await api('/api/stories', { method: 'POST', body: body });
      share.disabled = false; cancel.disabled = false; share.textContent = t('share');
      if (d.success) { closeMaker(); await load(); } else msg.textContent = d.error || t('fail');
    };
    paintPrev();
  }
  function closeMaker() { if (mk) { mk.classList.remove('on'); mk.textContent = ''; } }

  function init() {
    var anchor = document.getElementById('postsContainer'); if (!anchor || document.getElementById('storyBar')) return;
    bar = el('div'); bar.id = 'storyBar'; anchor.parentNode.insertBefore(bar, anchor); renderBar(); load();
    setInterval(function () { if (!document.hidden && !(view && view.classList.contains('on'))) load(); }, 120000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.CamFeedStories = { open: openMaker, reload: load };
})();
