// LinuC の練習問題：問題の枠（章の中）、解いた記録、苦手の復習、模擬試験、進み具合。
// 問題は build.mjs が assets/qbank.js（window.QBANK）にまとめる。1 問 = { id, topic, exam, type: 'single'|'multi'|'fill', stem, choices, ans, fill, why, ch, chTitle }
// 記録は localStorage の zv-ans：{ 問題の ID: [{ t: 時刻, ok: 真偽 }] }。模試の記録は zv-mock：[{ t, exam, score, total, byTopic }]
(() => {
  const PREFIX = 'zv-';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const store = {
    get(k, d) { try { const v = localStorage.getItem(PREFIX + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch (e) {} },
  };
  const BANK = window.QBANK || [];
  const TOPICS = window.QTOPICS || [];
  const byId = Object.fromEntries(BANK.map((q) => [q.id, q]));
  let ans = store.get('ans', {});
  const saveAns = () => store.set('ans', ans);
  const record = (id, ok) => { (ans[id] = ans[id] || []).push({ t: Date.now(), ok }); if (ans[id].length > 20) ans[id] = ans[id].slice(-20); saveAns(); };
  const last = (id) => { const a = ans[id]; return a && a.length ? a[a.length - 1] : null; };

  // ---------------------------------------------------------------- 正誤
  const normFill = (s) => String(s).trim().replace(/\s+/g, ' ').replace(/^["'`]|["'`]$/g, '');
  function judge(q, picked) {
    if (q.type === 'fill') { const v = normFill(picked); return q.fill.some((a) => normFill(a) === v || (q.fillCase === false && normFill(a).toLowerCase() === v.toLowerCase())); }
    const want = q.ans.slice().sort().join(',');
    return picked.slice().sort().join(',') === want;
  }
  const pickedOf = (box, q) => (q.type === 'fill' ? ($('input.lq-in', box) || {}).value || '' : $$('input.lq-c', box).filter((x) => x.checked).map((x) => Number(x.value)));

  // ---------------------------------------------------------------- 1 問の枠
  // 章の中の枠は build.mjs が描く。ここでは、QBANK から同じ形の枠を描くこともできる（復習と模試）
  function cardHTML(q, n, opts = {}) {
    const inputs = q.type === 'fill'
      ? `<div class="lq-fill"><input class="lq-in" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="答えを入力"></div>`
      : `<ol class="lq-cs">${q.choices.map((c, k) => `<li><label class="lq-ch"><input class="lq-c" type="${q.type === 'multi' ? 'checkbox' : 'radio'}" name="${esc(q.id)}${opts.suffix || ''}" value="${k}"><span class="lq-mk">${'ABCDEFGH'[k]}</span><span class="lq-ct">${c}</span></label></li>`).join('')}</ol>`;
    return `<div class="lq" data-qid="${esc(q.id)}"><div class="lq-h"><span class="lq-no">${n !== undefined ? `問 ${n}` : '問題'}</span><span class="lq-tp">${esc(q.topic)} ${esc((TOPICS.find((t) => t.id === q.topic) || {}).title || '')}</span>${q.type === 'multi' ? '<span class="lq-kind">複数選択</span>' : q.type === 'fill' ? '<span class="lq-kind">入力</span>' : ''}<span class="lq-st"></span>${opts.flag ? '<button type="button" class="lq-flag" aria-pressed="false">見直す</button>' : ''}</div><div class="lq-stem">${q.stem}</div>${inputs}${opts.noButton ? '' : '<div class="lq-act"><button type="button" class="btn primary lq-go">答える</button></div>'}<div class="lq-res" hidden></div></div>`;
  }
  function showResult(box, q, ok, picked) {
    const res = $('.lq-res', box);
    res.hidden = false;
    box.dataset.result = ok ? 'ok' : 'ng';
    const right = q.type === 'fill' ? `正解：<code>${esc(q.fill[0])}</code>${q.fill.length > 1 ? `（${q.fill.slice(1).map((x) => `<code>${esc(x)}</code>`).join('、')} も正解）` : ''}` : `正解：${q.ans.map((k) => 'ABCDEFGH'[k]).join('、')}`;
    res.innerHTML = `<div class="lq-v is-${ok ? 'ok' : 'ng'}"><span class="lq-vk">${ok ? '正解' : '不正解'}</span><span>${right}</span></div><div class="lq-why">${q.why}</div>${q.ch ? `<div class="lq-ref">説明：<a href="${q.ch}.html">${esc(q.chTitle)}</a></div>` : ''}`;
    $$('input', box).forEach((x) => { x.disabled = true; });
    if (q.type !== 'fill') $$('.lq-ch', box).forEach((l, k) => { l.classList.toggle('is-ans', q.ans.includes(k)); l.classList.toggle('is-miss', picked.includes(k) && !q.ans.includes(k)); });
    const st = $('.lq-st', box);
    if (st) st.textContent = ok ? '正解' : '不正解';
  }
  function bind(box, onDone) {
    const q = byId[box.dataset.qid];
    if (!q) return;
    const go = $('.lq-go', box);
    const answer = () => {
      const picked = pickedOf(box, q);
      if (q.type === 'fill' ? !String(picked).trim() : !picked.length) { box.classList.add('is-empty'); setTimeout(() => box.classList.remove('is-empty'), 600); return; }
      const ok = judge(q, picked);
      record(q.id, ok);
      showResult(box, q, ok, picked);
      if (go) { go.textContent = 'もう一度'; go.onclick = () => reset(box); }
      if (onDone) onDone(ok);
      markSeen();
    };
    if (go) go.onclick = answer;
    const inp = $('.lq-in', box);
    if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && go && !$$('input', box)[0].disabled) answer(); });
    box._answer = answer;
  }
  function reset(box) {
    $$('input', box).forEach((x) => { x.disabled = false; if (x.type === 'text') x.value = ''; else x.checked = false; });
    $$('.lq-ch', box).forEach((l) => l.classList.remove('is-ans', 'is-miss'));
    $('.lq-res', box).hidden = true;
    delete box.dataset.result;
    const go = $('.lq-go', box);
    if (go) { go.textContent = '答える'; bind(box); }
  }
  // 章の中の枠：前に解いた結果を印だけ出す
  function markSeen() {
    $$('.lq[data-qid]').forEach((box) => {
      const l = last(box.dataset.qid);
      const st = $('.lq-st', box);
      if (st && !box.dataset.result) st.textContent = l ? (l.ok ? '前回：正解' : '前回：不正解') : '';
      if (st) st.className = 'lq-st' + (l && !box.dataset.result ? (l.ok ? ' was-ok' : ' was-ng') : '');
    });
  }
  $$('.doc .lq[data-qid]').forEach((b) => bind(b));
  markSeen();

  // ---------------------------------------------------------------- 主題ごとの成績
  function stats() {
    const out = {};
    for (const t of TOPICS) out[t.id] = { total: 0, seen: 0, ok: 0, weak: 0 };
    for (const q of BANK) {
      const s = out[q.topic]; if (!s) continue;
      s.total++;
      const l = last(q.id);
      if (l) { s.seen++; if (l.ok) s.ok++; else s.weak++; }
    }
    return out;
  }
  window.LQ = { BANK, TOPICS, stats, cardHTML, bind, judge, record, last, store, esc };

  // ---------------------------------------------------------------- 進み具合（トップページと復習のページ）
  function dashHTML() {
    const st = stats();
    const rows = TOPICS.filter((t) => t.sub).map((t) => {
      const s = st[t.id];
      const rate = s.seen ? Math.round((s.ok / s.seen) * 100) : null;
      const cov = s.total ? Math.round((s.seen / s.total) * 100) : 0;
      return `<tr class="${rate !== null && rate < 70 ? 'is-weak' : ''}"><td><a href="${t.ch}.html">${esc(t.id)}</a></td><td>${esc(t.title)}</td><td class="num">${t.weight}</td><td class="num">${s.seen} / ${s.total}</td><td><span class="lq-bar"><span style="width:${cov}%"></span></span></td><td class="num">${rate === null ? '—' : rate + '%'}</td><td><button type="button" class="dbv-btn lq-drill" data-topic="${esc(t.id)}">解く</button></td></tr>`;
    }).join('');
    const mocks = store.get('mock', []);
    const mockTxt = mocks.length ? mocks.slice(-5).reverse().map((m) => `<li>${new Date(m.t).toLocaleDateString('ja-JP')} ${m.exam} 試験：<b>${m.score} / ${m.total}</b>（${Math.round((m.score / m.total) * 100)}%）</li>`).join('') : '<li>まだ受けていません</li>';
    return `<div class="table lq-dash"><table><thead><tr><th>範囲</th><th>主題</th><th class="num">重要度</th><th class="num">解いた</th><th>進み</th><th class="num">正答率</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><div class="lq-mocks"><h3>模擬試験の記録</h3><ul>${mockTxt}</ul></div>`;
  }

  // ---------------------------------------------------------------- 復習のページ
  const drill = $('#lq-drill');
  if (drill) {
    const dash = $('#lq-dash');
    const area = $('#lq-area');
    const draw = () => { dash.innerHTML = dashHTML(); $$('.lq-drill', dash).forEach((b) => b.addEventListener('click', () => start({ topic: b.dataset.topic }))); };
    // 出す順番：前回まちがえた → まだ解いていない → 前回正解で古いもの
    function pick(filter, n) {
      const pool = BANK.filter(filter);
      const score = (q) => { const l = last(q.id); if (!l) return 1; if (!l.ok) return 0; return 2 + (Date.now() - l.t > 3 * 86400000 ? 0 : 1); };
      const shuffled = pool.map((q) => [Math.random(), q]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      return shuffled.sort((a, b) => score(a) - score(b)).slice(0, n);
    }
    function start(o) {
      const n = 20;
      const qs = o.topic ? pick((q) => q.topic === o.topic, n) : o.mode === 'new' ? pick((q) => !last(q.id), n) : o.mode === 'weak' ? pick((q) => { const l = last(q.id); return l && !l.ok; }, n) : pick((q) => !o.exam || q.exam === o.exam, n);
      if (!qs.length) { area.innerHTML = '<p class="lq-note">当てはまる問題がありません。</p>'; return; }
      let done = 0, good = 0;
      area.innerHTML = `<div class="lq-sess-h"><b>${o.topic ? esc(o.topic) + ' の問題' : o.mode === 'weak' ? '前回まちがえた問題' : o.mode === 'new' ? 'まだ解いていない問題' : 'ランダム'}</b>（${qs.length} 問）<span class="lq-sess-s"></span></div>` + qs.map((q, k) => cardHTML(q, k + 1)).join('');
      $$('.lq', area).forEach((b) => bind(b, (ok) => { done++; if (ok) good++; $('.lq-sess-s', area).textContent = `　${done} 問中 ${good} 問正解`; draw(); }));
      area.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    $$('[data-mode]', drill).forEach((b) => b.addEventListener('click', () => start({ mode: b.dataset.mode, exam: b.dataset.exam })));
    draw();
  }
  const homeDash = $('#lq-home-dash');
  if (homeDash) homeDash.innerHTML = dashHTML();

  // ---------------------------------------------------------------- 模擬試験
  const mock = $('#lq-mock');
  if (mock) {
    const area = $('#lq-mock-area');
    let timer = null;
    function build(exam) {
      // 主題ごとに、重要度の数だけ出す（まだ解いていない問題を先に）
      const subs = TOPICS.filter((t) => t.sub && t.exam === exam);
      const qs = [];
      for (const t of subs) {
        const pool = BANK.filter((q) => q.topic === t.id).map((q) => [(last(q.id) ? 1 : 0) + Math.random(), q]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
        qs.push(...pool.slice(0, t.weight));
      }
      return qs;
    }
    function startMock(exam) {
      const qs = build(exam);
      const limit = 90 * 60;
      const t0 = Date.now();
      area.innerHTML = `<div class="lq-mock-bar"><span><b>${exam} 試験</b>　${qs.length} 問</span><span class="lq-timer">90:00</span><span class="lq-prog"></span><button type="button" class="btn primary lq-submit">採点する</button></div><div class="lq-nav">${qs.map((q, k) => `<a href="#mq${k + 1}" class="lq-nav-n" data-k="${k}">${k + 1}</a>`).join('')}</div>` +
        qs.map((q, k) => `<div id="mq${k + 1}">${cardHTML(q, k + 1, { noButton: true, flag: true, suffix: '-m' })}</div>`).join('') + '<div class="lq-act lq-end"><button type="button" class="btn primary lq-submit">採点する</button></div>';
      const boxes = $$('.lq', area);
      const nav = $$('.lq-nav-n', area);
      const prog = () => { const n = boxes.filter((b, k) => { const q = qs[k]; const p = pickedOf(b, q); return q.type === 'fill' ? String(p).trim() : p.length; }).length; $('.lq-prog', area).textContent = `解答 ${n} / ${qs.length}`; boxes.forEach((b, k) => { const q = qs[k]; const p = pickedOf(b, q); nav[k].classList.toggle('is-done', !!(q.type === 'fill' ? String(p).trim() : p.length)); }); };
      area.addEventListener('change', prog); area.addEventListener('input', prog);
      $$('.lq-flag', area).forEach((f, k) => f.addEventListener('click', () => { const on = f.getAttribute('aria-pressed') !== 'true'; f.setAttribute('aria-pressed', String(on)); nav[k].classList.toggle('is-flag', on); }));
      prog();
      clearInterval(timer);
      timer = setInterval(() => {
        const left = Math.max(0, limit - Math.floor((Date.now() - t0) / 1000));
        $('.lq-timer', area).textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
        $('.lq-timer', area).classList.toggle('is-low', left < 600);
        if (!left) submit();
      }, 1000);
      const submit = () => {
        clearInterval(timer);
        let score = 0;
        const byTopic = {};
        boxes.forEach((b, k) => {
          const q = qs[k];
          const p = pickedOf(b, q);
          const ok = judge(q, p);
          if (ok) score++;
          record(q.id, ok);
          const g = q.topic.slice(0, 4);
          byTopic[g] = byTopic[g] || [0, 0]; byTopic[g][1]++; if (ok) byTopic[g][0]++;
          showResult(b, q, ok, Array.isArray(p) ? p : []);
          nav[k].classList.add(ok ? 'is-ok' : 'is-ng');
        });
        const mins = Math.round((Date.now() - t0) / 60000);
        const hist = store.get('mock', []);
        hist.push({ t: Date.now(), exam, score, total: qs.length, byTopic });
        store.set('mock', hist.slice(-30));
        const pct = Math.round((score / qs.length) * 100);
        const rows = Object.keys(byTopic).sort().map((g) => { const [a, b] = byTopic[g]; const t = TOPICS.find((x) => x.id === g) || {}; return `<tr class="${a / b < 0.7 ? 'is-weak' : ''}"><td>${esc(g)}</td><td>${esc(t.title || '')}</td><td class="num">${a} / ${b}</td><td class="num">${Math.round((a / b) * 100)}%</td></tr>`; }).join('');
        const sum = document.createElement('div');
        sum.className = 'lq-sum';
        sum.innerHTML = `<div class="lq-score"><span class="lq-score-n">${score} / ${qs.length}</span><span class="lq-score-p">${pct}%</span><span class="lq-score-m">${pct >= 80 ? '目標の 80% を超えました' : pct >= 70 ? 'あと少し。苦手の主題を復習しましょう' : 'まずは苦手の主題を、章に戻って読み直しましょう'}（${mins} 分）</span></div><div class="table"><table><thead><tr><th>主題</th><th></th><th class="num">正解</th><th class="num">正答率</th></tr></thead><tbody>${rows}</tbody></table></div><p class="lq-note">下に、全部の問題の正解と解説を出しました。まちがえた問題は「苦手を解く」のページに集まります。</p>`;
        area.prepend(sum);
        $$('.lq-submit', area).forEach((b) => { b.disabled = true; });
        $('.lq-mock-bar', area).classList.add('is-done');
        sum.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      $$('.lq-submit', area).forEach((b) => b.addEventListener('click', () => { const unanswered = boxes.filter((b2, k) => { const p = pickedOf(b2, qs[k]); return qs[k].type === 'fill' ? !String(p).trim() : !p.length; }).length; if (unanswered && !window.confirm(`まだ答えていない問題が ${unanswered} 問あります。採点しますか？`)) return; submit(); }));
      area.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    $$('[data-exam]', mock).forEach((b) => b.addEventListener('click', () => startMock(b.dataset.exam)));
    const counts = {};
    for (const q of BANK) counts[q.exam] = (counts[q.exam] || 0) + 1;
    $$('[data-count]', mock).forEach((s) => { s.textContent = counts[s.dataset.count] || 0; });
  }
})();
