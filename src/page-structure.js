// Run inside the browser. Export a structural outline, never page text, HTML,
// attribute values, URLs, cookies, input values, or browser storage.
export function describeDocument() {
  const tags = new Set('html body main header footer nav aside section article div span p h1 h2 h3 h4 h5 h6 table thead tbody tfoot tr th td form label input textarea select option button a ul ol li dl dt dd iframe img svg path br hr strong em b i small time details summary dialog fieldset legend output'.split(' '));
  const roles = new Set('button link textbox checkbox radio combobox listbox option table row rowgroup cell columnheader grid gridcell tab tablist tabpanel dialog navigation main alert status list listitem'.split(' '));
  const types = new Set('text password email tel number search checkbox radio hidden submit button reset date datetime-local time file range color url'.split(' '));
  const labels = new Set(['문의번호', '번호', '문의유형', '문의 유형', '문의제목', '문의 제목', '제목', '문의내용', '문의 내용', '고객명', '고객 이름', '작성자', '상품명', '상품번호', '주문번호', '등록일', '작성일', '문의일', '답변일', '처리상태', '답변상태', '상태', '미답변', '답변대기', '답변 대기', '답변완료', '답변 완료', '답변', '답변 내용', '답변내용', '저장', '등록', '답변 등록', '전송', '확인', '취소', '검색', '조회', '다음', '이전', '목록', '로그인', '문의상태', '미확인', '품목번호', '브랜드명', '첨부파일', '연락처', '고객에게 답변완료']);
  const attrNames = ['id', 'class', 'name', 'href', 'value', 'onclick', 'data-id', 'data-key', 'data-row-key', 'data-index', 'data-testid', 'data-test-id', 'data-value'];
  const nodes = [], ids = new Map();
  const root = document.body;
  if (!root) return { nodes, truncated: false };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let element = root;
  let visited = 0;
  while (element && visited++ < 20000 && nodes.length < 4000) {
    const tag = element.localName;
    if (tags.has(tag)) {
      const index = nodes.length;
      ids.set(element, index);
      let parent = element.parentElement;
      while (parent && !ids.has(parent)) parent = parent.parentElement;
      let nth = 1;
      for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) if (sibling.localName === tag) nth++;
      const style = getComputedStyle(element);
      const node = { index, parent: parent ? ids.get(parent) : null, tag, nth, visible: !!element.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none' };
      // Only fixed attribute names and enum values are returned.
      node.attributes = attrNames.filter(name => element.hasAttribute(name));
      const role = element.getAttribute('role');
      if (roles.has(role)) node.role = role;
      const type = element.getAttribute('type');
      if (tag === 'input' && types.has(type)) node.inputType = type;
      if (element.getAttribute('contenteditable') === 'true') node.editable = true;
      if (['th', 'button', 'label', 'a', 'span', 'div', 'b', 'strong', 'p'].includes(tag) && element.childElementCount === 0) {
        const text = element.textContent.trim();
        if (labels.has(text)) node.uiLabel = text;
      }
      if (tag === 'a' && element.hasAttribute('href')) {
        try {
          const url = new URL(element.getAttribute('href'), location.href);
          node.link = { sameOrigin: url.origin === location.origin, hasQuery: !!url.search, hasFragment: !!url.hash, navigable: ['https:', 'http:'].includes(url.protocol) };
        } catch { node.link = { invalid: true }; }
      }
      nodes.push(node);
    }
    element = walker.nextNode();
  }
  return { nodes, truncated: !!element };
}

export async function inspectPageStructure(page) {
  const origin = new URL(page.url()).origin;
  const frames = [];
  for (const frame of page.frames()) {
    let sameOrigin = false;
    try { sameOrigin = new URL(frame.url()).origin === origin; } catch { /* No URL is exported. */ }
    if (frame !== page.mainFrame() && !sameOrigin) {
      frames.push({ main: false, skipped: 'different-origin' });
      continue;
    }
    frames.push({ main: frame === page.mainFrame(), ...await frame.evaluate(describeDocument) });
  }
  return { frames };
}

export function matchesInboxLocation(actual, expected) {
  try {
    const current = new URL(actual), inbox = new URL(expected);
    const path = url => url.pathname.replace(/\/$/, '') || '/';
    return current.origin === inbox.origin && path(current) === path(inbox)
      && current.hash.split('?')[0] === inbox.hash.split('?')[0];
  } catch { return false; }
}

export async function inspectInboxStructure(page, expectedUrl) {
  const check = async () => {
    if (!matchesInboxLocation(page.url(), expectedUrl)) throw new Error('등록된 문의 목록 페이지가 아닙니다.');
    const passwords = page.locator('input[type="password"]');
    for (let index = 0; index < await passwords.count(); index++) {
      if (await passwords.nth(index).isVisible()) throw new Error('로그인 화면에서는 문의 목록을 저장할 수 없습니다.');
    }
  };
  await check();
  const structure = await inspectPageStructure(page);
  await check();
  return { locationChecked: true, ...structure };
}
