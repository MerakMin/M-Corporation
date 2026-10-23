const $ = (selector, el = document) => el.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = {
  inbox: '<path d="M4 4h16v16H4z"/><path d="M4 13h5l2 3h2l2-3h5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  file: '<path d="M14 3H5v18h14V8zM14 3v6h5M8 13h8M8 17h5"/>',
  cube: '<path d="m12 3 9 5v9l-9 5-9-5V8zM3 8l9 5 9-5M12 13v9M7 5l10 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>',
  arrow: '<path d="m5 12 14 0m-6-6 6 6-6 6"/>',
  send: '<path d="m3 3 19 9-19 9 4-9zM7 12h15"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM20 2v4M18 4h4"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2"/>',
  external: '<path d="M14 3h7v7M21 3l-11 11M10 3H3v18h18v-7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
  logout: '<path d="M9 4H4v16h5M9 12h12m-5-5 5 5-5 5"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.inbox}</svg>`;
const state = { mode: localStorage.getItem('cs-mode') || 'demo', page: 'inbox', data: null, selected: null, status: 'pending', category: 'all', channel: 'all', search: '', dirty: false, busy: false, templateCategory: '배송', templateDrafts: null };
const statuses = { pending: '답변 대기', sending: '전송 중', sent: '답변 완료', failed: '전송 실패', uncertain: '게시 확인 필요' };
const pageTitles = { inbox: '통합 문의함', channels: '채널 연결', templates: '답변 템플릿', products: '상품 실측 DB', activity: '활동 기록' };
const date = value => new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' }).format(new Date(value));
function relative(value) { const m = Math.max(0, Math.floor((Date.now() - new Date(value)) / 60000)); return m < 1 ? '방금 전' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`; }
const channelOf = id => state.data.channels.find(c => c.id === id);
const badge = id => { const c = channelOf(id); return `<span class="channel-mark" style="--channel-color:${escape(c.color)}">${escape(c.mark)}</span>`; };
const waiting = row => ['pending', 'failed', 'uncertain', 'sending'].includes(row.status);
function toast(message, error = false) { const el = $('#toast'); el.textContent = message; el.className = `visible ${error ? 'error' : ''}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => el.className = '', 5500); }
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, body: options.body ? JSON.stringify(options.body) : undefined });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '요청에 실패했습니다.'); return result;
}
async function refresh(render = true) {
  state.data = await api(`/state?mode=${state.mode}`);
  if (!state.selected || !state.data.inquiries.some(i => i.id === state.selected)) state.selected = state.data.inquiries.find(waiting)?.id || state.data.inquiries[0]?.id || null;
  if (render) draw();
}
function navigation(page, label, glyph, extra = '') { return `<button class="nav-item ${state.page === page ? 'active' : ''}" data-action="navigate" data-page="${page}" aria-label="${label}">${icon(glyph)}<span>${label}</span>${extra}</button>`; }
function shell(content) {
  const pending = state.data.inquiries.filter(waiting).length;
  const connected = state.data.channels.filter(c => c.status === 'connected' && c.config.enabled).length;
  return `<aside class="sidebar">
    <a class="brand" href="/" aria-label="M-Corporation 홈"><span class="brand-symbol">m<span>·</span></span><span>M-Corporation<small>CUSTOMER EXPERIENCE</small></span></a>
    <div class="workspace"><div class="workspace-avatar">M</div><div><strong>${escape(state.data.shop)}</strong><small>CS 워크스페이스</small></div><span class="workspace-dot"></span></div>
    <div class="nav-caption">워크스페이스</div>
    <nav aria-label="주 메뉴">${navigation('inbox', '통합 문의함', 'inbox', `<span class="nav-count">${pending}</span>`)}${navigation('channels', '채널 연결', 'grid')}${navigation('templates', '답변 템플릿', 'file')}${navigation('products', '상품 실측 DB', 'cube')}${navigation('activity', '활동 기록', 'clock')}</nav>
    <div class="sidebar-channels"><div class="nav-caption">연결된 채널 <span>${state.mode === 'demo' ? '예시' : `${connected}/${state.data.channels.length}`}</span></div>${state.data.channels.map(c => `<button class="side-channel" data-action="channel-filter" data-id="${c.id}">${badge(c.id)}<span>${escape(c.name)}</span><span class="status-dot ${state.mode === 'live' && c.status === 'connected' && c.config.enabled ? 'online' : ''}"></span></button>`).join('')}</div>
    <div class="sidebar-bottom"><div class="review-note">${icon('check')}<div><strong>마지막 결정은 내가</strong><p>모든 답변은 검토 후 전송돼요.</p></div></div><button class="profile" data-action="navigate" data-page="templates"><span class="profile-avatar">M</span><span><strong>스토어 관리자</strong><small>내 워크스페이스</small></span>${icon('settings')}</button></div>
  </aside>
  <main><header class="topbar"><div class="breadcrumb">워크스페이스 ${icon('chevron')} <strong>${pageTitles[state.page]}</strong></div><div class="top-actions"><span class="local-label">${icon('check')} 로컬 저장</span><label class="mode-switch"><span class="sr-only">데이터 모드</span><select id="mode-select"><option value="demo" ${state.mode === 'demo' ? 'selected' : ''}>예시 모드</option><option value="live" ${state.mode === 'live' ? 'selected' : ''}>실제 운영</option></select>${icon('down')}</label><div class="top-avatar">M</div></div></header>
  <div class="main-content">${state.mode === 'demo' ? `<div class="demo-banner">${icon('info')}<span><strong>먼저 가볍게 둘러보세요.</strong> 예시 데이터로 모든 흐름을 체험할 수 있어요. 실제 고객에게는 전송되지 않습니다.</span><button data-action="go-live">실제 운영으로 ${icon('arrow')}</button></div>` : ''}${content}<footer class="page-footer"><span>M-Corporation CS Desk</span><span>흩어진 문의를 모아, 고객에게 더 가까이.</span></footer></div></main>`;
}
function heading(title, sub, action = '') { return `<div class="page-heading"><div><div class="eyebrow">CUSTOMER SUPPORT</div><h1>${title}<span class="heading-dot">.</span></h1><p>${sub}</p></div>${action}</div>`; }
function inbox() {
  const rows = state.data.inquiries;
  const pending = rows.filter(waiting).length;
  const completed = rows.filter(i => i.status === 'sent').length;
  const ready = rows.filter(i => ['pending', 'failed'].includes(i.status) && !i.missing.length).length;
  const filtered = rows.filter(i => (state.status === 'all' || (state.status === 'pending' ? waiting(i) : i.status === state.status)) && (state.category === 'all' || i.category === state.category) && (state.channel === 'all' || i.channel === state.channel) && `${i.customer} ${i.title} ${i.body} ${i.product}`.toLowerCase().includes(state.search.toLowerCase()));
  if (!filtered.some(i => i.id === state.selected) && !state.dirty) state.selected = filtered[0]?.id || null;
  const selected = rows.find(i => i.id === state.selected);
  return `${heading('고객의 이야기가 모이는 곳', '문의 확인부터 답변까지, 한 곳에서 차분하게 처리하세요.', `<button class="button primary" data-action="sync" ${state.busy || state.data.syncing ? 'disabled' : ''}>${icon('refresh', state.busy || state.data.syncing ? 'spin' : '')}${state.busy || state.data.syncing ? '수집 중…' : '지금 수집'}</button>`)}
  <div class="metrics"><div class="metric"><div class="metric-icon lavender">${icon('inbox')}</div><div><span>답변을 기다리는 문의</span><strong>${pending}<small>건</small></strong></div><span class="metric-tag">지금 확인해 주세요</span></div><div class="metric"><div class="metric-icon mint">${icon('check')}</div><div><span>답변 완료</span><strong>${completed}<small>건</small></strong></div><span class="metric-foot">${state.mode === 'demo' ? '예시 전송 포함' : '게시 확인 완료'}</span></div><div class="metric"><div class="metric-icon peach">${icon('spark')}</div><div><span>빈칸 없는 초안</span><strong>${ready}<small>건</small></strong></div><span class="metric-foot">검토 후 바로 전송</span></div></div>
  <section class="inbox-panel"><div class="inbox-toolbar"><div class="tabs" role="tablist" aria-label="문의 상태">${[['pending', '답변 대기', pending], ['sent', '답변 완료', completed], ['all', '전체 문의', rows.length]].map(([id, name, count]) => `<button role="tab" aria-selected="${state.status === id}" class="tab ${state.status === id ? 'active' : ''}" data-action="status" data-status="${id}">${name}<span>${count}</span></button>`).join('')}</div><span class="schedule">${icon('clock')} 10분마다 자동 수집</span></div>
  <div class="filterbar"><div class="filters"><label><span class="sr-only">채널 필터</span><select id="channel-filter"><option value="all">모든 채널</option>${state.data.channels.map(c => `<option value="${c.id}" ${state.channel === c.id ? 'selected' : ''}>${c.name}</option>`).join('')}</select></label><label><span class="sr-only">문의 유형 필터</span><select id="category-filter"><option value="all">모든 유형</option>${state.data.categories.map(c => `<option ${state.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label></div><label class="search">${icon('search')}<input id="search-input" value="${escape(state.search)}" placeholder="고객명, 문의 내용 검색" aria-label="문의 검색"><kbd>/</kbd></label></div>
  <div class="inbox-layout"><div class="inquiry-list"><div class="list-heading"><span>문의 <strong>${filtered.length}</strong></span><span>최근 문의 순 ${icon('down')}</span></div>${filtered.length ? filtered.map(row => inquiryCard(row)).join('') : `<div class="empty-state">${icon('inbox')}<h3>${state.search || state.channel !== 'all' || state.category !== 'all' ? '검색 결과가 없어요' : '아직 문의가 없어요'}</h3><p>${state.mode === 'live' ? '채널을 연결하고 문의를 수집해 보세요.' : '필터를 변경하거나 다른 상태를 확인해 보세요.'}</p>${state.mode === 'live' ? '<button class="button" data-action="navigate" data-page="channels">채널 연결하기</button>' : ''}</div>`}</div><div class="detail-pane">${selected ? detail(selected) : `<div class="detail-empty">${icon('file')}<h3>하나의 문의에 집중해 보세요</h3><p>왼쪽 목록에서 문의를 선택하면<br>원문과 답변 초안을 확인할 수 있어요.</p></div>`}</div></div></section>
  <div class="under-panel"><span><span class="status-dot ${state.mode === 'live' && state.data.channels.some(c => c.config.enabled) ? 'online' : ''}"></span>${state.mode === 'demo' ? '예시 모드 · 실제 채널 연결 전' : state.data.channels.some(c => c.config.enabled) ? `다음 자동 수집 ${date(state.data.nextSync)}` : '연결된 채널이 없습니다. 채널 연결에서 시작하세요.'}</span><span>${icon('check')} 전송 전 직접 검토</span></div>`;
}
function inquiryCard(row) {
  return `<button class="inquiry-card ${state.selected === row.id ? 'selected' : ''}" data-action="select" data-id="${row.id}" aria-pressed="${state.selected === row.id}"><div class="card-top"><span class="channel-label">${badge(row.channel)}${escape(channelOf(row.channel).name)}</span><time datetime="${row.created_at}">${row.sendBlockedReason ? '수집 ' : ''}${relative(row.created_at)}</time></div><h3>${waiting(row) ? '<span class="unread-dot"></span>' : ''}${escape(row.title)}</h3><p>${escape(row.body)}</p><div class="card-bottom"><span class="customer-name">${escape(row.customer)}<span>·</span>${escape(row.product || '상품 미지정')}</span><span class="category-badge category-${state.data.categories.indexOf(row.category)}">${row.category}</span>${['failed', 'uncertain', 'sending'].includes(row.status) ? `<span class="status-badge ${row.status}">${statuses[row.status]}</span>` : ''}</div></button>`;
}
function detail(row) {
  const locked = !['pending', 'failed'].includes(row.status);
  return `<div class="detail-header"><div>${badge(row.channel)}<strong>${escape(channelOf(row.channel).name)}</strong><span class="status-badge ${row.status}">${statuses[row.status]}</span></div>${row.url ? `<a class="icon-button" title="플랫폼 원문 열기" href="${escape(row.url)}" target="_blank" rel="noopener noreferrer">${icon('external')}<span class="sr-only">원문 열기</span></a>` : '<span class="sample-label">예시 문의</span>'}</div>
    <div class="detail-body"><div class="sender"><span class="sender-avatar">${escape(row.customer.slice(0, 1))}</span><div><strong>${escape(row.customer)}</strong><small>${row.sendBlockedReason ? '수집 ' : ''}${date(row.created_at)}</small></div><label class="detail-category"><span class="sr-only">문의 유형</span><select id="draft-category" ${locked ? 'disabled' : ''}>${state.data.categories.map(c => `<option ${row.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label></div><h2>${escape(row.title)}</h2>${row.mode === 'live' ? `<p class="help-text">문의번호 ${escape(row.external_id)}</p>` : ''}<p class="original-message">${escape(row.body)}</p>${row.product ? `<div class="product-reference">${icon('cube')}<span>${escape(row.product)}</span></div>` : ''}
    <div class="answer-divider"><span></span>${icon('spark')}<span></span></div>
    <div class="draft-heading"><div>${icon('spark')}<strong>${row.status === 'sent' ? '전송한 답변' : '답변 초안'}</strong><span>템플릿 기반</span></div>${!locked ? `<button class="text-button" data-action="regenerate" ${state.busy ? 'disabled' : ''}>${icon('refresh')} 다시 작성</button>` : ''}</div><p class="draft-caption">${row.status === 'sent' ? `${state.mode === 'demo' ? '예시 전송' : '게시 확인'} · ${date(row.sent_at)}` : '우리 스토어의 말투로 준비했어요. 전송 전 확인해 주세요.'}</p>
    <textarea id="draft-editor" class="draft-editor" aria-label="답변 초안" ${locked ? 'readonly' : ''}>${escape(row.draft)}</textarea>
    <div id="draft-warning" class="draft-warning ${row.missing.length ? '' : 'complete'}">${icon(row.missing.length ? 'info' : 'check')}<span>${row.missing.length ? `${row.missing.length}개의 빈칸을 채워 주세요 · ${escape(row.missing.join(', '))}` : '남은 빈칸이 없어요. 답변 내용을 검토해 주세요.'}</span></div>
    ${row.sendBlockedReason ? `<p class="help-text">${escape(row.sendBlockedReason)}</p>` : ''}
    ${row.error ? `<div class="error-box">${icon('info')}${escape(row.error)}</div>` : ''}
    ${row.status === 'uncertain' ? `<div class="resolve-actions"><p>원문에서 실제 게시 여부를 확인한 다음 선택하세요.</p><button class="button" data-action="resolve" data-outcome="sent">게시된 답변 확인</button><button class="button" data-action="resolve" data-outcome="pending">미게시 확인 · 대기로</button></div>` : ''}
    </div><div class="detail-footer"><span id="draft-save-status">${icon('check')}${locked ? '처리 기록 저장됨' : '초안 저장됨'}</span>${!locked ? `<div><button class="button" data-action="save-draft" ${state.busy ? 'disabled' : ''}>초안 저장</button>${row.sendBlockedReason ? `<button class="button primary" data-action="copy-draft" ${state.busy ? 'disabled' : ''}>초안 복사</button><a class="button" href="${escape(row.url)}" target="_blank" rel="noopener noreferrer">원문에서 답변</a>` : `<button class="button primary" data-action="review-send" ${state.busy ? 'disabled' : ''}>${icon('send')}${state.mode === 'demo' ? '예시 전송' : '검토 후 전송'}</button>`}</div>` : ''}</div>`;
}
function channels() {
  const total = state.data.channels.reduce((count, c) => count + c.config.sources.length, 0);
  return `${heading('모든 채널을 하나로', `${state.data.channels.length}개 채널·계정, ${total}개 문의함을 한곳에서 관리합니다.`)}
  <div class="info-strip">${icon('info')}<p>주소가 등록되어 있습니다. 채널별 로그인과 문의 화면 설정을 마친 후 자동 수집을 켜 주세요. 네이버 비욘드와 쿼터는 서로 다른 로그인 세션을 사용하며, 수집·전송 전 스토어명을 확인합니다.</p></div>
  <div class="channel-grid">${state.data.channels.map(c => `<article class="channel-card"><div class="channel-card-top">${badge(c.id)}<span class="connection-state ${c.status === 'connected' && c.config.enabled ? 'connected' : ''}">${c.status === 'connected' && c.config.enabled ? '연결됨' : c.status === 'syncing' ? '수집 중' : c.status === 'error' ? '연결 확인 필요' : c.config.enabled ? '설정됨 · 수집 전' : c.config.sources.some(s => s.url) ? '주소 등록됨' : '연결 전'}</span></div><h2>${escape(c.name)}</h2><p>${c.config.sources.length}개 문의함 · ${escape(c.config.replyShopName || state.data.shop)}</p>
  <div class="source-links">${c.config.sources.map(source => { const url = c.resolvedSources?.find(s => s.id === source.id)?.url; return url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(source.name)}${icon('external')}</a>${source.dateRange ? `<small>한국 시간 기준 최근 ${source.dateRange.days}일 자동 갱신</small>` : ''}` : `<span>${escape(source.name)} · 주소 미등록</span>`; }).join('')}</div>
  ${c.requireAccountCheck ? '<div class="account-note">계정별 독립 로그인 · 스토어명 확인 필수</div>' : ''}<div class="channel-meta">${c.last_sync ? `최근 수집 ${date(c.last_sync)}` : '로그인·문의 화면 설정 전'}</div>${c.error ? `<p class="channel-error">${escape(c.error)}</p>` : ''}<button class="button wide" data-action="configure-channel" data-id="${c.id}">${icon('link')} 연결 설정 ${icon('arrow')}</button></article>`).join('')}</div>`;
}
function templates() {
  const drafts = state.templateDrafts || state.data.templates;
  return `${heading('우리 스토어다운 답변', '일곱 가지 기본 템플릿에 우리만의 말투와 운영 정책을 담아 보세요.', `<button class="button primary" data-action="save-templates">${icon('check')}변경사항 저장</button>`)}<div class="settings-panel"><label class="field shop-field">상호명<input id="shop-name" value="${escape(state.shopDraft ?? state.data.shop)}" maxlength="100"></label><div class="template-layout"><div class="template-nav">${state.data.categories.map((c, i) => `<button class="${state.templateCategory === c ? 'active' : ''}" data-action="template-category" data-category="${c}"><span class="template-number">0${i + 1}</span>${c} 문의${icon('chevron')}</button>`).join('')}</div><div class="template-edit"><div class="section-title"><h2>${state.templateCategory} 문의 템플릿</h2><span class="soft-tag">직접 편집</span></div><textarea id="template-editor" aria-label="답변 템플릿">${escape(drafts[state.templateCategory])}</textarea><div class="template-help"><strong>필요한 정보만, 정확하게</strong><p><code>{{shop}}</code> 상호명 · <code>{{customer}}</code> 고객명 · <code>{{product}}</code> 상품명 · <code>{{measurements}}</code> 실측 정보</p><p>확인하지 않은 정보는 <code>[입고 예정일]</code>처럼 대괄호로 남겨 두세요. 빈칸이 있으면 전송되지 않습니다. 저장한 템플릿은 새 문의와 ‘다시 작성’에 적용됩니다.</p></div></div></div></div>`;
}
function products() {
  return `${heading('사이즈 답변의 든든한 기준', '상품별 실측을 저장하면, 사이즈 문의의 답변 초안에 자동으로 반영됩니다.', `<div class="heading-buttons"><button class="button" data-action="scrape-products">웹에서 수집</button><button class="button" data-action="import-products">JSON 가져오기</button><button class="button primary" data-action="add-product">${icon('plus')}상품 추가</button></div>`)}
  <div class="info-strip">${icon('info')}<p>실측 단위는 cm입니다. 문의의 상품명과 정확히 일치하는 자료를 사용합니다. 체형별 착용 데이터가 없는 경우 키·몸무게만으로 사이즈를 단정하지 않습니다.</p></div>
  ${state.data.products.length ? `<div class="product-grid">${state.data.products.map(p => `<article class="product-card"><div class="product-card-heading"><div class="product-icon">${icon('cube')}</div><div><h2>${escape(p.name)}</h2><span>${p.sizes.length}개 사이즈 · ${state.mode === 'demo' ? '예시 데이터' : '실측 데이터'}</span></div><button class="icon-button" data-action="delete-product" data-id="${p.id}" title="상품 삭제">${icon('close')}</button></div><div class="table-scroll"><table><thead><tr><th>사이즈</th><th>총장</th><th>어깨</th><th>가슴</th><th>허리</th></tr></thead><tbody>${p.sizes.map(s => `<tr><th>${escape(s.size)}</th>${['length', 'shoulder', 'chest', 'waist'].map(k => `<td>${escape(s[k] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div><button class="text-button" data-action="edit-product" data-id="${p.id}">실측 수정 ${icon('arrow')}</button></article>`).join('')}</div>` : '<div class="empty-card"><h2>첫 상품의 실측을 등록해 보세요</h2><p>상품 추가 또는 JSON 가져오기로 시작할 수 있어요.</p></div>'}`;
}
function activity() {
  const labels = { sync: '문의 수집', sync_failed: '수집 확인 필요', draft_saved: '초안 저장', draft_generated: '초안 작성', send_approved: '전송 승인', sent: '답변 완료', failed: '전송 실패', uncertain: '게시 확인 필요', resolved: '상태 확인', products: '실측 저장', settings: '설정 저장' };
  return `${heading('모든 처리 과정을 한눈에', '문의 수집과 초안 수정, 전송 승인 및 게시 결과가 기록됩니다.')}<div class="activity-panel">${state.data.events.length ? state.data.events.map(e => `<div class="activity-row"><span class="activity-icon">${icon(e.action === 'sent' ? 'check' : 'clock')}</span><div><strong>${labels[e.action] || e.action}</strong><p>${escape(e.detail)}</p>${e.inquiry_id ? `<button class="text-button" data-action="open-inquiry" data-id="${e.inquiry_id}">문의 보기</button>` : ''}</div><time>${date(e.created_at)}</time></div>`).join('') : '<div class="empty-state"><h3>아직 활동 기록이 없어요</h3><p>문의를 수집하거나 답변을 저장하면 여기에 기록됩니다.</p></div>'}</div>`;
}
function draw() { $('#app').innerHTML = shell(({ inbox, channels, templates, products, activity }[state.page])()); }
function modal(title, content, footer) {
  const el = $('#modal');
  el.innerHTML = `<div class="modal-header"><h2 id="modal-title">${title}</h2><button class="icon-button" data-action="close-modal" aria-label="닫기">${icon('close')}</button></div><div class="modal-body">${content}</div><div class="modal-footer">${footer}</div>`;
  if (!el.open) el.showModal();
}
function dirtyGuard(callback) {
  if (!state.dirty) return callback();
  modal('저장하지 않은 변경사항이 있어요', '<p>현재 수정 내용을 버리고 이동할까요?</p>', '<button class="button" data-action="close-modal">계속 작성</button><button class="button primary" id="discard-button">변경사항 버리기</button>');
  $('#discard-button').onclick = () => { state.dirty = false; state.templateDrafts = null; state.shopDraft = undefined; $('#modal').close(); callback(); };
}
function draftMissing(text) { return [...new Set(text.match(/\[[^\]\n]+\]|\{\{[^}]+\}\}|○{2,}/g) || [])]; }
async function saveDraft() {
  const row = state.data.inquiries.find(i => i.id === state.selected);
  const draft = $('#draft-editor').value; const category = $('#draft-category').value;
  if (draft !== row.draft || category !== row.category) {
    const updated = await api(`/inquiries/${row.id}`, { method: 'PATCH', body: { mode: state.mode, version: row.version, draft, category } });
    state.data.inquiries[state.data.inquiries.findIndex(i => i.id === row.id)] = updated;
  }
  state.dirty = false;
  return state.data.inquiries.find(i => i.id === state.selected);
}
async function doSync() {
  state.busy = true; draw();
  try { const r = await api('/sync', { method: 'POST', body: { mode: state.mode } }); toast(r.demo ? '예시 문의를 확인했어요. 실제 채널 수집은 실제 운영에서 진행하세요.' : r.results.some(c => !c.ok) ? `${r.added}건 추가 · 일부 채널 연결을 확인해 주세요.` : r.results.length ? `새 문의 ${r.added}건을 수집했어요.` : '연결된 채널이 없습니다. 채널 연결에서 설정하세요.', r.results.some(c => !c.ok)); } finally { state.busy = false; await refresh(); }
}
function dateRangeFor(source) {
  if (source.dateRange) return source.dateRange;
  try {
    const url = new URL(source.url);
    if (url.searchParams.has('start_date') && url.searchParams.has('end_date')) return { days: 30, startParam: 'start_date', endParam: 'end_date', periodParam: 'period' };
    if (url.searchParams.has('from') && url.searchParams.has('to')) return { days: 30, startParam: 'from', endParam: 'to' };
  } catch {}
  return null;
}
function channelModal(id) {
  const channel = channelOf(id); state.editingChannel = id;
  modal(`${escape(channel.name)} 연결 설정`, `<p class="modal-description">문의 관리 주소는 등록되어 있습니다. 전용 브라우저에 로그인한 뒤 수집할 문의함을 선택하세요. 전용 수집기가 없는 문의함은 선택자 설정이 필요합니다.</p>
    <label class="checkbox-field"><input type="checkbox" id="channel-enabled" ${channel.config.enabled ? 'checked' : ''}>자동 수집 활성화</label>
    <label class="field">답변에 사용할 상호<input id="channel-reply-shop" maxlength="100" value="${escape(channel.config.replyShopName || '')}" placeholder="공통 상호: ${escape(state.data.shop)}"></label>
    ${channel.requireAccountCheck || channel.config.accountCheck ? `<fieldset class="source-config"><legend>로그인 스토어 확인</legend><p class="help-text">같은 네이버 URL을 사용해도 비욘드와 쿼터는 별도로 로그인합니다. 화면에 표시된 현재 스토어명이 아래 이름과 정확히 일치해야 수집·전송할 수 있습니다.</p><label class="field">화면에 표시된 정확한 스토어명<input id="account-expected" maxlength="100" value="${escape(channel.config.accountCheck?.expectedText || '')}"></label><label class="field">현재 스토어명 요소의 CSS 선택자<input id="account-selector" value="${escape(channel.config.accountCheck?.selector || '')}" placeholder="로그인 후 화면에서 확인"></label></fieldset>` : ''}
    ${channel.config.sources.map((source, i) => `<fieldset class="source-config" data-source="${i}"><legend>${escape(source.name)}</legend><label class="checkbox-field"><input type="checkbox" class="source-enabled" ${source.enabled !== false ? 'checked' : ''}>이 문의함 수집</label><label class="field">문의 관리 페이지 URL<input class="source-url" type="url" value="${escape(source.url)}"></label>
    ${dateRangeFor(source) ? `<div class="date-range-settings"><label class="checkbox-field"><input class="date-auto" type="checkbox" ${source.dateRange ? 'checked' : ''}>조회 날짜 자동 갱신 (한국 시간)</label><label class="field">최근 조회 기간 (일)<input class="date-days" type="number" min="1" max="365" value="${dateRangeFor(source).days}"></label><p class="help-text">수집할 때마다 오늘과 지정 기간 전의 날짜를 계산합니다. 끄면 입력한 URL의 고정 날짜를 사용합니다.</p></div>` : ''}
    ${source.adapter === 'fashionplus-qna-readonly' ? `<p class="help-text">전용 수집기 · 선택자 입력 없이 문의 본문과 상품명을 수집합니다. 답변은 초안을 복사해 원문에서 등록하세요. CS알리미는 별도 선택자 설정이 필요하므로 고객문의만 연결할 때는 선택을 해제하세요.</p><label class="field">수집할 브랜드명<input class="source-expected-brand" maxlength="100" value="${escape(source.expectedBrand)}"></label>` : `<details><summary>문의 화면 선택자 설정 <span>로그인 후 확인</span></summary><p class="help-text">ready: 목록 컨테이너 · row: 문의 행 · idAttribute: ID 속성 · body: 본문 · link: 상세 링크 · detailIdentity: 상세 문의 요소 · detailIdAttribute: 상세 ID 속성 · editor: 답변 입력란 · submit: 전송 버튼 · postedReply: 게시된 답변. customer, title, product, date, next, empty, login, confirm은 선택입니다. row/next/postedReply는 표준 CSS를 사용하세요.</p><label class="field">선택자 JSON<textarea class="source-selectors code-editor" rows="11">${escape(JSON.stringify(Object.keys(source.selectors).length ? source.selectors : { ready: '', row: '', idAttribute: '', title: '', customer: '', body: '', product: '', link: '', detailIdentity: '', detailIdAttribute: '', editor: '', submit: '', postedReply: '', login: '', next: '', empty: '' }, null, 2))}</textarea></label></details>`}<label class="field">최대 수집 페이지<input type="number" class="source-max-pages" min="1" max="100" value="${source.maxPages || 20}"></label></fieldset>`).join('')}
    <p class="help-text">로그인 명령: <code>npm run login -- ${id}</code><br>로그인 시 서버를 잠시 종료해 주세요. 로그인 세션: .data/profiles/${id}</p>`, '<button class="button" data-action="close-modal">취소</button><button class="button primary" data-action="save-channel">설정 저장</button>');
}
function productModal(product = null) {
  const rows = product?.sizes || [{ size: 'M', length: '', shoulder: '', chest: '', waist: '' }];
  modal(product ? '상품 실측 수정' : '상품 실측 추가', `<label class="field">상품명<input id="product-name" value="${escape(product?.name || '')}" ${product ? 'readonly' : ''} placeholder="문의에 표시되는 상품명과 동일하게 입력"></label><div class="table-scroll"><table class="measurement-form"><thead><tr><th>사이즈</th><th>총장</th><th>어깨</th><th>가슴</th><th>허리</th><th></th></tr></thead><tbody id="measurement-rows">${rows.map(measurementRow).join('')}</tbody></table></div><button class="text-button" data-action="add-size">${icon('plus')}사이즈 추가</button><p class="help-text">단위: cm · 각 사이즈에 한 가지 이상의 실측을 입력하세요.</p>`, '<button class="button" data-action="close-modal">취소</button><button class="button primary" data-action="save-product">실측 저장</button>');
}
function measurementRow(s) { return `<tr>${['size', 'length', 'shoulder', 'chest', 'waist'].map(k => `<td><input aria-label="${({ size: '사이즈', length: '총장', shoulder: '어깨', chest: '가슴', waist: '허리' })[k]}" data-key="${k}" value="${escape(s[k] ?? '')}" ${k === 'size' ? 'maxlength="30"' : 'type="number" min="0.1" max="300" step="0.1"'}></td>`).join('')}<td><button class="icon-button" data-action="remove-size" aria-label="사이즈 삭제">${icon('close')}</button></td></tr>`; }

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  const action = button.dataset.action;
  try {
    if (action === 'close-modal') return $('#modal').close();
    if (action === 'navigate') return dirtyGuard(() => { state.page = button.dataset.page; draw(); });
    if (action === 'select') return dirtyGuard(() => { state.selected = button.dataset.id; draw(); });
    if (action === 'open-inquiry') return dirtyGuard(() => { state.selected = button.dataset.id; state.page = 'inbox'; state.status = 'all'; state.channel = 'all'; state.category = 'all'; state.search = ''; draw(); });
    if (action === 'status') return dirtyGuard(() => { state.status = button.dataset.status; draw(); });
    if (action === 'channel-filter') return dirtyGuard(() => { state.page = 'inbox'; state.channel = button.dataset.id; state.status = 'all'; draw(); });
    if (action === 'go-live') return dirtyGuard(async () => { state.mode = 'live'; localStorage.setItem('cs-mode', 'live'); state.page = 'channels'; await refresh(); });
    if (action === 'sync') return dirtyGuard(() => doSync().catch(e => toast(e.message, true)));
    if (action === 'save-draft') { await saveDraft(); draw(); return toast('초안을 저장했어요.'); }
    if (action === 'copy-draft') {
      const row = await saveDraft();
      if (row.missing.length) { draw(); return toast('빈칸을 모두 채운 후 복사해 주세요.', true); }
      try { await navigator.clipboard.writeText(row.draft); }
      catch { $('#draft-editor').focus(); $('#draft-editor').select(); return toast('답변을 선택했어요. Ctrl+C로 복사해 주세요.', true); }
      draw(); return toast('초안을 복사했어요. 원문에서 문의번호와 내용을 확인한 후 등록하세요.');
    }
    if (action === 'regenerate') {
      const row = state.data.inquiries.find(i => i.id === state.selected);
      const category = $('#draft-category').value;
      modal('템플릿으로 다시 작성할까요?', `<p>${escape(category)} 템플릿과 현재 실측 데이터로 초안을 교체합니다. 직접 수정한 내용은 사라집니다.</p>`, '<button class="button" data-action="close-modal">취소</button><button class="button primary" id="regenerate-confirm">다시 작성</button>');
      $('#regenerate-confirm').onclick = async () => { try { await api(`/inquiries/${row.id}/regenerate`, { method: 'POST', body: { mode: state.mode, version: row.version, category } }); state.dirty = false; $('#modal').close(); await refresh(); toast('템플릿으로 초안을 다시 작성했어요.'); } catch (e) { toast(e.message, true); } };
      return;
    }
    if (action === 'review-send') {
      const row = await saveDraft(); draw();
      if (row.sendBlockedReason) return toast(row.sendBlockedReason, true);
      if (row.missing.length) return toast('빈칸을 모두 채운 후 전송해 주세요.', true);
      modal(state.mode === 'demo' ? '예시 답변을 전송할까요?' : '고객에게 이 답변을 전송할까요?', `<div class="send-recipient">${badge(row.channel)}<strong>${escape(channelOf(row.channel).name)} · ${escape(row.customer)}</strong></div><div class="send-preview">${escape(row.draft)}</div><p class="help-text">${state.mode === 'demo' ? '예시 모드입니다. 실제 플랫폼에는 게시하지 않습니다.' : '확인하면 실제 플랫폼에 답변이 게시됩니다. 수신자와 내용을 다시 확인해 주세요.'}</p>`, '<button class="button" data-action="close-modal">돌아가기</button><button class="button primary" data-action="confirm-send">내용 확인 · 전송</button>');
      state.reviewed = { id: row.id, version: row.version, mode: state.mode }; return;
    }
    if (action === 'confirm-send') {
      button.disabled = true; button.textContent = '게시 확인 중…';
      const row = state.reviewed; state.busy = true;
      try { await api(`/inquiries/${row.id}/send`, { method: 'POST', body: { mode: row.mode, version: row.version, approved: true } }); toast(row.mode === 'demo' ? '예시 전송을 완료했어요. 실제 게시된 답변은 없습니다.' : '플랫폼에 게시된 답변을 확인했어요.'); }
      finally { state.busy = false; $('#modal').close(); await refresh(); } return;
    }
    if (action === 'resolve') {
      const row = state.data.inquiries.find(i => i.id === state.selected);
      const outcome = button.dataset.outcome;
      modal('원문에서 직접 확인하셨나요?', `<p>${outcome === 'sent' ? '실제 게시된 답변을 확인했습니다. 완료 상태로 정리합니다.' : '답변이 게시되지 않은 것을 확인했습니다. 대기로 되돌리며, 재전송에는 다시 승인이 필요합니다.'}</p>`, '<button class="button" data-action="close-modal">취소</button><button class="button primary" id="resolve-confirm">원문 확인 완료</button>');
      $('#resolve-confirm').onclick = async () => { try { await api(`/inquiries/${row.id}/resolve`, { method: 'POST', body: { mode: state.mode, version: row.version, confirmed: true, outcome } }); $('#modal').close(); await refresh(); } catch (e) { toast(e.message, true); } }; return;
    }
    if (action === 'configure-channel') return channelModal(button.dataset.id);
    if (action === 'save-channel') {
      const c = channelOf(state.editingChannel);
      const config = { ...c.config, enabled: $('#channel-enabled').checked, replyShopName: $('#channel-reply-shop').value.trim(),
        ...($('#account-selector') ? { accountCheck: { selector: $('#account-selector').value.trim(), expectedText: $('#account-expected').value.trim() } } : {}),
        sources: c.config.sources.map((s, i) => {
          const field = $(`[data-source="${i}"]`);
          const range = dateRangeFor(s);
          return { ...s, enabled: $('.source-enabled', field).checked, url: $('.source-url', field).value.trim(), selectors: $('.source-selectors', field) ? JSON.parse($('.source-selectors', field).value) : s.selectors, ...($('.source-expected-brand', field) ? { expectedBrand: $('.source-expected-brand', field).value.trim() } : {}), maxPages: Number($('.source-max-pages', field).value), ...(range ? { dateRange: $('.date-auto', field).checked ? { ...range, days: Number($('.date-days', field).value) } : null } : {}) };
        }) };

      await api(`/channels/${c.id}`, { method: 'PUT', body: { config } }); $('#modal').close(); await refresh(); return toast('채널 설정을 저장했어요. 실제 수집으로 연결을 확인하세요.');
    }
    if (action === 'template-category') { state.templateCategory = button.dataset.category; draw(); return; }
    if (action === 'save-templates') {
      await api('/settings', { method: 'PUT', body: { shop: $('#shop-name').value, templates: state.templateDrafts || state.data.templates } }); state.dirty = false; state.templateDrafts = null; state.shopDraft = undefined; await refresh(); return toast('상호명과 템플릿을 저장했어요.');
    }
    if (action === 'add-product') return productModal();
    if (action === 'edit-product') return productModal(state.data.products.find(p => p.id === button.dataset.id));
    if (action === 'add-size') { $('#measurement-rows').insertAdjacentHTML('beforeend', measurementRow({ size: '' })); return; }
    if (action === 'remove-size') { button.closest('tr').remove(); return; }
    if (action === 'save-product') {
      const sizes = [...$('#measurement-rows').rows].map(row => Object.fromEntries([...row.querySelectorAll('input')].map(input => [input.dataset.key, input.dataset.key === 'size' ? input.value : input.value ? Number(input.value) : null])));
      await api('/products', { method: 'POST', body: { mode: state.mode, products: [{ name: $('#product-name').value, sizes }] } }); $('#modal').close(); await refresh(); return toast('상품 실측을 저장했어요. 사이즈 초안에서 다시 작성을 눌러 반영하세요.');
    }
    if (action === 'delete-product') {
      const id = button.dataset.id;
      modal('상품 실측을 삭제할까요?', '<p>저장된 실측 데이터가 삭제됩니다. 기존 답변 초안은 유지됩니다.</p>', '<button class="button" data-action="close-modal">취소</button><button class="button danger" id="delete-product-confirm">삭제</button>');
      $('#delete-product-confirm').onclick = async () => { try { await api(`/products/${id}`, { method: 'DELETE', body: { mode: state.mode } }); $('#modal').close(); await refresh(); } catch (e) { toast(e.message, true); } }; return;
    }
    if (action === 'scrape-products') {
      modal('자사몰 상품 실측 수집', `<p class="modal-description">공개 상품 상세 페이지의 텍스트 실측표를 읽습니다. 상품 페이지별 URL과 공통 CSS 선택자를 입력하세요. 이미지로 된 실측표는 직접 등록해 주세요.</p><label class="field">상품 URL (한 줄에 하나, 최대 50개)<textarea id="product-urls" rows="4" placeholder="https://your-shop.com/product/…"></textarea></label><label class="field">화면 선택자 JSON<textarea id="product-selectors" rows="10" class="code-editor">${escape(JSON.stringify({ name: '', row: '', size: '', length: '', shoulder: '', chest: '', waist: '' }, null, 2))}</textarea></label><p class="help-text">name: 상품명 · row: 사이즈 행 · size: 사이즈 이름 · length: 총장 · shoulder: 어깨 · chest: 가슴 · waist: 허리. 실측은 단일 숫자(cm)로 표시된 셀을 지정하세요.</p>`, '<button class="button" data-action="close-modal">취소</button><button class="button primary" data-action="confirm-scrape">실측 수집·저장</button>'); return;
    }
    if (action === 'confirm-scrape') {
      const config = { urls: $('#product-urls').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean), selectors: JSON.parse($('#product-selectors').value) };
      button.disabled = true; button.textContent = '수집 중…';
      try { const r = await api('/products/collect', { method: 'POST', body: { mode: state.mode, config } }); $('#modal').close(); await refresh(); toast(`${r.count}개 상품의 실측을 저장했어요.`); }
      finally { button.disabled = false; button.textContent = '실측 수집·저장'; } return;
    }
    if (action === 'import-products') {
      modal('상품 실측 JSON 가져오기', '<p class="modal-description">아래 형식의 JSON 파일을 선택하세요. 같은 이름의 상품은 실측이 갱신됩니다.</p><pre class="json-example">[{ "name": "상품명", "sizes": [\n  { "size": "M", "length": 74,\n    "shoulder": 52, "chest": 59, "waist": 58 }\n] }]</pre><label class="field">JSON 파일<input type="file" id="products-file" accept=".json,application/json"></label>', '<button class="button" data-action="close-modal">취소</button><button class="button primary" data-action="confirm-import">가져오기</button>'); return;
    }
    if (action === 'confirm-import') { const file = $('#products-file').files[0]; if (!file) throw new Error('JSON 파일을 선택하세요.'); if (file.size > 2 * 1024 * 1024) throw new Error('2MB 이하 파일을 사용하세요.'); const products = JSON.parse(await file.text()); const r = await api('/products', { method: 'POST', body: { mode: state.mode, products } }); $('#modal').close(); await refresh(); toast(`${r.count}개 상품을 가져왔어요.`); }
  } catch (error) { toast(error instanceof SyntaxError ? 'JSON 형식을 확인해 주세요.' : error.message, true); }
});
document.addEventListener('input', event => {
  const el = event.target;
  if (el.id === 'draft-editor') { state.dirty = true; $('#draft-save-status').textContent = '저장하지 않은 변경사항'; const missing = draftMissing(el.value); $('#draft-warning').className = `draft-warning ${missing.length ? '' : 'complete'}`; $('#draft-warning').innerHTML = icon(missing.length ? 'info' : 'check') + `<span>${missing.length ? `${missing.length}개의 빈칸을 채워 주세요 · ${escape(missing.join(', '))}` : '남은 빈칸이 없어요. 답변 내용을 검토해 주세요.'}</span>`; }
  if (el.id === 'template-editor') { state.dirty = true; state.templateDrafts ||= { ...state.data.templates }; state.templateDrafts[state.templateCategory] = el.value; }
  if (el.id === 'shop-name') { state.dirty = true; state.shopDraft = el.value; }
  if (el.id === 'search-input') { if (state.dirty) { toast('먼저 수정한 답변을 저장해 주세요.', true); return; } state.search = el.value; const start = el.selectionStart; draw(); $('#search-input').focus(); $('#search-input').setSelectionRange(start, start); }
});
document.addEventListener('change', event => {
  const el = event.target;
  if (el.id === 'draft-category') { state.dirty = true; $('#draft-save-status').textContent = '유형 변경됨 · 다시 작성으로 초안 반영'; }
  if (el.id === 'mode-select') { const mode = el.value; el.value = state.mode; dirtyGuard(async () => { try { state.mode = mode; localStorage.setItem('cs-mode', mode); state.selected = null; await refresh(); } catch (e) { toast(e.message, true); } }); }
  if (el.id === 'channel-filter' || el.id === 'category-filter') { const key = el.id === 'channel-filter' ? 'channel' : 'category'; const value = el.value; el.value = state[key]; dirtyGuard(() => { state[key] = value; draw(); }); }
});
document.addEventListener('keydown', event => { if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !$('#modal').open) { event.preventDefault(); $('#search-input')?.focus(); } });
window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
setInterval(() => { if (!state.data || state.dirty || state.busy || $('#modal').open || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return; refresh().catch(() => {}); }, 30000);
refresh().catch(error => { $('#app').innerHTML = `<div class="loading"><h1>문의함을 불러오지 못했어요</h1><p>${escape(error.message)}</p><a href="/">다시 시도</a></div>`; });
