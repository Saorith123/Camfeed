/* CamFeed Stories: a picture, a short video or a text card that disappears after 24 hours.
   Shows a row of circles above the feed, a full-screen viewer, and a small maker. Needs: window user in localStorage (camfeed_user). */
(function () {
  'use strict';
  var user = null; try { user = JSON.parse(localStorage.getItem('camfeed_user')); } catch (e) {}
  if (!user || !user.email) return;
  var lang = localStorage.getItem('camfeed_lang') === 'en' ? 'en' : 'km';
  var TX = {
    km: { your: 'រឿងរបស់អ្នក', create: 'បង្កើត Story', photo: '📷 រូប ឬវីដេអូ', textcard: '✍️ អត្ថបទ', pick: 'ជ្រើសរូប ឬវីដេអូ', cap: 'សរសេរអត្ថបទលើរូប (មិនបង្ខំ)', textPh: 'សរសេរអ្វីមួយ…', pub: '🌐 សាធារណៈ', fr: '👥 មិត្តភក្តិ (តាមដានគ្នា)', share: 'ចែករំលែក', cancel: 'បោះបង់', uploading: 'កំពុងបង្ហោះ…', long: 'វីដេអូវែងពេក។ Story វីដេអូត្រូវតែមិនលើស 30 វិនាទី។', bad: 'សូមជ្រើសរូប ឬវីដេអូ។', fail: 'មិនអាចបង្ហោះបាន សូមព្យាយាមម្តងទៀត។', reply: 'ឆ្លើយតបទៅ…', send: 'ផ្ញើ', sent: 'បានផ្ញើហើយ ✓', views: 'អ្នកមើល', noViews: 'មិនទាន់មានអ្នកមើលទេ', del: 'លុប Story នេះមែនទេ?', close: 'បិទ', ago: '' },
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
.st-stage .st-main{position:relative;z-index:1;width:100%;height:100%;object-fit:contain}\
.ov-layer{position:absolute;pointer-events:none;z-index:2}\
.ov-i{position:absolute;text-align:center;user-select:none;-webkit-user-select:none}\
.ov-emoji{line-height:1;white-space:nowrap}\
.ov-text{font-weight:800;line-height:1.2;padding:.12em .4em;border-radius:.3em;width:max-content;max-width:calc(var(--ovw,300px)*.9);white-space:pre-wrap;word-break:break-word}\
.ov-image img{width:100%;display:block;pointer-events:none;border-radius:6px}\
.ov-live{pointer-events:auto;touch-action:none;cursor:grab}\
.ov-live.sel{outline:2px dashed #fff;outline-offset:3px;box-shadow:0 0 0 1px rgba(0,0,0,.45)}\
.stm-tools,.stm-selbar{display:flex;gap:6px;margin-bottom:8px}\
.stm-tools button,.stm-selbar button{flex:1;border:0;border-radius:10px;padding:8px 4px;background:#e4e6eb;color:#050505;font-weight:700;font-size:13px;cursor:pointer}\
.stm-selbar{display:none}.stm-selbar.on{display:flex}.stm-selbar button.d{background:#fde8e8}\
.stm-epan{display:grid;grid-template-columns:repeat(8,1fr);gap:2px;max-height:132px;overflow:auto;background:#f0f2f5;border-radius:10px;padding:6px;margin-bottom:8px}.stm-epan span{font-size:24px;text-align:center;cursor:pointer;padding:2px}\
.stm-ted{background:#f0f2f5;border-radius:10px;padding:8px;margin-bottom:8px}.stm-ted small{display:block;color:#65676b;font-size:12px;margin:4px 0 0}.stm-ted .sw{width:26px;height:26px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px #bbb;cursor:pointer;display:inline-block;margin:3px;vertical-align:middle;font-size:12px;text-align:center;line-height:22px;color:#e53935;font-weight:800}.stm-ted .sw.on{box-shadow:0 0 0 3px #1877f2}.stm-ted .ok{margin-top:6px;width:100%;border:0;border-radius:8px;padding:8px;background:#1877f2;color:#fff;font-weight:700;cursor:pointer}\
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
  function closeViewer() { if (stAdTimer) { clearInterval(stAdTimer); stAdTimer = null; } stopTimer(); stopAudio(); if (curVideo) { try { curVideo.pause(); } catch (e) {} curVideo = null; } if (view) { view.classList.remove('on'); view.textContent = ''; } document.body.style.overflow = ''; renderBar(); }
  function next() { var g = groups[gi]; if (si < g.stories.length - 1) { si++; showStory(); return; } for (var k = gi + 1; k < groups.length; k++) { var kk = k; storyAdThen(function () { gi = kk; si = Math.max(0, firstUnseen(groups[kk])); showStory(); }); return; } closeViewer(); }

  /* ---------- 📖 an ad between people's stories (every 3rd person), only where the advertiser ☑️ chose "Story" ---------- */
  var stAds = [], stAdN = 0, stAdK = 0, stAdTimer = null;
  function loadStoryAds() {
    api('/api/sponsored-ads').then(function (d) {
      if (d && d.success && Array.isArray(d.ads)) stAds = d.ads.filter(function (a) { return Array.isArray(a.places) && a.places.indexOf('story') >= 0 && a.media_url; });
    });
  }
  loadStoryAds(); setInterval(function () { if (!document.hidden) loadStoryAds(); }, 180000);
  function adEv(id, type) { api('/api/sponsored-ads/' + encodeURIComponent(id) + '/event', { method: 'POST', body: { type: type } }); }
  function storyAdThen(go) {
    if (!stAds.length || ++stAdN < 3) { go(); return; }
    stAdN = 0;
    var ad = stAds[stAdK++ % stAds.length];
    stopTimer(); if (curVideo) { try { curVideo.pause(); } catch (e) {} curVideo = null; }
    view.textContent = '';
    api('/api/sponsored-ads/' + encodeURIComponent(ad.id) + '/impression', { method: 'POST', body: { placement: 'story' } });
    var done = false;
    function finish(how) { if (done) return; done = true; clearInterval(stAdTimer); stAdTimer = null; adEv(ad.id, how === 'done' ? 'complete' : 'skip'); var v = view.querySelector('video'); if (v) try { v.pause(); } catch (e) {} if (how === 'close') closeViewer(); else go(); }
    var stage = el('div', 'st-stage'); stage.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#000';
    var isVid = /\.(mp4|webm|mov|m4v)(\?|$)/i.test(ad.media_url || '');
    var m;
    if (isVid) { m = document.createElement('video'); m.src = safe(ad.media_url); m.playsInline = true; m.setAttribute('playsinline', ''); m.autoplay = true; m.onended = function () { finish('done'); }; m.onerror = function () { finish('done'); }; var pl = m.play(); if (pl && pl.catch) pl.catch(function () { m.muted = true; m.play().catch(function () {}); }); }
    else { m = el('img'); m.src = safe(ad.media_url); m.alt = ''; }
    m.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain';
    stage.appendChild(m); view.appendChild(stage);
    var head = el('div', 'st-head'); var im = el('img'); im.src = safe(ad.advertiser_pic) || DEFAULT_PIC; im.onerror = function () { this.onerror = null; this.src = DEFAULT_PIC; }; head.appendChild(im);
    var nm = el('div'); nm.appendChild(el('b', '', ad.advertiser_name || '')); var spn = el('small', '', lang === 'en' ? 'Sponsored' : 'ផ្សាយពាណិជ្ជកម្ម'); spn.style.cssText = 'color:#4ade80;font-weight:700'; nm.appendChild(spn); head.appendChild(nm); head.appendChild(el('div', 'sp'));
    var x = el('button', 'st-x', '×'); x.onclick = function () { finish('close'); }; head.appendChild(x); view.appendChild(head);
    var foot = el('div', 'st-foot');
    if (ad.caption) { var c = el('div', '', ad.caption); c.style.cssText = 'margin-bottom:10px;white-space:pre-wrap;max-height:5.5em;overflow:hidden'; foot.appendChild(c); }
    var row = el('div'); row.style.cssText = 'display:flex;gap:10px';
    var hasLink = ad.cta !== 'none' && ((window.cfAdTargetOk ? window.cfAdTargetOk(ad.target_url || '') : /^https?:\/\//i.test(ad.target_url || '')) || (ad.cta === 'message' && ad.owner_email));
    if (hasLink) {
      var b = el('button', '', ad.cta === 'message' ? (lang === 'en' ? '💬 Message' : '💬 ផ្ញើសារ') : (window.cfCtaLabel ? window.cfCtaLabel(ad.cta) : (lang === 'en' ? 'See more' : 'មើលបន្ថែម')));
      b.style.cssText = 'flex:1;border:0;border-radius:10px;padding:12px;font-size:15px;font-weight:700;background:#1877f2;color:#fff;cursor:pointer';
      b.onclick = function () {
        if (ad.cta === 'message' && ad.owner_email) { adEv(ad.id, 'message'); location.href = 'messages.html?chat=' + encodeURIComponent(ad.owner_email); return; }
        adEv(ad.id, 'click'); if (window.cfAdOpen) window.cfAdOpen(ad.target_url); else window.open(ad.target_url, '_blank', 'noopener,noreferrer');
      };
      row.appendChild(b);
    }
    var sk = el('button'); sk.style.cssText = 'border:0;border-radius:10px;padding:12px 16px;font-size:15px;background:rgba(255,255,255,.2);color:#fff;cursor:pointer';
    var left = Math.min(Math.max(parseInt(ad.skip_seconds, 10) || 5, 3), 15), shown = 0;
    function label() { sk.disabled = left > 0; sk.textContent = left > 0 ? (lang === 'en' ? 'Skip in ' + left + ' s' : 'រំលងក្នុង ' + left + ' វិ') : (lang === 'en' ? 'Skip ▶' : 'រំលង ▶'); }
    label(); sk.onclick = function () { if (left <= 0) finish('skip'); };
    row.appendChild(sk); foot.appendChild(row); view.appendChild(foot);
    stAdTimer = setInterval(function () { shown++; if (left > 0) { left--; label(); } if (!isVid && shown >= 10) finish('done'); }, 1000);
  }
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
  function ovStyle(d, o) {
    d.style.left = (o.x * 100) + '%'; d.style.top = (o.y * 100) + '%'; d.style.transform = 'translate(-50%,-50%) rotate(' + (o.r || 0) + 'deg)';
    var k = 'calc(var(--ovw,300px)*' + o.s + ')'; if (o.type === 'image') d.style.width = k; else d.style.fontSize = k;
  }
  function ovNode(o) {
    var d = el('div', 'ov-i ov-' + o.type);
    if (o.type === 'emoji') d.textContent = o.e;
    else if (o.type === 'text') { d.textContent = o.t; d.style.color = o.c || '#fff'; if (o.bg) d.style.background = o.bg; }
    else if (o.type === 'mention') {          // @ a friend (made in the app): tap = their profile
      d.className = 'ov-i ov-text'; d.textContent = '@' + (o.n || ''); d.style.color = '#fff'; d.style.background = 'rgba(0,0,0,.5)'; d.style.pointerEvents = 'auto'; d.style.cursor = 'pointer';
      d.addEventListener('click', function (e) { e.stopPropagation(); if (o.user_email) location.href = 'profile.html?email=' + encodeURIComponent(o.user_email); });
    }
    else { var im = el('img'); im.src = o.url || safe(o.u); im.alt = ''; im.draggable = false; d.appendChild(im); }
    ovStyle(d, o); return d;
  }
  function fitOv(box, media, layer) {
    function go() {
      var nw = media.naturalWidth || media.videoWidth, nh = media.naturalHeight || media.videoHeight, cw = box.clientWidth, ch = box.clientHeight;
      if (!nw || !nh || !cw || !ch) return;
      var sc = Math.min(cw / nw, ch / nh), w = nw * sc, h = nh * sc;
      layer.style.left = (cw - w) / 2 + 'px'; layer.style.top = (ch - h) / 2 + 'px'; layer.style.width = w + 'px'; layer.style.height = h + 'px'; layer.style.setProperty('--ovw', w + 'px');
    }
    media.addEventListener('load', go); media.addEventListener('loadedmetadata', go); go();
    if (window.ResizeObserver) new ResizeObserver(go).observe(box); else window.addEventListener('resize', go);
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
    if (s.overlays && s.overlays.length && s.mediaType !== 'text') { var mainEl = stage.querySelector('.st-main'), ly = el('div', 'ov-layer'); s.overlays.forEach(function (o) { ly.appendChild(ovNode(o)); }); stage.appendChild(ly); if (mainEl) fitOv(stage, mainEl, ly); }
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
  // same small, fast format as normal posts: photos <= 1080 wide, videos re-encoded to 720p; then sent straight to R2 (no server memory/time limit)
  async function prepareStoryFile(f, onPct) {
    try {
      if (f.type.indexOf('video') === 0 || /\.(mp4|mov|m4v|webm)$/i.test(f.name || '')) {
        var c = window.smartCompressVideoFile ? await window.smartCompressVideoFile(f, onPct) : f;
        return (window.CamFaststart && c) ? await window.CamFaststart.ensureFastStart(c).catch(function () { return c; }) : c;
      }
      return window.smartCompressImageFile ? await window.smartCompressImageFile(f) : f;
    } catch (e) { return f; }
  }
  function putStoryFile(file, onPct) {
    return new Promise(async function (resolve, reject) {
      var isVid = (file.type || '').indexOf('video') === 0 || /\.(mp4|mov|m4v|webm)$/i.test(file.name || '');
      try {
        var ur = await fetch('/api/videos/upload-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_email: user.email, file_name: file.name || (isVid ? 'story.mp4' : 'story.jpg'), content_type: file.type || (isVid ? 'video/mp4' : 'image/jpeg') }) });
        var ud = await ur.json();
        if (ur.ok && ud.uploadUrl) {
          var x = new XMLHttpRequest(); x.open('PUT', ud.uploadUrl, true); x.setRequestHeader('Content-Type', file.type || (isVid ? 'video/mp4' : 'image/jpeg'));
          x.upload.onprogress = function (e) { if (e.lengthComputable && onPct) onPct(e.loaded / e.total * 100); };
          x.onload = function () { if (x.status >= 200 && x.status < 300) resolve({ url: ud.publicUrl, type: isVid ? 'video' : 'image' }); else direct(); };
          x.onerror = direct; x.send(file); return;
        }
      } catch (e) {}
      direct();
      function direct() {
        var fd = new FormData(); fd.append('user_email', user.email); fd.append('file', file);
        fetch('/api/videos/upload-direct', { method: 'POST', body: fd }).then(function (r) { return r.json().then(function (d) { if (!r.ok || !d.publicUrl) throw new Error(d.error || 'upload'); resolve({ url: d.publicUrl, type: d.type === 'video' ? 'video' : 'image' }); }); }).catch(reject);
      }
    });
  }
  function openMaker() {
    if (!mk) { mk = el('div'); mk.id = 'stMake'; document.body.appendChild(mk); mk.addEventListener('click', function (e) { if (e.target === mk) closeMaker(); }); }
    mk.textContent = ''; mk.classList.add('on'); try { window.CamPause && window.CamPause.hold('story'); } catch (e) {}
    var st = { mode: 'media', file: null, bg: 'blue', objUrl: '', ov: [], sel: null };
    var box = el('div', 'stm-box'); mk.appendChild(box);
    var tabs = el('div', 'stm-tabs'); var tm = el('button', 'on', t('photo')), tt = el('button', '', t('textcard')); tabs.appendChild(tm); tabs.appendChild(tt); box.appendChild(tabs);
    var prev = el('div', 'stm-prev'); box.appendChild(prev);
    var file = el('input'); file.type = 'file'; file.accept = 'image/*,video/*'; file.style.display = 'none'; box.appendChild(file);
    var layer = null;
    var tools = el('div', 'stm-tools'); box.appendChild(tools); tools.style.display = 'none';
    var bEmo = el('button', '', '😀 ' + L2('អីម៉ូជី', 'Emoji')), bImg = el('button', '', '🖼️ ' + L2('រូប', 'Image')), bTxt = el('button', '', 'Aa ' + L2('អត្ថបទ', 'Text')), bChg = el('button', '', '🔄');
    [bEmo, bImg, bTxt, bChg].forEach(function (b) { tools.appendChild(b); });
    var selbar = el('div', 'stm-selbar'); box.appendChild(selbar);
    var ovPanel = el('div'); box.appendChild(ovPanel);
    var ifile = el('input'); ifile.type = 'file'; ifile.accept = 'image/*'; ifile.style.display = 'none'; box.appendChild(ifile);
    var EMO = '😀😂🥰😍😎🤩😢😡👍👏🙏💪🔥❤️💕💯🎉🎂🎁🌸🌴☀️🌙⭐✨🏆⚽🍜🍕☕🚗✈️🏝️🇰🇭🛕🐘🐶🐱🦋🌈📍🎵💬✅❌⚠️🆕'.match(/\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*|\p{Regional_Indicator}{2}/gu) || [];
    var TC = ['#ffffff', '#000000', '#ffeb3b', '#e53935', '#1e88e5', '#43a047', '#ff9800', '#e91e63'], BC = ['', '#000000', '#ffffff', '#ffeb3b', '#e53935', '#1e88e5', '#43a047'];
    function clamp(v, a, b) { return Math.min(Math.max(v, a), b); }
    function drawOv() {
      if (!layer) return; layer.textContent = '';
      st.ov.forEach(function (o) { var n = ovNode(o); n.classList.add('ov-live'); if (o === st.sel) n.classList.add('sel'); wire(n, o); o._n = n; layer.appendChild(n); });
      paintSel();
    }
    function select(o) { st.sel = o; st.ov.forEach(function (q) { if (q._n) q._n.classList.toggle('sel', q === o); }); paintSel(); }
    function paintSel() {
      selbar.textContent = ''; selbar.classList.toggle('on', !!st.sel); var o = st.sel; if (!o) return;
      function b(txt, cls, fn) { var x = el('button', cls || '', txt); x.onclick = fn; selbar.appendChild(x); }
      function upd() { if (o._n) ovStyle(o._n, o); }
      b('−', '', function () { o.s = clamp(o.s * 0.88, 0.03, 1.2); upd(); }); b('+', '', function () { o.s = clamp(o.s * 1.14, 0.03, 1.2); upd(); });
      b('⟳', '', function () { o.r = ((o.r || 0) + 15) % 360; upd(); });
      if (o.type === 'text') b('✏️', '', function () { openText(o); });
      b('🗑', 'd', function () { st.ov = st.ov.filter(function (q) { return q !== o; }); st.sel = null; ovPanel.textContent = ''; drawOv(); });
    }
    function wire(n, o) {
      var pts = {}, g = {};
      function base() { var ids = Object.keys(pts); if (!ids.length) return; g = { ox: o.x, oy: o.y, os: o.s, or: o.r || 0 }; var a = pts[ids[0]]; if (ids.length >= 2) { var c = pts[ids[1]]; g.d = Math.hypot(a.x - c.x, a.y - c.y) || 1; g.a = Math.atan2(c.y - a.y, c.x - a.x); g.cx = (a.x + c.x) / 2; g.cy = (a.y + c.y) / 2; } else { g.cx = a.x; g.cy = a.y; } }
      n.addEventListener('pointerdown', function (e) { e.stopPropagation(); e.preventDefault(); if (st.sel !== o) select(o); try { n.setPointerCapture(e.pointerId); } catch (x) {} pts[e.pointerId] = { x: e.clientX, y: e.clientY }; base(); });
      n.addEventListener('pointermove', function (e) {
        if (!pts[e.pointerId]) return; pts[e.pointerId] = { x: e.clientX, y: e.clientY }; var ids = Object.keys(pts), R = layer.getBoundingClientRect(); if (!R.width) return;
        if (ids.length >= 2) { var a = pts[ids[0]], c = pts[ids[1]], mx = (a.x + c.x) / 2, my = (a.y + c.y) / 2; o.s = clamp(g.os * Math.hypot(a.x - c.x, a.y - c.y) / g.d, 0.03, 1.2); o.r = g.or + (Math.atan2(c.y - a.y, c.x - a.x) - g.a) * 180 / Math.PI; o.x = clamp(g.ox + (mx - g.cx) / R.width, 0, 1); o.y = clamp(g.oy + (my - g.cy) / R.height, 0, 1); }
        else { var p = pts[ids[0]]; o.x = clamp(g.ox + (p.x - g.cx) / R.width, 0, 1); o.y = clamp(g.oy + (p.y - g.cy) / R.height, 0, 1); }
        ovStyle(n, o);
      });
      function up(e) { delete pts[e.pointerId]; base(); }
      n.addEventListener('pointerup', up); n.addEventListener('pointercancel', up);
      n.addEventListener('click', function (e) { e.stopPropagation(); });
      n.addEventListener('wheel', function (e) { e.preventDefault(); o.s = clamp(o.s * (e.deltaY < 0 ? 1.08 : 0.92), 0.03, 1.2); ovStyle(n, o); }, { passive: false });
    }
    function addOv(o) { if (st.ov.length >= 20) { msg.textContent = L2('ច្រើនពេកហើយ (អតិបរមា ២០)', 'Too many (max 20)'); return null; } msg.textContent = ''; Object.assign(o, { x: 0.5, y: 0.5, r: 0 }); st.ov.push(o); drawOv(); select(o); return o; }
    bEmo.onclick = function () {
      if (ovPanel.firstChild && ovPanel.firstChild.className === 'stm-epan') { ovPanel.textContent = ''; return; }
      ovPanel.textContent = ''; var g = el('div', 'stm-epan'); EMO.forEach(function (em) { var sp = el('span', '', em); sp.onclick = function () { addOv({ type: 'emoji', e: em, s: 0.18 }); ovPanel.textContent = ''; }; g.appendChild(sp); }); ovPanel.appendChild(g);
    };
    bImg.onclick = function () { ifile.value = ''; ifile.click(); };
    ifile.onchange = function () {
      var f = ifile.files[0]; if (!f || f.type.indexOf('image') !== 0) return; var u = URL.createObjectURL(f), im = new Image();
      im.onload = function () {
        var sc = Math.min(1, 800 / Math.max(im.naturalWidth, im.naturalHeight)), cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(im.naturalWidth * sc)); cv.height = Math.max(1, Math.round(im.naturalHeight * sc)); cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height); URL.revokeObjectURL(u);
        var png = /png|webp|gif/.test(f.type); cv.toBlob(function (bl) { if (!bl) { msg.textContent = t('fail'); return; } addOv({ type: 'image', blob: bl, url: URL.createObjectURL(bl), s: 0.4 }); }, png ? 'image/png' : 'image/jpeg', 0.88);
      };
      im.onerror = function () { URL.revokeObjectURL(u); msg.textContent = t('bad'); }; im.src = u;
    };
    function openText(o) {
      ovPanel.textContent = ''; var w = el('div', 'stm-ted'); ovPanel.appendChild(w);
      var inp = el('input', 'stm-in'); inp.maxLength = 120; inp.placeholder = L2('សរសេរអត្ថបទ...', 'Type text...'); inp.value = o.t || ''; w.appendChild(inp);
      function refresh() { if (o._n) { var nn = ovNode(o); nn.className = o._n.className; wire(nn, o); o._n.replaceWith(nn); o._n = nn; } }
      inp.oninput = function () { o.t = inp.value; refresh(); };
      function row(label, list, key) {
        w.appendChild(el('small', '', label)); var rw = el('div');
        list.forEach(function (c) { var i = el('span', 'sw' + ((o[key] || '') === c ? ' on' : ''), c ? '' : '⦸'); if (c) i.style.background = c; i.onclick = function () { o[key] = c; Array.prototype.forEach.call(rw.children, function (x) { x.classList.remove('on'); }); i.classList.add('on'); refresh(); }; rw.appendChild(i); });
        w.appendChild(rw);
      }
      row(L2('ពណ៌អក្សរ', 'Text color'), TC, 'c'); row(L2('ពណ៌ផ្ទៃក្រោយអក្សរ', 'Text background'), BC, 'bg');
      var ok = el('button', 'ok', 'OK'); ok.onclick = function () { if (!(o.t || '').trim()) { st.ov = st.ov.filter(function (q) { return q !== o; }); st.sel = null; drawOv(); } ovPanel.textContent = ''; }; w.appendChild(ok);
      setTimeout(function () { inp.focus(); }, 50);
    }
    bTxt.onclick = function () { var o = addOv({ type: 'text', t: '', c: '#ffffff', bg: '#000000', s: 0.08 }); if (o) openText(o); };
    bChg.onclick = function () { file.click(); };

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
      if (st.mode === 'text') { prev.style.background = BG[st.bg]; ta = el('textarea'); ta.maxLength = 200; ta.placeholder = t('textPh'); prev.appendChild(ta); cap.style.display = 'none'; layer = null; tools.style.display = 'none'; selbar.classList.remove('on'); ovPanel.textContent = ''; }
      else { cap.style.display = ''; if (st.file) { if (st.objUrl) URL.revokeObjectURL(st.objUrl); st.objUrl = URL.createObjectURL(st.file); var m = st.file.type.indexOf('video') === 0 ? el('video') : el('img'); m.src = st.objUrl; if (m.tagName === 'VIDEO') { m.muted = true; m.controls = true; m.playsInline = true; } prev.appendChild(m); layer = el('div', 'ov-layer'); prev.appendChild(layer); fitOv(prev, m, layer); drawOv(); } else { layer = null; prev.appendChild(el('div', '', '📷 ' + t('pick'))); } tools.style.display = st.file ? '' : 'none'; if (!st.file) { selbar.classList.remove('on'); ovPanel.textContent = ''; } }
    }
    function setMode(m) { st.mode = m; tm.className = m === 'media' ? 'on' : ''; tt.className = m === 'text' ? 'on' : ''; if (m === 'text') { box.insertBefore(bgs, cap); } else if (bgs.parentNode) bgs.remove(); paintPrev(); }
    tm.onclick = function () { setMode('media'); }; tt.onclick = function () { setMode('text'); };
    prev.onclick = function (e) { if (st.mode !== 'media') return; if (!st.file) { file.click(); return; } if (st.sel) { select(null); } };
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
        try { var pf = await prepareStoryFile(st.file, function (p) { share.textContent = '⚙️ ' + Math.round(p) + '%'; }); share.textContent = t('uploading'); var ud = await putStoryFile(pf, function (p) { share.textContent = '☁️ ' + Math.round(p) + '%'; }); body.mediaType = ud.type; body.mediaUrl = ud.url; body.caption = cap.value.trim();
          var ovs = []; for (var oi = 0; oi < st.ov.length; oi++) { var q = st.ov[oi], base = { x: +q.x.toFixed(4), y: +q.y.toFixed(4), s: +q.s.toFixed(4), r: Math.round(q.r || 0) };
            if (q.type === 'emoji') ovs.push(Object.assign({ type: 'emoji', e: q.e }, base));
            else if (q.type === 'text') { if (q.t && q.t.trim()) ovs.push(Object.assign({ type: 'text', t: q.t.trim(), c: q.c || '#ffffff', bg: q.bg || '' }, base)); }
            else { var ud2 = await putStoryFile(new File([q.blob], q.blob.type === 'image/png' ? 'sticker.png' : 'sticker.jpg', { type: q.blob.type })); ovs.push(Object.assign({ type: 'image', u: ud2.url }, base)); } }
          if (ovs.length) body.overlays = ovs; }
        catch (e) { share.disabled = false; cancel.disabled = false; share.textContent = t('share'); msg.textContent = t('fail'); return; }
      }
      var d = await api('/api/stories', { method: 'POST', body: body });
      share.disabled = false; cancel.disabled = false; share.textContent = t('share');
      if (d.success) { closeMaker(); await load(); } else msg.textContent = d.error || t('fail');
    };
    paintPrev();
  }
  function closeMaker() { if (mk) { mk.classList.remove('on'); mk.textContent = ''; } try { window.CamPause && window.CamPause.release('story'); } catch (e) {} }

  function init() {
    var anchor = document.getElementById('postsContainer'); if (!anchor || document.getElementById('storyBar')) return;
    bar = el('div'); bar.id = 'storyBar'; anchor.parentNode.insertBefore(bar, anchor); renderBar(); load();
    setInterval(function () { if (!document.hidden && !(view && view.classList.contains('on'))) load(); }, 120000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.CamFeedStories = { open: openMaker, reload: load };
})();
