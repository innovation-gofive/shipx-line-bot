'use strict';
const root = document.getElementById('root');
const state = { demo: false, user: null, csrf: '', page: 'overview', data: null, settings: null, modal: false, testGroup: '', testCommand: null, testReply: '', testBusy: false };
const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  message: '<path d="M21 11a8.5 8.5 0 0 1-9 9H4l-1 2V12a9 9 0 0 1 18-1Z"/><path d="M8 10h8m-8 4h5"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  link: '<path d="m10 13 4-4m-5 6-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 2-2a4 4 0 1 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 1) scale(.9)"/>',
  logout: '<path d="M9 5H4v14h5m5-7h7m-4-4 4 4-4 4"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  box: '<path d="m12 3 9 5v9l-9 5-9-5V8zM3 8l9 5 9-5M12 13v9M7 5l9 5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
};
function icon(name, size = 18) { return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.info}</svg>`; }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function time(value, full = false) { return new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', ...(full ? { day: '2-digit', month: 'short' } : {}), hour: '2-digit', minute: '2-digit' }).format(value); }
function toast(text) { const el = document.getElementById('toast'); el.textContent = text; el.classList.add('visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('visible'), 4000); }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}), ...options.headers } });
  const data = await response.json();
  if (response.status === 401 && !path.endsWith('/login')) { state.user = null; login(); }
  if (!response.ok) throw new Error(data.error || 'ไม่สามารถทำรายการได้');
  return data;
}
function brand() { return '<div class="brand"><div class="brand-mark">X</div><div><div class="brand-name">ShipX<span class="muted">.</span></div><small>LINE CONTROL</small></div></div>'; }
function login(error = '') {
  root.innerHTML = `<div class="login-layout"><section class="login-story">${brand()}<div><div class="eyebrow">CUSTOMER CONNECTIONS, UNDER CONTROL</div><h1>ทุกคำถามของลูกค้า<br>เชื่อมกับ <span>ShipX</span></h1><p>จัดการกลุ่ม LINE ของแต่ละบริษัท<br>ให้ลูกค้าติดตามสถานะ Order ได้อย่างมั่นใจ</p><div class="flow-demo"><div class="flow-node">${icon('message',24)}LINE Group</div>${icon('arrow')}<div class="flow-node">${icon('shield',24)}Company scope</div>${icon('arrow')}<div class="flow-node">${icon('box',24)}ShipX Order</div></div></div><div class="login-story-foot">ONE COMPANY. ONE GROUP. THE RIGHT ACCESS.</div></section><section class="login-side"><div class="login-card"><div class="login-badge"><span class="dot"></span> SHIPX OPERATIONS WORKSPACE</div><h2>ยินดีต้อนรับกลับ</h2><p>เข้าสู่ระบบเพื่อจัดการ LINE Bot ของคุณ</p>${state.demo ? '<div class="demo-banner">โหมดตัวอย่าง • ไม่เชื่อมต่อ ShipX หรือส่งข้อความ LINE<br>ผู้ใช้ admin / รหัส shipx-demo-local-2026</div>' : ''}<form id="login-form"><div class="field"><label for="username">ชื่อผู้ใช้</label><input id="username" name="username" autocomplete="username" required maxlength="100" value="${state.demo ? 'admin' : ''}"></div><div class="field"><label for="password">รหัสผ่าน</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="512" ${state.demo ? 'value="shipx-demo-local-2026"' : ''}></div><div id="login-error" role="alert">${error ? `<p class="error">${esc(error)}</p>` : ''}</div><button class="btn primary full" type="submit">เข้าสู่ระบบ ${icon('arrow',16)}</button></form><div class="login-foot">${icon('shield',13)} สำหรับผู้ดูแลระบบที่ได้รับอนุญาต</div></div></section></div>`;
  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
    try { const session = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: event.target.username.value, password: event.target.password.value }) }); state.user = session.username; state.csrf = session.csrf; await refresh(); }
    catch (e) { login(e.message); }
  });
}
const titles = { overview: ['ภาพรวมระบบ', 'ดูแลการเชื่อมต่อ LINE Group และสิทธิ์เข้าถึงข้อมูลของลูกค้า'], groups: ['จัดการกลุ่มลูกค้า', 'ผูกแต่ละ LINE Group กับ Company ID จาก ShipX'], audit: ['ประวัติการใช้งาน', 'ตรวจสอบคำสั่ง การเปลี่ยนสิทธิ์ และผลการทำงานย้อนหลัง'], settings: ['การเชื่อมต่อระบบ', 'ตั้งค่า LINE Messaging API และ ShipX ผ่าน Environment Variables ของ Coolify'] };
function badge(group) { return !group.bot_present ? '<span class="tag bad">Bot ออกจากกลุ่ม</span>' : group.active && (group.order_enabled || group.stock_enabled || group.report_enabled) ? '<span class="tag ok"><span class="dot"></span> เปิดใช้งาน</span>' : group.company_id ? '<span class="tag">ยังไม่เปิดสิทธิ์</span>' : '<span class="tag wait">รอผูกบริษัท</span>'; }
function render() {
  if (!state.user || !state.data) return;
  const { stats } = state.data, title = titles[state.page];
  root.innerHTML = `<div class="layout"><aside class="sidebar">${brand()}<div class="nav-label">WORKSPACE</div><nav>${[['overview','grid','ภาพรวมระบบ'],['groups','users','กลุ่มลูกค้า'],['audit','clock','ประวัติการใช้งาน'],['settings','settings','การเชื่อมต่อ']].map(([p,i,t]) => `<button class="nav-button ${p === state.page ? 'active' : ''}" data-nav="${p}" ${p === state.page ? 'aria-current="page"' : ''}>${icon(i)} ${t}${p === 'groups' && stats.pending ? `<span class="nav-count">${stats.pending}</span>` : ''}</button>`).join('')}</nav><div class="sidebar-foot"><div class="side-status"><span class="dot"></span> Orders · Stock · Reports</div><small>${state.demo ? 'Sample workspace' : 'ShipX LINE Bot'}<br>1 บริษัท = 1 กลุ่มที่เปิดใช้งาน</small></div></aside><main class="main"><header class="topbar"><div class="breadcrumb">Workspace ${icon('chevron',12)}<strong>LINE Bot</strong></div><div class="top-actions"><span class="tag ${state.demo ? 'wait' : ''}">${state.demo ? 'DEMO WORKSPACE' : 'ADMIN WORKSPACE'}</span><div class="profile"><div class="avatar">A</div><small>${esc(state.user)}<br>Administrator</small></div><button class="btn small" id="logout" aria-label="ออกจากระบบ" title="ออกจากระบบ">${icon('logout',16)}</button></div></header><div class="content"><div class="heading"><div><div class="eyebrow">SHIPX / LINE OPERATIONS</div><h1>${title[0]}</h1><p>${title[1]}</p></div><button class="btn" id="refresh">${icon('refresh',15)} รีเฟรช</button></div>${state.demo ? `<div class="demo-banner">${icon('info',15)} ข้อมูลทั้งหมดเป็นตัวอย่าง • ทดลองผูกกลุ่มและตรวจสิทธิ์ได้โดยไม่มีการส่งข้อความไปยัง LINE จริง</div>` : ''}<div id="page-content">${state.page === 'overview' ? overview() : state.page === 'groups' ? groupsPage() : state.page === 'audit' ? auditPage() : settingsPage()}</div><footer class="page-footer"><span>ShipX LINE Control <span class="muted">/</span> Bot v0.2</span><span>อัปเดตล่าสุด ${time(Date.now())} น. • เขตเวลาไทย</span></footer></div></main></div>`;
  bind();
}
function overview() {
  const { stats, audit } = state.data;
  return `<div class="stats">${[
    ['กลุ่มลูกค้าทั้งหมด', stats.groups, 'users', '', 'LINE Group ที่ Bot ตรวจพบ'],
    ['กลุ่มพร้อมใช้งาน', stats.active, 'shield', 'green', 'ผูกบริษัทและเปิดสิทธิ์แล้ว'],
    ['รอผูกบริษัท', stats.pending, 'link', 'orange', 'รอผู้ดูแลตรวจสอบและอนุมัติ'],
    ['คำขอใน 24 ชั่วโมง', stats.queries, 'message', '', 'รวมคำขอจากหน้าทดสอบ'],
  ].map(([label,n,i,c,sub])=>`<div class="stat"><div class="stat-top">${label}<span class="stat-icon ${c}">${icon(i,18)}</span></div><div class="stat-number">${n.toLocaleString('th-TH')}</div><div class="stat-sub ${c === 'green' ? 'good' : ''}">${sub}</div></div>`).join('')}</div><div class="workspace"><div><section class="panel"><div class="panel-title"><div><h2>LINE Group Mapping</h2><p>กำหนดขอบเขตข้อมูลให้แต่ละกลุ่มลูกค้า</p></div><button class="btn link" data-nav="groups">ดูทั้งหมด ${icon('arrow',14)}</button></div>${groupTable(state.data.groups.slice(0,5))}<div class="panel-footer"><span>สิทธิ์อ้างอิง Company ID ที่ผู้ดูแลผูกไว้เท่านั้น</span>${icon('shield',14)}</div></section><div class="setup-note">${icon('info',21)}<div><h3>เริ่มต้นด้วยกลุ่มที่ถูกต้อง</h3><p>เชิญ Bot เข้ากลุ่มลูกค้า กลุ่มจะปรากฏที่นี่โดยอัตโนมัติ<br>จากนั้นเลือกบริษัทและเปิดสิทธิ์ที่ต้องการ</p><div class="steps"><span><span class="step-num">1</span>เชิญ Bot</span>${icon('chevron',12)}<span><span class="step-num">2</span>ผูกบริษัท</span>${icon('chevron',12)}<span><span class="step-num">3</span>เปิดใช้งาน</span></div></div></div></div>${tester()}</div><section class="panel section-space"><div class="panel-title"><div><h2>กิจกรรมล่าสุด</h2><p>ความเคลื่อนไหวของระบบและการจัดการสิทธิ์</p></div><button class="btn link" data-nav="audit">ดูประวัติ ${icon('arrow',14)}</button></div>${audit.length ? audit.slice(0,3).map(activity).join('') : '<div class="empty">ยังไม่มีกิจกรรมในระบบ</div>'}</section>`;
}
function groupTable(groups) {
  return groups.length ? `<div class="table-wrap"><table><thead><tr><th>LINE GROUP</th><th>บริษัท / COMPANY ID</th><th>สถานะ</th><th><span class="muted">จัดการ</span></th></tr></thead><tbody>${groups.map(g=>`<tr><td><div class="group-info"><div class="group-icon ${g.active ? '' : 'pending'}">${icon('users',17)}</div><div><div class="group-name">${esc(g.name || 'กลุ่มใหม่จาก LINE')}</div><div class="mono" title="${esc(g.id)}">${esc(g.id.slice(0,8))}…${esc(g.id.slice(-4))}</div></div></div></td><td>${g.company_id ? `<div>${esc(g.company_name)}</div><div class="mono">ID ${g.company_id}</div>` : '<span class="muted">ยังไม่ได้ผูกบริษัท</span>'}</td><td>${badge(g)}</td><td><button class="btn small" data-edit="${esc(g.id)}" aria-label="ตั้งค่ากลุ่ม ${esc(g.name || g.id)}">ตั้งค่า ${icon('chevron',12)}</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">ยังไม่พบกลุ่มลูกค้า<br>เชิญ Bot เข้ากลุ่ม แล้วส่งข้อความหนึ่งครั้ง จากนั้นกดรีเฟรช</div>';
}
function tester() {
  if (!state.testGroup || !state.data.groups.some(g=>g.id===state.testGroup)) state.testGroup = state.data.groups.find(g=>g.active)?.id || '';
  if (state.testCommand === null) state.testCommand = state.demo ? 'order SO001' : '';
  return `<aside class="panel tester-panel"><div class="tester"><div class="tester-head">${icon('message',21)}<h2>ทดสอบคำสั่ง</h2></div><p>จำลองการแท็ก Bot ในกลุ่มที่เลือก พิมพ์เฉพาะคำถามได้เลย</p><form id="test-form"><div class="field"><label for="test-group">LINE Group</label><select id="test-group" name="groupId" required><option value="">เลือกกลุ่มลูกค้า</option>${state.data.groups.map(g=>`<option value="${esc(g.id)}" ${g.id === state.testGroup ? 'selected' : ''}>${esc(g.name || g.id.slice(0,10))}</option>`).join('')}</select></div><div class="field"><label for="test-command">ข้อความสอบถาม</label><input id="test-command" name="text" placeholder="ออเดอร์ SO001 ให้หน่อย" maxlength="250" required value="${esc(state.testCommand)}"></div>${state.demo ? '<div class="examples"><button type="button" class="chip" data-example="order SO001">order SO001</button><button type="button" class="chip" data-example="เช็กสต๊อก SKU001">สต๊อก</button><button type="button" class="chip" data-example="สรุปออเดอร์ค้างวันนี้และย้อนหลัง 2 วัน">ออเดอร์ค้าง</button><button type="button" class="chip" data-example="วันนี้ต้องส่งกี่ออเดอร์ แพ็คไปเท่าไหร่">กำหนดส่งวันนี้</button><button type="button" class="chip" data-example="ออเดอร์ที่กำหนดส่งวันนี้แต่ยังแพ็คไม่เสร็จ">ออเดอร์ที่ต้องติดตาม</button></div>' : '<div class="hint">ตัวอย่าง: เช็กสต๊อก SKU001 หรือ สรุปออเดอร์ค้างวันนี้</div>'}<button class="btn primary full" type="submit" ${state.testBusy ? 'disabled' : ''}>ส่งคำถามทดสอบ ${icon('arrow',15)}</button></form><div class="reply-label"><span>BOT RESPONSE</span><span class="tag ok">${state.demo ? 'ข้อมูลจำลอง' : 'ทดสอบผ่าน Admin'}</span></div><div class="reply-box" id="test-reply" role="status" aria-live="polite">${state.testReply ? esc(state.testReply) : 'ผลการสอบถามจะแสดงที่นี่<br>ไม่มีการส่งข้อความไปยังกลุ่ม LINE'}</div></div><div class="privacy-note">${icon('shield',15)}<span>ทดสอบด้วยสิทธิ์ของกลุ่มที่เลือก<br>คำสั่งกำหนด Company ID เองไม่ได้</span></div></aside>`;
}
function groupsPage() { return `<section class="panel"><div class="panel-title"><div><h2>กลุ่มลูกค้าทั้งหมด <span class="tag">${state.data.groups.length} กลุ่ม</span></h2><p>กลุ่มใหม่จะยังเข้าถึงข้อมูลไม่ได้จนกว่าจะผูกบริษัทและเปิดสิทธิ์</p></div><button id="sync-companies" class="btn green">${icon('refresh',14)} ดึงบริษัทจาก ShipX</button></div><div class="search-row"><input id="group-search" type="search" placeholder="ค้นหาชื่อกลุ่ม บริษัท หรือ Group ID" aria-label="ค้นหากลุ่ม"></div><div id="groups-table">${groupTable(state.data.groups)}</div></section><div class="notice">หาก Bot อยู่ในกลุ่มอยู่แล้ว ให้ส่งข้อความในกลุ่มหนึ่งครั้ง ระบบจะบันทึก Group ID จาก webhook ที่ตรวจลายเซ็นแล้วโดยอัตโนมัติ</div>`; }
const outcomes = { found: 'พบข้อมูล', configuration_required: 'รอยืนยันการตั้งค่า', sent: 'ส่งแจ้งเตือนแล้ว', retry_pending: 'รอส่งแจ้งเตือนซ้ำ', no_issues: 'ไม่พบออเดอร์ที่ต้องแจ้งเตือน', generated: 'ใช้แผนการ์ดจาก AI', selected: 'เลือกเครื่องมือ API แล้ว', fallback: 'ใช้การ์ดมาตรฐาน', stock_unavailable: 'ยังไม่พบยอดสต๊อก', not_found: 'ไม่พบในบริษัทของกลุ่ม', denied: 'ปฏิเสธการเข้าถึง', enabled: 'เปิดใช้งาน', disabled: 'ปิดใช้งาน', success: 'สำเร็จ', mapping_changed: 'สิทธิ์เปลี่ยนระหว่างสอบถาม', pending_review: 'รอผู้ดูแลตรวจสอบ', failed: 'ประมวลผลไม่สำเร็จ', upstream_error: 'เชื่อมต่อ ShipX ไม่สำเร็จ', expired: 'หมดเวลาตอบ LINE', ambiguous: 'พบหลาย Order', search_limit: 'เกินขอบเขตค้นหา', rate_limited: 'เกินอัตราคำขอ' };
const actions = { 'mapping.update': 'อัปเดตสิทธิ์กลุ่ม', 'order.lookup': 'สอบถามสถานะ Order', 'stock.lookup': 'สอบถามสต๊อก', 'report.overview': 'ดูภาพรวมออเดอร์', 'report.sales': 'ดูรายงานยอดขาย', 'report.shipping': 'ความคืบหน้าออเดอร์กำหนดส่ง', 'report.shipping_issues': 'ออเดอร์กำหนดส่งที่ต้องติดตาม', 'notification.shipping': 'แจ้งเตือนอัตโนมัติ', 'ai.command': 'AI แปลงคำถามเป็นคำสั่ง', 'ai.response': 'AI จัดการ์ดตอบกลับ', 'ai.test': 'ทดสอบการเชื่อมต่อ AI', 'bot.request': 'คำขอจาก LINE', 'admin.login': 'เข้าสู่ระบบผู้ดูแล', 'companies.sync': 'ดึงรายชื่อบริษัท', 'group.join': 'Bot เข้ากลุ่ม', 'group.leave': 'Bot ออกจากกลุ่ม', 'line.reply': 'ตอบกลับ LINE', 'webhook.process': 'ประมวลผล Webhook' };
function activity(a) {
  const group = state.data.groups.find(g=>g.id===a.group_id);
  return `<div class="activity-line"><span class="activity-icon">${icon(a.action === 'order.lookup' ? 'message' : 'shield',14)}</span><div class="activity-copy"><strong>${esc(actions[a.action] || a.action)} · ${esc(outcomes[a.outcome] || a.outcome)}</strong><p>${esc(group?.name || a.actor || 'System')}${a.reference ? ' / '+esc(a.reference) : ''}</p></div><small>${time(a.at,true)}</small></div>`;
}
function auditPage() {
  return `<section class="panel"><div class="panel-title"><div><h2>Audit log</h2><p>100 รายการล่าสุด • เก็บย้อนหลัง 90 วัน • เวลา Asia/Bangkok</p></div><span class="tag">${state.data.audit.length} รายการ</span></div>${state.data.audit.length ? `<div class="table-wrap"><table><thead><tr><th>เวลา</th><th>กิจกรรม / ผู้ดำเนินการ</th><th>กลุ่ม / บริษัท</th><th>เลขอ้างอิง / API</th><th>ผลลัพธ์</th></tr></thead><tbody>${state.data.audit.map(a=>`<tr><td>${time(a.at,true)}</td><td>${esc(actions[a.action] || a.action)}<div class="mono">${esc(a.actor || 'System')}</div></td><td><div class="mono">${esc(a.group_id || '—')}</div>${a.company_id ? 'Company '+a.company_id : ''}</td><td>${esc(a.reference || '—')}<div class="mono">${esc(a.endpoint || '')}</div></td><td><span class="tag ${['found','success','enabled'].includes(a.outcome) ? 'ok' : ['denied','failed','upstream_error'].includes(a.outcome) ? 'bad' : 'wait'}">${esc(outcomes[a.outcome] || a.outcome)}</span></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">ยังไม่มีประวัติการใช้งาน</div>'}</section>`;
}
function settingsPage() {
  const s=state.settings;
  if (!s) return '<div class="empty">กำลังโหลดการตั้งค่า…</div>';
  const flag = b=>`<span class="tag ${b ? 'ok' : 'wait'}">${b ? 'ตั้งค่าแล้ว' : 'ยังไม่ได้ตั้งค่า'}</span>`;
  return `<div class="settings-grid"><section class="panel"><div class="panel-title"><h2>LINE Messaging API</h2>${flag(s.lineConfigured)}</div><div class="settings-body"><div class="setting-row"><span>Webhook URL</span><code>${esc(s.webhookUrl)}</code></div><div class="setting-row"><span>Channel Secret / Access Token</span>${flag(s.lineConfigured)}</div><ol class="instructions"><li>เปิด Allow bot to join group chats</li><li>ตั้ง Webhook URL ด้านบน และกด Verify</li><li>เปิด Use webhook และ Webhook redelivery</li><li>ปิดข้อความตอบกลับอัตโนมัติที่ซ้ำกับ Bot</li><li>เชิญ Bot เข้ากลุ่มลูกค้า แล้วผูกบริษัทในหน้านี้</li></ol></div></section><section class="panel"><div class="panel-title"><h2>ShipX API</h2>${flag(s.shipxConfigured)}</div><div class="settings-body"><div class="setting-row"><span>Base URL</span><code>${esc(s.shipxBaseUrl || 'ยังไม่ระบุ')}</code></div><div class="setting-row"><span>X-API-Key</span>${flag(s.apiKeyConfigured)}</div><div class="setting-row"><span>Bearer Token</span>${flag(s.bearerConfigured)}</div><div class="notice">กำหนด SHIPX_BASE_URL, SHIPX_API_KEY และ/หรือ SHIPX_BEARER_TOKEN ใน Environment Variables ของ Coolify แล้ว redeploy</div><button id="sync-companies" class="btn green section-space">${icon('refresh',14)} ทดสอบและดึงรายชื่อบริษัท</button></div></section><section class="panel"><div class="panel-title"><h2>การเลือก API ตามไฟล์แนบ</h2></div><div class="settings-body"><div class="setting-row"><span>V1 • Company directory</span><code>${esc(s.companyEndpoint)}</code></div><div class="setting-row"><span>V2 • Order lookup</span><code>${esc(s.searchEndpoint)}</code></div><div class="setting-row"><span>สต๊อก</span><code>${esc(s.stockEndpoint)}</code></div><div class="setting-row"><span>ภาพรวมออเดอร์</span><code>${esc(s.overviewEndpoint)}</code></div><div class="setting-row"><span>รายงานยอดขาย</span><code>${esc(s.salesEndpoint)}</code></div><div class="setting-row"><span>V3 • กำหนดส่ง / แพ็ค</span><code>${esc(s.shippingEndpoint)}</code></div><div class="setting-row"><span>ยืนยัน ShippingDate เป็นกำหนดส่ง</span>${flag(s.shippingDateConfirmed)}</div><div class="setting-row"><span>แจ้งเตือนอัตโนมัติ</span><span>ตั้งเวลาไทยแยกตามกลุ่ม · ค่าเริ่มต้น ${esc(s.notificationTime)} น.</span></div><div class="notice">ทุกคำขอใช้บริษัทที่ผูกกับกลุ่ม และตรวจขอบเขตผลลัพธ์ก่อนตอบ</div></div></section><section class="panel"><div class="panel-title"><h2>การใช้งานบอท</h2></div><div class="settings-body"><div class="setting-row"><span>AI แปลคำถามเป็นคำสั่ง</span>${flag(s.aiConfigured)}</div><div class="setting-row"><span>AI สร้างแผนการ์ดตอบกลับ</span>${flag(s.aiResponseConfigured)}</div><div class="setting-row"><span>โมเดลคำสั่ง / คำตอบ</span><code>${esc(s.aiModel)} / ${esc(s.aiResponseModel)}</code></div><button id="test-ai" class="btn section-space" ${s.demo||!s.aiConfigured?'disabled':''}>ทดสอบ AI (เรียก API)</button><div id="ai-test-result" class="notice" role="status">${s.demo?'Demo ใช้ข้อมูลจำลองและไม่เรียก AI จริง':'ปุ่มทดสอบใช้ข้อมูลตัวอย่าง มีค่าใช้งาน OpenAI API'}</div><ol class="instructions"><li>เลือก @ShipX Bot จากรายชื่อใน LINE ก่อนพิมพ์คำถาม</li><li>เปิดสิทธิ์ Order, สต๊อก และรายงานแยกกันในแต่ละกลุ่ม</li><li>ตั้ง OPENAI_API_KEY และ AI_RESPONSE_ENABLED=true ใน Coolify แล้ว redeploy</li><li>Bot ออกจากกลุ่มจะปิดสิทธิ์อัตโนมัติ</li></ol><div class="notice">Coolify: ใช้ docker-compose.yml / port 3000<br>สำรอง volume /app/data • รัน App 1 replica</div></div></section></div>`;
}
async function refresh() {
  const [data,settings] = await Promise.all([api('/api/admin/dashboard'), api('/api/admin/settings')]);
  state.data=data; state.settings=settings; render();
}
function bindEdits() { document.querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click',()=>editGroup(b.dataset.edit))); }
function bind() {
  document.querySelectorAll('[data-nav]').forEach(b=>b.addEventListener('click',()=>{state.page=b.dataset.nav;render();}));
  document.getElementById('refresh').addEventListener('click', async event=>{event.currentTarget.disabled=true;try{await refresh();toast('อัปเดตข้อมูลแล้ว');}catch(e){toast(e.message);event.target.disabled=false;}});
  document.getElementById('logout').addEventListener('click',async()=>{try{await api('/api/admin/logout',{method:'POST',body:'{}'});state.user=null;state.csrf='';login();}catch(e){toast(e.message);}});
  bindEdits();
  document.getElementById('test-ai')?.addEventListener('click',async e=>{
    const button=e.currentTarget,output=document.getElementById('ai-test-result');button.disabled=true;output.textContent='กำลังทดสอบ AI ทั้งสองช่วงด้วยข้อมูลตัวอย่าง…';
    try{const result=await api('/api/admin/ai/test',{method:'POST',body:'{}'});output.textContent='แปลคำถาม: '+(result.planner?'ผ่าน':'ไม่ผ่าน')+' · สร้างแผนการ์ด: '+(result.presenter===null?'ปิดไว้':result.presenter?'ผ่าน':'ไม่ผ่าน')+(result.planner&&result.presenter!==false?'':' · ตรวจคีย์ โมเดล โควตา และการเชื่อมต่อใน OpenAI Platform');}
    catch(error){output.textContent=error.message;}
    finally{button.disabled=false;}
  });
  document.getElementById('group-search')?.addEventListener('input',e=>{const q=e.target.value.toLowerCase(); document.getElementById('groups-table').innerHTML=groupTable(state.data.groups.filter(g=>[g.id,g.name,g.company_name,g.company_id].join(' ').toLowerCase().includes(q)));bindEdits();});
  document.getElementById('sync-companies')?.addEventListener('click', async e=>{e.currentTarget.disabled=true;try{const result=await api('/api/admin/companies/sync',{method:'POST',body:'{}'});await refresh();toast(`อัปเดต ${result.companies.length} บริษัทแล้ว`);}catch(error){toast(error.message);e.target.disabled=false;}});
  document.getElementById('test-group')?.addEventListener('change', e=>{state.testGroup=e.target.value;state.testReply='';document.getElementById('test-reply').textContent='ผลการสอบถามจะแสดงที่นี่ ไม่มีการส่งข้อความไปยังกลุ่ม LINE';});
  document.getElementById('test-command')?.addEventListener('input', e=>{state.testCommand=e.target.value;});
  document.querySelectorAll('[data-example]').forEach(b=>b.addEventListener('click',()=>{state.testCommand=b.dataset.example;document.getElementById('test-command').value=state.testCommand;}));
  document.getElementById('test-form')?.addEventListener('submit',async e=>{
    e.preventDefault();const button=e.target.querySelector('[type=submit]');button.disabled=true;state.testBusy=true;state.testReply='กำลังสอบถาม ShipX…';document.getElementById('test-reply').textContent=state.testReply;
    const requestedGroup=e.target.groupId.value;
    try{const result=await api('/api/admin/test-command',{method:'POST',body:JSON.stringify({groupId:requestedGroup,text:e.target.text.value})});if(state.testGroup===requestedGroup)state.testReply=result.reply;}
    catch(error){if(state.testGroup===requestedGroup)state.testReply=error.message;}
    finally{state.testBusy=false;const currentButton=document.querySelector('#test-form [type=submit]');if(currentButton)currentButton.disabled=false;const reply=document.getElementById('test-reply');if(reply)reply.textContent=state.testReply;}
  });
}
function editGroup(id) {
  const group=state.data.groups.find(g=>g.id===id);if(!group)return;
  const savedAlertsTime = group.alerts_time || state.settings?.notificationTime || '16:00';
  state.modal=true;const focused=document.activeElement, overlay=document.createElement('div');overlay.className='modal-backdrop';
  overlay.innerHTML=`<section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><h2 id="modal-title">ตั้งค่ากลุ่มลูกค้า</h2><button class="btn small" id="close-modal" aria-label="ปิด">${icon('close',16)}</button></div><form id="mapping-form"><div class="modal-body"><div class="field"><label for="group-name">ชื่อกลุ่มสำหรับผู้ดูแล</label><input id="group-name" name="name" maxlength="120" value="${esc(group.name)}" placeholder="ชื่อกลุ่มลูกค้า"></div><small class="muted">LINE Group ID · ตรวจพบจาก Webhook</small><code class="modal-id">${esc(group.id)}</code><div class="field"><label for="company-id">บริษัทใน ShipX</label><select id="company-id" name="companyId"><option value="">ยังไม่ผูกบริษัท</option>${state.data.companies.map(c=>`<option value="${c.id}" ${c.id===group.company_id ? 'selected' : ''}>${esc(c.name)} · ID ${c.id}</option>`).join('')}</select></div>${!state.data.companies.length ? '<div class="error">ยังไม่มีรายชื่อบริษัท กรุณาดึงรายชื่อจาก ShipX ในหน้ากลุ่มลูกค้าก่อน</div>' : ''}<label class="check-field"><input type="checkbox" name="active" ${group.active?'checked':''}><span>เปิดใช้งานกลุ่ม<small>ต้องมี Bot อยู่ในกลุ่ม และยังไม่มีอีกกลุ่มเปิดใช้บริษัทเดียวกัน</small></span></label><label class="check-field"><input type="checkbox" name="orderEnabled" ${group.order_enabled?'checked':''}><span>อนุญาตสอบถามสถานะ Order<small>เห็นเฉพาะข้อมูลของบริษัทที่เลือกไว้ข้างบน</small></span></label><label class="check-field"><input type="checkbox" name="stockEnabled" ${group.stock_enabled?'checked':''}><span>อนุญาตสอบถามสต๊อก<small>จำนวนสินค้าพร้อมขายตาม SKU</small></span></label><label class="check-field"><input type="checkbox" name="reportEnabled" ${group.report_enabled?'checked':''}><span>อนุญาตดูรายงาน<small>ภาพรวมออเดอร์ กำหนดส่ง ความคืบหน้าแพ็ค และยอดขาย</small></span></label><label class="check-field"><input type="checkbox" name="alertsEnabled" ${group.alerts_enabled?'checked':''} ${!group.active||!group.report_enabled?'disabled':''}><span>แจ้งเตือนอัตโนมัติ<small>แจ้งออเดอร์กำหนดส่งวันนี้ที่แพ็คยังไม่เสร็จ แม้ไม่มีคนแท็กบอท</small></span></label>
    <div class="field">
      <label for="alerts-time">เวลาแจ้งเตือน (เวลาไทย)</label>
      <input id="alerts-time" name="alertsTime" type="time" step="60" value="${esc(savedAlertsTime)}" required>
    </div><div class="notice">${icon('shield',13)} ตรวจสอบว่าเป็นกลุ่มของบริษัทนี้จริงก่อนเปิดสิทธิ์ การเปลี่ยนบริษัทจะมีผลกับคำขอใหม่ทันที</div><div id="mapping-error" role="alert"></div></div><div class="modal-footer"><button type="button" class="btn" id="cancel-modal">ยกเลิก</button><button class="btn primary" type="submit">บันทึกการตั้งค่า</button></div></form></section>`;
  document.body.append(overlay);document.getElementById('group-name').focus();
  function close(){state.modal=false;overlay.remove();document.removeEventListener('keydown',keys);focused?.focus();}
  function keys(e){if(e.key==='Escape')close();if(e.key==='Tab'){const els=[...overlay.querySelectorAll('button,input,select')].filter(x=>!x.disabled);if(e.shiftKey&&document.activeElement===els[0]){e.preventDefault();els.at(-1).focus();}else if(!e.shiftKey&&document.activeElement===els.at(-1)){e.preventDefault();els[0].focus();}}}
  document.addEventListener('keydown',keys);document.getElementById('close-modal').onclick=close;document.getElementById('cancel-modal').onclick=close;
  const mappingForm=document.getElementById('mapping-form');
  const { active, reportEnabled, alertsEnabled, alertsTime } = mappingForm.elements;
  const updateAlerts = () => {
    const eligible = active.checked && reportEnabled.checked;
    alertsEnabled.disabled = !eligible;
    if (!eligible) alertsEnabled.checked = false;
    alertsTime.disabled = !alertsEnabled.checked;
  };
  for (const field of [active, reportEnabled, alertsEnabled]) field.addEventListener('change', updateAlerts);
  updateAlerts();
  document.getElementById('mapping-form').addEventListener('submit',async e=>{
    e.preventDefault();const form=e.target, button=form.querySelector('[type=submit]');button.disabled=true;
    const body = {
      name: form.elements.name.value,
      companyId: form.companyId.value ? Number(form.companyId.value) : null,
      active: active.checked,
      orderEnabled: form.orderEnabled.checked,
      stockEnabled: form.stockEnabled.checked,
      reportEnabled: reportEnabled.checked,
      alertsEnabled: alertsEnabled.checked,
      alertsTime: alertsTime.value && alertsTime.value !== savedAlertsTime ? alertsTime.value : undefined,
      revision: group.revision,
    };
    try {
      await api('/api/admin/groups/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(body) });
    } catch (error) {
      document.getElementById('mapping-error').innerHTML = `<p class="error">${esc(error.message)}</p>`;
      button.disabled = false;
      return;
    }
    state.testReply = '';
    close();
    try { await refresh(); toast('บันทึกการตั้งค่ากลุ่มแล้ว'); }
    catch (error) { toast(error.message); }
  });
}
(async()=>{try{state.demo=(await api('/api/public')).demo;try{const session=await api('/api/admin/session');state.user=session.username;state.csrf=session.csrf;await refresh();}catch{login();}}catch(error){root.innerHTML=`<div class="empty">เชื่อมต่อระบบไม่สำเร็จ<br>${esc(error.message)}<br>กรุณาโหลดหน้านี้ใหม่</div>`;}})();
