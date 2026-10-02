(function () {
  const cfg = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const money = (c) => '$' + (c / 100).toFixed(2);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const DOT = { "Lay's": '#f5b800', Ruffles: '#2f7bff', Doritos: '#ee3b22', Cheetos: '#ff8a00', Fritos: '#c8102e' };
  const LABEL = { new: 'New', ready: 'Ready', done: 'Picked up' };

  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('YOUR-PROJECT')) {
    document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;max-width:480px;margin:auto"><h2>Setup needed</h2><p>Open <code>public/config.js</code>, paste your Supabase URL and anon key, then reload. See README.md.</p></div>';
    return;
  }
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  let products = [], cart = {}, view = 'shop', cat = null, brand = 'All', sTab = 'new';
  let isStaff = false, staffSession = null, allOrders = [], knownIds = null, loginMsg = '';
  let trackToken = null, trackData = null, mine = {};   // mine: token -> latest order data
  let lastStatus = {}, audioCtx = null, staffChannel = null;

  const P = (id) => products.find((p) => p.id === id);
  const total = () => Object.entries(cart).reduce((s, [id, q]) => s + (P(id) ? P(id).price_cents * q : 0), 0);
  const cartCount = () => Object.entries(cart).reduce((s, [id, q]) => s + (P(id) && P(id).unit === 'lb' ? 1 : q), 0);
const fmtQty = (p, q) => p.unit === 'lb' ? (Math.round(q * 100) / 100) + ' lb' : q + '×';
  const fmtDate = (d) => new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  function normPhone(v) {
    const d = v.replace(/\D/g, '');
    if (v.trim().startsWith('+')) return d.length >= 8 ? '+' + d : null;
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d[0] === '1') return '+' + d;
    return null;
  }

  /* ---------- this phone's saved order links (no account needed) ---------- */
  function getSaved() { try { return JSON.parse(localStorage.getItem('pike_orders') || '[]'); } catch (e) { return []; } }
  function saveOrder(token, code) {
    try { const l = getSaved().filter((x) => x.token !== token); l.unshift({ token, code, at: Date.now() }); localStorage.setItem('pike_orders', JSON.stringify(l.slice(0, 15))); } catch (e) {}
  }

  /* ---------- sound / alerts ---------- */
  function unlockAudio() {
    try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) {}
  }
  function beep(pattern) {
    try {
      unlockAudio(); if (!audioCtx) return;
      let t = audioCtx.currentTime;
      (pattern || [660, 880, 1040]).forEach((f) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = f; o.type = 'sine'; o.connect(g); g.connect(audioCtx.destination);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
        o.start(t); o.stop(t + 0.3); t += 0.3;
      });
    } catch (e) {}
  }
  function alertReady(code) {
    beep(); try { navigator.vibrate && navigator.vibrate([250, 120, 250, 120, 500]); } catch (e) {}
    document.title = '✅ Order #' + code + ' is ready!';
    try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('Your order is ready!', { body: 'Order #' + code + ' is ready for pickup at Pike Food Center.' }); } catch (e) {}
  }
  async function enableAlerts() {
    unlockAudio(); beep([880]);
    try { if (typeof Notification !== 'undefined' && Notification.permission === 'default') await Notification.requestPermission(); } catch (e) {}
    renderTrack();
  }

  /* ---------- navigation ---------- */
  function showView(v) {
    if ((v === 'staff' || v === 'prices') && !isStaff) v = 'login';
    view = v;
    document.querySelectorAll('.view').forEach((x) => x.classList.remove('active'));
    $('v-' + v).classList.add('active');
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === v || (v === 'track' && b.dataset.view === 'orders')));
    $('sbar').style.display = v === 'shop' ? '' : 'none';
    const T = {
      shop: ['Order now. Pick up in minutes.', 'Free in-store pickup, no account needed.'],
      checkout: ['Your pickup order', 'Check out as a guest. Pay in store.'],
      track: ['Your order', 'This page updates on its own.'],
      orders: ['My orders', 'Orders placed from this phone.'],
      login: ['Staff sign in', 'For Pike Food Center team members.'],
      staff: ['Pickup orders', 'Check off items as you pick. Customers see it live.'],
      prices: ['Edit prices', 'Changes show up for customers right away.'],
    };
    $('hdrTitle').textContent = T[v][0]; $('hdrSub').textContent = T[v][1];
    if (v === 'shop') renderShop();
    if (v === 'checkout') renderCheckout();
    if (v === 'track') refreshTrack();
    if (v === 'orders') refreshMine();
    if (v === 'login') renderLogin();
    if (v === 'staff') loadAllOrders();
    if (v === 'prices') loadPriceEditor();
    if (v !== 'track' && v !== 'orders') document.title = 'Pike Food Center Pickup';
    updateBar();
    window.scrollTo(0, 0);
  }
  function updateChrome() {
    $('navStaff').style.display = isStaff ? '' : 'none';
    $('navPrices').style.display = isStaff ? '' : 'none';
    $('staffLink').textContent = isStaff ? 'Staff sign out' : 'Staff sign in';
  }
  function updateBar() {
    const n = cartCount();
    $('cartbar').classList.toggle('hidden', n === 0 || view !== 'shop');
    $('cbCount').textContent = 'View cart (' + n + ')';
    $('cbTotal').textContent = money(total());
  }

  /* ---------- shop ---------- */
  function change(id, d) {
    const p = P(id);
    const step = (p && p.unit === 'lb') ? 0.5 * d : d;
    let v = Math.round(((cart[id] || 0) + step) * 100) / 100;
    if (v < 0) v = 0;
    cart[id] = v;
    if (!cart[id]) delete cart[id];
    if (view === 'checkout') { if (!cartCount()) showView('shop'); else renderCheckout(); } else renderShop();
    updateBar();
  }
  function ctl(id) {
    const q = cart[id] || 0;
    const p = P(id);
    const label = q ? (p.unit === 'lb' ? q + ' lb' : q) : '';
    return q
      ? `<div class="stepper"><button data-act="dec" data-id="${id}">−</button><span>${label}</span><button data-act="inc" data-id="${id}">+</button></div>`
      : `<button class="plus" aria-label="Add" data-act="inc" data-id="${id}">+</button>`;
  }
  function card(p) {
    const priceText = p.unit === 'lb' ? money(p.price_cents) + '/lb' : money(p.price_cents);
    return `<div class="card"><div class="pic">${p.image ? `<img src="products/${esc(p.image)}" alt="">` : 'Photo coming soon'}</div>
      <div class="meta"><div class="name">${esc(p.name)}</div><div class="size">${esc(p.size)}</div>
      <div class="buy"><span class="price">${priceText}</span>${ctl(p.id)}</div>${p.unit === 'lb' ? '<div class="wtnote">Priced by weight — final total confirmed at pickup</div>' : ''}</div></div>`;
  }
  function renderShop() {
    const cats = [...new Set(products.map((p) => p.category))];
    if (!cat) cat = cats[0];
    const brands = ['All', ...new Set(products.filter((p) => p.category === cat).map((p) => p.brand))];
    $('cats').innerHTML = cats.map((c) => `<div class="chip cat ${c === cat ? 'on' : ''}" data-act="cat" data-cat="${esc(c)}">${esc(c)}</div>`).join('');
    $('brands').innerHTML = brands.map((b) => `<div class="chip ${b === brand ? 'on' : ''}" data-act="brand" data-brand="${esc(b)}">${DOT[b] ? `<i style="background:${DOT[b]}"></i>` : ''}${esc(b)}</div>`).join('');
    const q = $('search').value.trim().toLowerCase();
    const list = products.filter((p) => p.category === cat && (brand === 'All' || p.brand === brand) && p.name.toLowerCase().includes(q));
    if (!list.length) { $('grid').innerHTML = '<p class="empty" style="grid-column:1/-1">No products found</p>'; return; }
    if (brand === 'All' && !q) {
      $('grid').innerHTML = brands.slice(1).map((b) => {
        const items = list.filter((p) => p.brand === b);
        return items.length ? `<div class="sec"><i style="background:${DOT[b] || '#9aa3bd'}"></i>${esc(b)} <small>${items.length}</small></div>` + items.map(card).join('') : '';
      }).join('');
    } else $('grid').innerHTML = list.map(card).join('');
  }

  /* ---------- checkout ---------- */
  function renderCheckout() {
    if (!cartCount()) { $('v-checkout').innerHTML = '<p class="empty">Your cart is empty.</p><button class="ghost" data-act="back">Continue shopping</button>'; return; }
    const hasWeight = Object.keys(cart).some((id) => P(id) && P(id).unit === 'lb');
    const lines = Object.entries(cart).map(([id, q]) => {
      const p = P(id); if (!p) return '';
      const unitText = p.unit === 'lb' ? money(p.price_cents) + '/lb' : money(p.price_cents) + ' each';
      return `<div class="line"><div class="pic">${p.image ? `<img src="products/${esc(p.image)}" alt="">` : ''}</div>
        <div class="info">${esc(p.name)}<small>${esc(p.size)}${p.size ? ' · ' : ''}${unitText}${p.unit === 'lb' ? ' · ~' + money(p.price_cents * q) : ''}</small></div>
        <div class="stepper"><button data-act="dec" data-id="${id}">−</button><span>${fmtQty(p, q)}</span><button data-act="inc" data-id="${id}">+</button></div></div>`;
    }).join('');
    $('v-checkout').innerHTML = `<button class="back" data-act="back">← Continue shopping</button>
      <div class="panel">${lines}<div class="total"><span>${hasWeight ? 'Estimated total' : 'Total'}</span><span>${money(total())}</span></div><div class="note">Pay in store when you pick up.${hasWeight ? ' Weighed items are estimated — your final total is confirmed when it\'s weighed at pickup.' : ''}</div></div>
      <div class="panel"><label for="pname">Name for pickup</label>
      <input class="txt" id="pname" type="text" maxlength="60" placeholder="e.g. Jordan">
      <label for="pphone" style="margin-top:14px">Mobile number (only used if we need to reach you)</label>
      <input class="txt" id="pphone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(616) 555-0123">
      <button class="btn" id="placeBtn" data-act="place">Place pickup order</button><div class="msg" id="orderMsg"></div></div>`;
  }
  async function placeOrder() {
    unlockAudio();
    const name = $('pname').value.trim();
    if (!name) { $('pname').focus(); return; }
    const phone = normPhone($('pphone').value);
    if (!phone) { $('orderMsg').textContent = 'Please enter a valid mobile number.'; $('pphone').focus(); return; }
    const btn = $('placeBtn'); btn.disabled = true; btn.textContent = 'Placing order…';
    const items = Object.entries(cart).map(([product_id, qty]) => ({ product_id, qty }));
    const { data, error } = await sb.rpc('place_order', { p_name: name, p_phone: phone, p_items: items });
    if (error) {
      $('orderMsg').textContent = /too many/i.test(error.message || '') ? 'Too many orders from this number. Please call the store.' : 'Could not place your order. Please try again.';
      btn.disabled = false; btn.textContent = 'Place pickup order'; return;
    }
    saveOrder(data.token, data.code); cart = {}; trackToken = data.token; trackData = null; lastStatus[data.token] = 'new';
    showView('track');
  }

  /* ---------- customer: order status ---------- */
  async function fetchOrder(token) {
    const { data, error } = await sb.rpc('get_order', { p_token: token });
    if (error || !data) return null;
    const prev = lastStatus[token];
    if (prev && prev !== 'ready' && prev !== 'done' && data.status === 'ready') alertReady(data.code);
    lastStatus[token] = data.status; mine[token] = data;
    return data;
  }
  async function refreshTrack() { if (!trackToken) return; trackData = await fetchOrder(trackToken); renderTrack(); }
  function renderTrack() {
    const o = trackData;
    if (!o) { $('v-track').innerHTML = '<p class="empty">Loading your order…</p>'; return; }
    const picked = o.items.filter((i) => i.picked).length, n = o.items.length;
    const stage = o.status === 'done' ? 3 : o.status === 'ready' ? 2 : picked > 0 ? 1 : 0;
    const names = ['Received', 'Picking', 'Ready', 'Picked up'];
    const steps = names.map((t, i) => `<div class="step ${i < stage ? 'done' : ''} ${i === stage ? 'on' : ''}"><i></i>${t}</div>`).join('');
    const banner = o.status === 'ready' ? `<div class="banner">🎉 Your order is ready! Come on in.</div>`
      : o.status === 'done' ? `<div class="banner wait">Picked up. Thanks for shopping with us!</div>`
      : `<div class="banner wait">${picked > 0 ? `We’re picking your order: ${picked} of ${n} items` : 'We got your order and will start picking it soon.'}</div>`;
    const canAlert = o.status === 'new' && typeof Notification !== 'undefined' && Notification.permission !== 'granted';
    $('v-track').innerHTML = `<div class="panel"><div class="top"><span class="who" style="font-family:var(--display);font-weight:800;font-size:1.3rem">Pickup code #${esc(o.code)}</span></div>
      <div class="prog">${esc(o.customer_name)} · ${fmtDate(o.created_at)}</div>
      <div class="steps">${steps}</div>${banner}
      ${o.items.map((i) => `<div class="chk static ${i.picked ? 'picked' : ''}"><span>${i.picked ? '✓ ' : ''}${i.qty}× ${esc(i.name)}</span></div>`).join('')}
      <div class="total"><span>Total (pay in store)</span><span>${money(o.total_cents)}</span></div></div>
      ${o.status !== 'ready' && o.status !== 'done' ? `<div class="note">Keep this page open. It will play a sound and show an alert when your order is ready.</div>
      <button class="ghost" data-act="enable-alerts">${canAlert ? 'Turn on alerts' : 'Test the alert sound'}</button>` : ''}
      <button class="ghost" data-act="back">Back to shop</button>`;
  }

  /* ---------- customer: my orders on this phone ---------- */
  async function refreshMine() {
    const saved = getSaved();
    if (!saved.length) { $('v-orders').innerHTML = '<p class="empty">No orders from this phone yet.</p>'; return; }
    await Promise.all(saved.map((s) => fetchOrder(s.token)));
    $('v-orders').innerHTML = saved.map((s) => {
      const o = mine[s.token]; if (!o) return '';
      return `<div class="order"><div class="top"><span class="who">#${esc(o.code)}</span><span class="badge ${o.status}">${LABEL[o.status]}</span></div>
        <div class="date">${fmtDate(o.created_at)}</div>
        <div class="items">${o.items.map((i) => i.qty + '× ' + esc(i.name)).join(', ')}<br><b>${money(o.total_cents)}</b></div>
        <button data-act="open-order" data-token="${s.token}">View status</button></div>`;
    }).join('') || '<p class="empty">No orders found.</p>';
  }
  // Background check so alerts fire even when the customer is looking at another tab of the site.
  async function pollMine() {
    const active = getSaved().filter((s) => (lastStatus[s.token] || 'new') !== 'done').slice(0, 5);
    if (!active.length) return;
    await Promise.all(active.map((s) => fetchOrder(s.token)));
    if (view === 'track' && trackToken) { trackData = mine[trackToken] || trackData; renderTrack(); }
    if (view === 'orders') refreshMine();
  }

  /* ---------- staff ---------- */
  function renderLogin() {
    $('v-login').innerHTML = `<div class="panel authbox"><label for="semail">Email</label>
      <input class="txt" id="semail" type="email" autocomplete="username">
      <label for="spass" style="margin-top:14px">Password</label>
      <input class="txt" id="spass" type="password" autocomplete="current-password">
      <button class="btn" data-act="staff-login">Sign in</button><div class="msg">${esc(loginMsg)}</div></div>`;
  }
  async function staffLogin() {
    unlockAudio();
    const { error } = await sb.auth.signInWithPassword({ email: $('semail').value.trim(), password: $('spass').value });
    if (error) { loginMsg = 'Wrong email or password.'; renderLogin(); return; }
    // onAuthStateChange continues the flow
  }
  async function afterAuth() {
    if (!staffSession) { isStaff = false; allOrders = []; knownIds = null; if (staffChannel) { sb.removeChannel(staffChannel); staffChannel = null; } updateChrome(); if (view === 'staff') showView('shop'); return; }
    const { data } = await sb.from('staff').select('user_id').eq('user_id', staffSession.user.id).maybeSingle();
    isStaff = !!data; updateChrome();
    if (!isStaff) { loginMsg = 'This account is not set up as staff.'; await sb.auth.signOut(); return; }
    if (!staffChannel) {
      staffChannel = sb.channel('staff-live')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => loadAllOrders())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, () => loadAllOrders())
        .subscribe();
    }
    loginMsg = ''; if (view === 'login') showView('staff');
  }
  async function loadAllOrders() {
    if (!isStaff) return;
    const { data, error } = await sb.from('orders').select('*, order_items(*)').order('created_at', { ascending: false }).limit(200);
    if (error) { $('v-staff').innerHTML = '<p class="empty">Could not load orders.</p>'; return; }
    data.forEach((o) => o.order_items.sort((a, b) => a.id - b.id));
    if (knownIds && data.some((o) => !knownIds.has(o.id))) beep([880, 660, 880]);   // new order arrived
    knownIds = new Set(data.map((o) => o.id)); allOrders = data;
    if (view === 'staff') renderStaff();
  }
  function renderStaff() {
    const tabs = ['new', 'ready', 'done'].map((s) => `<div class="stab ${s === sTab ? 'on' : ''}" data-act="stab" data-tab="${s}">${LABEL[s]} (${allOrders.filter((o) => o.status === s).length})</div>`).join('');
    const list = allOrders.filter((o) => o.status === sTab).sort((a, b) => sTab === 'new' ? new Date(a.created_at) - new Date(b.created_at) : new Date(b.created_at) - new Date(a.created_at));
    $('v-staff').innerHTML = `<div class="stabs">${tabs}</div>` + (list.length ? list.map((o) => {
      const picked = o.order_items.filter((i) => i.picked).length, n = o.order_items.length, all = picked === n;
      const checks = o.order_items.map((i) => `<label class="chk ${i.picked ? 'picked' : ''}"><input type="checkbox" data-act="pick" data-id="${i.id}" ${i.picked ? 'checked' : ''} ${o.status !== 'new' ? 'disabled' : ''}><span>${i.qty}× ${esc(i.name)}</span></label>`).join('');
      const act = o.status === 'new' ? `<button class="btn2" data-act="mark" data-id="${o.id}" data-status="ready" ${all ? '' : 'disabled'}>${all ? 'Mark ready & alert customer' : 'Check off all items to finish'}</button>`
        : o.status === 'ready' ? `<button class="btn2" data-act="mark" data-id="${o.id}" data-status="done">Mark picked up</button>` : '';
      return `<div class="order"><div class="top"><span class="who">${esc(o.customer_name)} · #${esc(o.code)}</span><span class="badge ${o.status}">${LABEL[o.status]}</span></div>
        <div class="date">${fmtDate(o.created_at)} · <a class="tel" href="tel:${esc(o.phone)}">${esc(o.phone)}</a> · <b>${money(o.total_cents)}</b></div>
        <div class="prog">${picked} of ${n} picked</div>${checks}${act}</div>`;
    }).join('') : `<p class="empty">No ${LABEL[sTab].toLowerCase()} orders</p>`);
  }
  async function pickItem(id, checked) {
    allOrders.forEach((o) => o.order_items.forEach((i) => { if (String(i.id) === String(id)) i.picked = checked; }));
    renderStaff();
    const { error } = await sb.from('order_items').update({ picked: checked }).eq('id', id);
    if (error) loadAllOrders();
  }
  async function markStatus(id, status) {
    const patch = { status }; if (status === 'ready') patch.ready_at = new Date().toISOString();
    const { error } = await sb.from('orders').update(patch).eq('id', id);
    if (!error) loadAllOrders();
  }

  /* ---------- staff: edit prices ---------- */
  let priceProducts = [], priceMsg = '', priceCat = null;
  async function loadPriceEditor() {
    if (!isStaff) return;
    const { data, error } = await sb.from('products').select('*').order('category').order('sort');
    if (error) { $('v-prices').innerHTML = '<p class="empty">Could not load products.</p>'; return; }
    priceProducts = data;
    if (!priceCat) priceCat = priceProducts[0] && priceProducts[0].category;
    renderPriceEditor();
  }
  function renderPriceEditor() {
    const cats = [...new Set(priceProducts.map((p) => p.category))];
    const tabs = cats.map((c) => `<div class="chip cat ${c === priceCat ? 'on' : ''}" data-act="pricecat" data-cat="${esc(c)}">${esc(c)}</div>`).join('');
    const rows = priceProducts.filter((p) => p.category === priceCat).map((p) => `
      <div class="prow" data-row="${p.id}">
        <div class="prowname">${esc(p.name)}<small>${esc(p.size)}${p.unit === 'lb' ? ' · sold by the lb' : ''}</small></div>
        <div class="prowedit">
          <span class="dollar">$</span><input class="pinput" type="number" step="0.01" min="0" inputmode="decimal" value="${(p.price_cents / 100).toFixed(2)}" data-id="${p.id}">
          ${p.unit === 'lb' ? '<span class="perlb">/lb</span>' : ''}
          <button class="savebtn" data-act="saveprice" data-id="${p.id}">Save</button>
        </div>
      </div>`).join('');
    $('v-prices').innerHTML = `<div class="chips cats">${tabs}</div><div class="panel pricelist">${rows || '<p class="empty">No products in this category.</p>'}</div><div class="msg">${esc(priceMsg)}</div>`;
  }
  async function savePrice(id) {
    const input = document.querySelector(`.pinput[data-id="${id}"]`);
    const row = document.querySelector(`[data-row="${id}"]`);
    const val = parseFloat(input.value);
    if (isNaN(val) || val < 0) { priceMsg = 'Enter a valid price.'; renderPriceEditor(); return; }
    const cents = Math.round(val * 100);
    const btn = row.querySelector('.savebtn'); const oldText = btn.textContent;
    btn.disabled = true; btn.textContent = 'Saving…';
    const { error } = await sb.from('products').update({ price_cents: cents }).eq('id', id);
    if (error) { btn.disabled = false; btn.textContent = oldText; priceMsg = 'Could not save. Please try again.'; renderPriceEditor(); return; }
    const p = priceProducts.find((x) => x.id === id); if (p) p.price_cents = cents;
    const pp = products.find((x) => x.id === id); if (pp) pp.price_cents = cents;
    btn.textContent = 'Saved ✓';
    setTimeout(() => { if (btn.isConnected) { btn.disabled = false; btn.textContent = 'Save'; } }, 1200);
  }

  /* ---------- events ---------- */
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]'); if (!t) return;
    const d = t.dataset;
    switch (d.act) {
      case 'nav': showView(d.view); break;
      case 'cat': cat = d.cat; brand = 'All'; renderShop(); break;
      case 'brand': brand = d.brand; renderShop(); break;
      case 'inc': change(d.id, 1); break;
      case 'dec': change(d.id, -1); break;
      case 'cart': showView('checkout'); break;
      case 'back': showView('shop'); break;
      case 'place': placeOrder(); break;
      case 'open-order': trackToken = d.token; trackData = mine[d.token] || null; showView('track'); break;
      case 'enable-alerts': enableAlerts(); break;
      case 'staff-link': if (isStaff) sb.auth.signOut(); else showView('login'); break;
      case 'staff-login': staffLogin(); break;
      case 'stab': sTab = d.tab; renderStaff(); break;
      case 'mark': markStatus(d.id, d.status); break;
      case 'pricecat': priceCat = d.cat; renderPriceEditor(); break;
      case 'saveprice': savePrice(d.id); break;
    }
  });
  document.addEventListener('change', (e) => {
    const t = e.target.closest('[data-act="pick"]'); if (t) pickItem(t.dataset.id, t.checked);
  });
  $('search').addEventListener('input', renderShop);

  /* ---------- boot ---------- */
  sb.auth.onAuthStateChange((_event, s) => { staffSession = s; setTimeout(afterAuth, 0); });
  setInterval(pollMine, 6000);
  setInterval(() => { if (isStaff && view === 'staff') loadAllOrders(); }, 12000);   // safety net if realtime drops
  (async function init() {
    const { data, error } = await sb.from('products').select('*').eq('active', true).order('sort');
    if (error) { $('grid').innerHTML = '<p class="empty" style="grid-column:1/-1">Could not load products.</p>'; return; }
    products = data; renderShop(); updateBar();
    getSaved().forEach((s) => { if (Date.now() - s.at < 12 * 3600 * 1000) lastStatus[s.token] = lastStatus[s.token] || 'new'; });
  })();
})();
