/* 📢 The ad's button on the website (feed, Reels, stories): its words, and opening its link or 📞 phone number. */
(function () {
  'use strict';
  var L = {
    learn_more: ['ស្វែងយល់បន្ថែម', 'Learn more'], message: ['ផ្ញើសារ', 'Send message'], shop: ['ទិញឥឡូវ', 'Shop now'], call: ['ទាក់ទង', 'Contact'],
    install: ['📲 ដំឡើង', '📲 Install'], download: ['⬇️ ទាញយក', '⬇️ Download'], signup: ['📝 ចុះឈ្មោះ', '📝 Sign up'], book: ['📅 កក់ទុក', '📅 Book now'],
    order: ['🛒 បញ្ជាទិញ', '🛒 Order now'], offer: ['🎁 ទទួលការផ្ដល់ជូន', '🎁 Get offer'], call_now: ['📞 ហៅឥឡូវ', '📞 Call now'], menu: ['🍽️ មើលម៉ឺនុយ', '🍽️ See menu'],
    directions: ['📍 មើលទីតាំង', '📍 Get directions']
  };
  var en = function () { try { return localStorage.getItem('camfeed_lang') === 'en'; } catch (e) { return false; } };
  window.cfCtaLabel = function (cta) { var x = L[cta] || L.learn_more; return x[en() ? 1 : 0]; };
  // a web link, or tel:+855… for "Call now" (nothing else is ever opened)
  window.cfAdTargetOk = function (u) { return /^https?:\/\//i.test(u || '') || /^tel:\+?\d{6,15}$/.test(u || ''); };
  window.cfAdOpen = function (u) {
    if (/^tel:\+?\d{6,15}$/.test(u || '')) { location.href = u; return; }
    if (/^https?:\/\//i.test(u || '')) window.open(u, '_blank', 'noopener,noreferrer');
  };
})();
