(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  // テーマ
  $('.theme-btn')?.addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('zp-theme', root.dataset.theme); } catch (e) {}
  });

  // モバイルの目次
  $('.menu-btn')?.addEventListener('click', () => document.body.classList.toggle('nav-open'));
  $$('.side a').forEach((a) => a.addEventListener('click', () => document.body.classList.remove('nav-open')));

  // 読了管理
  const done = new Set(store.get('zp-done', []));
  const paint = () => {
    $$('.done-btn').forEach((b) => b.setAttribute('aria-pressed', done.has(b.dataset.key)));
    $$('.nav-secs a').forEach((a) => a.classList.toggle('is-done', done.has(a.dataset.key)));
    $$('.nav-prog').forEach((el) => {
      const ch = el.dataset.ch, total = +el.dataset.total;
      const n = [...done].filter((k) => k.startsWith(ch + '#')).length;
      el.textContent = n ? (n >= total ? '読了' : `${n}/${total}`) : '';
      el.classList.toggle('is-done', n >= total && total > 0);
    });
    const dc = $('#done-count');
    if (dc) dc.textContent = done.size;
  };
  $$('.done-btn').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const k = b.dataset.key;
      done.has(k) ? done.delete(k) : done.add(k);
      store.set('zp-done', [...done]);
      paint();
    })
  );
  paint();

  // 続きから
  const page = location.pathname.split('/').pop() || 'index.html';
  if (page !== 'index.html' && page) store.set('zp-last', page + location.hash);
  const resume = $('#resume');
  const last = store.get('zp-last', null);
  if (resume && last) { resume.href = last; resume.hidden = false; }

  // コピー
  $$('.copy').forEach((b) =>
    b.addEventListener('click', async () => {
      const box = b.closest('.code');
      const ta = box.querySelector('.ed-ta');
      const code = box.querySelector('code');
      const lines = $$('.ln', code).filter((l) => !l.classList.contains('del'));
      let text = ta ? ta.value : lines.map((l) => l.textContent).join('\n');
      if (b.closest('.is-console') && !ta) text = text.split('\n').filter((l) => l.startsWith('$ ')).map((l) => l.slice(2)).join('\n') || text;
      try { await navigator.clipboard.writeText(text); b.textContent = 'コピーしました'; } catch (e) { b.textContent = '失敗'; }
      setTimeout(() => (b.textContent = 'コピー'), 1400);
    })
  );

  // 図のステップ切替
  $$('.steps').forEach((st) => {
    const btns = $$('.step-btn', st), panes = $$('.step-pane', st);
    const go = (i) => {
      btns.forEach((b, k) => b.setAttribute('aria-pressed', k === i));
      panes.forEach((p, k) => (p.hidden = k !== i));
    };
    btns.forEach((b, i) => b.addEventListener('click', () => go(i)));
    st.tabIndex = -1;
    st.addEventListener('keydown', (e) => {
      const cur = btns.findIndex((b) => b.getAttribute('aria-pressed') === 'true');
      if (e.key === 'ArrowRight') { go(Math.min(cur + 1, btns.length - 1)); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { go(Math.max(cur - 1, 0)); e.preventDefault(); }
    });
  });

  // 現在位置のハイライト（目次）
  const heads = $$('.doc h2[id]');
  if (heads.length) {
    const tocLinks = $$('.toc a'), navLinks = $$('.nav-secs a');
    const setCur = (id) => {
      tocLinks.forEach((a) => a.classList.toggle('is-cur', a.getAttribute('href') === '#' + id));
      navLinks.forEach((a) => a.classList.toggle('is-cur', a.getAttribute('href') === '#' + id));
    };
    const onScroll = () => {
      let cur = heads[0].id;
      for (const h of heads) { if (h.getBoundingClientRect().top < 140) cur = h.id; else break; }
      setCur(cur);
    };
    document.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // 検索
  const q = $('#q'), res = $('.search-res');
  if (q && window.ZR_INDEX) {
    let sel = 0, hits = [];
    const norm = (s) => s.toLowerCase().normalize('NFKC');
    const render = () => {
      const v = norm(q.value.trim());
      if (!v) { res.hidden = true; return; }
      const terms = v.split(/\s+/);
      hits = window.ZR_INDEX.filter((it) => terms.every((t) => norm(it.t + ' ' + it.c).includes(t))).slice(0, 12);
      sel = 0;
      res.innerHTML = hits.length
        ? hits.map((h, i) => `<a href="${h.u}" class="${i === sel ? 'is-sel' : ''}"><span class="sc">${h.c}</span><span>${h.t.replace(/</g, '&lt;')}</span></a>`).join('')
        : '<div class="empty">見つかりませんでした</div>';
      res.hidden = false;
    };
    q.addEventListener('input', render);
    q.addEventListener('keydown', (e) => {
      const links = $$('a', res);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % Math.max(links.length, 1);
        links.forEach((l, i) => l.classList.toggle('is-sel', i === sel));
      } else if (e.key === 'Enter' && hits[sel]) location.href = hits[sel].u;
      else if (e.key === 'Escape') { q.value = ''; res.hidden = true; q.blur(); }
    });
    q.addEventListener('blur', () => setTimeout(() => (res.hidden = true), 150));
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== q && !/input|textarea/i.test(document.activeElement.tagName)) {
        e.preventDefault(); q.focus();
      }
    });
  }
})();
