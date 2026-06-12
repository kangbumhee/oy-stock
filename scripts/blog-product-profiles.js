const REVIEW_PHOTO_COUNT = 18;

function htmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function textOf(post) {
  return `${post.rawName || ''} ${post.cleanName || ''} ${post.shortName || ''}`;
}

function titleFor(shortName, suffix) {
  return `${shortName} 후기처럼 보기｜${suffix}`;
}

function descriptionFor(shortName, detail) {
  const normalized = String(detail || '').replace(/\s+/g, ' ').replace(/\.$/, '');
  return `${shortName}의 ${normalized} 포인트를 사진으로 자연스럽게 살펴보고, 올리브영 재고와 구매 링크까지 바로 이어볼 수 있게 정리했습니다.`;
}

function deriveType(text) {
  const value = String(text || '');
  const pairs = [
    ['토너패드', '토너패드'],
    ['선세럼', '선세럼'],
    ['세럼', '세럼'],
    ['앰플', '앰플'],
    ['선크림', '선크림'],
    ['마스크팩', '마스크팩'],
    ['겔마스크', '겔마스크'],
    ['틴트', '틴트'],
    ['립밤', '립밤'],
    ['글로스', '글로스'],
    ['클렌징밤', '클렌징밤'],
    ['스크럽', '스크럽'],
    ['팔레트', '팔레트'],
    ['아이섀도우', '아이섀도우'],
    ['네일', '네일'],
    ['생리대', '생리대'],
    ['젤리', '젤리'],
    ['크림', '크림']
  ];
  const found = pairs.find(([token]) => value.includes(token));
  return found ? found[1] : '인기상품';
}

const BLOG_PRODUCT_PROFILES = [
  {
    id: 'torriden-dive-in-serum',
    assetPrefix: 'torriden-dive-in-serum',
    assetExt: 'jpg',
    detailFile: 'torriden-dive-in-serum-detail-page-01.jpg',
    match: (post) => textOf(post).includes('토리든') && textOf(post).includes('다이브인') && textOf(post).includes('세럼'),
    title: (shortName) => titleFor(shortName, '다이브인 세럼 올리브영 재고'),
    description: (shortName) => descriptionFor(shortName, '블루 보틀, 스포이드, 촉촉한 수분 세럼'),
    heroLead:
      '블루빛 보틀이 확 눈에 들어오는 수분 세럼이라 사진으로 봐도 청량해요. 더블 기획 구성이라 상품명과 재고를 같이 확인하는 흐름으로 정리했습니다.',
    introBig: (shortName) =>
      `${htmlEscape(shortName)}, <span class="soft-word">파란 수분 보틀</span>이 먼저 눈에 들어와요.`,
    introBody: (post) =>
      `${post.rankingDateText} 기준 조회 인기 ${post.rank}위로 올라온 세럼이에요. 더블 기획에 증정 구성까지 붙어 있어서, 사진으로 마음이 가면 옵션명과 재고를 같이 보는 게 편합니다.`,
    moodNotes: [
      ['색감', '투명한 블루 보틀이라 수분 세럼 느낌이 바로 살아나요.'],
      ['구성', '50ml 더블 기획에 증정 구성이 붙어서 상품명 확인이 중요해요.'],
      ['무드', '스포이드 병 특유의 촉촉하고 산뜻한 루틴템 분위기가 있습니다.']
    ],
    photoTitle: '블루 수분 세럼, 사진으로 보면 이런 느낌',
    photoLead:
      '이 제품은 <span class="highlight">투명한 파란 보틀</span>이랑 <span class="highlight">스포이드 세럼</span> 느낌이 살아야 예뻐요. 그래서 화장대, 손등, 욕실 컷처럼 수분 세럼 후기에서 많이 보는 흐름으로 넣었습니다.',
    shoppingTitle: '더블 기획은 상품명 끝까지 보는 게 좋아요',
    shoppingParagraphs: (post) => [
      `${htmlEscape(post.rawName)}처럼 더블 기획, 증정 세럼, 선크림 증정이 같이 들어가면 구매 화면에서 구성 표현이 길게 나올 수 있어요.`,
      '바로 누르기 전에는 <span class="highlight">기획 구성</span>, <span class="highlight">온라인 재고</span>, <span class="highlight">근처 매장 재고</span>를 같이 보는 쪽이 마음 편합니다.'
    ],
    checklist: [
      '토리든 다이브인 저분자 히알루론산 세럼인지 상품명 맞추기',
      '50ml 더블 기획과 증정 구성이 맞는지 확인하기',
      '온라인 재고와 오늘드림 가능 여부 같이 보기',
      '근처 매장 픽업이 가능한지도 열어두기'
    ],
    tipTitle: '수분 세럼은 행사 붙으면 재고가 빨리 움직여요',
    tipParagraph:
      '세럼은 같은 브랜드 안에서도 용량과 기획 구성이 여러 개라 헷갈리기 쉬워요. 마음에 든 구성이 있으면 상품명 길게 검색하고 재고부터 보는 게 가장 덜 번거롭습니다.',
    tips: [
      ['1. 다이브인 세럼까지 넣기', '토리든만 검색하면 마스크팩이나 선크림도 같이 섞일 수 있어요.'],
      ['2. 더블 기획 확인', '50ml 더블 기획인지 단품인지 먼저 보면 실수가 줄어듭니다.'],
      ['3. 받을 방식 고르기', '온라인, 오늘드림, 매장 픽업 중 지금 편한 쪽을 보면 돼요.']
    ],
    captions: [
      ['세면대 첫 컷', '투명한 블루 보틀이 먼저 보여서 수분 세럼 느낌이 바로 살아나요.'],
      ['손에 든 컷', '손에 들었을 때 병 크기가 딱 보여서 50ml 느낌을 보기 좋습니다.'],
      ['스포이드 가까이', '스포이드와 입구가 보이면 묽은 세럼 제형을 상상하기 쉬워요.'],
      ['두 병 구성', '더블 기획은 두 병을 같이 두는 컷이 있어야 구성감이 확 와요.'],
      ['증정품 옆', '세럼 옆에 미니 튜브를 두면 기획 구성 분위기가 더 잘 보입니다.'],
      ['손등 제형', '손등에 투명한 제형이 살짝 보이면 촉촉한 수분감이 자연스럽게 살아나요.'],
      ['파우치 구성', '투명 파우치에 세럼과 증정품을 같이 넣으면 들고 다니는 느낌이 있어요.'],
      ['창가 컷', '창가 빛이 들어오면 블루 보틀이 더 맑고 산뜻하게 보여요.'],
      ['화장솜 옆', '화장솜 통 옆에 두니 매일 쓰는 기초 루틴템처럼 보입니다.'],
      ['아침 루틴', '세럼 두 병과 튜브를 같이 놓으면 밝은 아침 루틴 무드가 잘 맞아요.'],
      ['서랍 정리', '기초 제품 서랍 안에 넣어두면 하나 더 쟁여둔 느낌이 자연스러워요.'],
      ['거울 앞 컷', '거울과 식물 옆에 두면 화장대 위 블루 포인트가 또렷하게 보여요.'],
      ['라벨 가까이', 'Torriden, DIVE IN, Serum 글자가 보이면 상품 찾기가 훨씬 쉬워요.'],
      ['손에 들고 보기', '창가에서 손에 들면 보틀 색감과 라벨이 한눈에 들어옵니다.'],
      ['손바닥 제형', '손바닥에 올린 투명 제형이 보여서 가벼운 수분 세럼 느낌이 나요.'],
      ['타월 위 컷', '하얀 타월 위에 두면 블루 보틀이 더 깨끗하고 시원하게 보여요.'],
      ['구성 한눈에', '큰 병과 증정품을 같이 두면 구매 전 구성 확인이 쉬워요.'],
      ['마지막 정리', '밝은 화장대 위에 두 병을 올려두면 다이브인 라인 느낌이 또렷하게 남습니다.']
    ]
  },
  {
    id: 'mediheal-toner-pad',
    assetPrefix: 'mediheal-toner-pad',
    assetExt: 'jpg',
    detailFile: 'mediheal-toner-pad-detail-page-01.png',
    match: (post) => textOf(post).includes('메디힐') && textOf(post).includes('토너패드'),
    title: (shortName) => titleFor(shortName, '민트 네모패드 올리브영 재고'),
    description: (shortName) => descriptionFor(shortName, '민트 용기 색감, 네모패드 크기, 촉촉한'),
    heroLead:
      '민트색 통이 예쁜지, 네모패드가 큼직해 보이는지, 그리고 지금 올리브영에서 바로 살 수 있는지까지 한 번에 보려고 정리한 글입니다.',
    introBig: (shortName) =>
      `${htmlEscape(shortName)}, 일단 색감이 너무 <span class="soft-word">시원한 민트</span> 쪽이라 눈이 가요.`,
    introBody: (post) =>
      `${post.rankingDateText} 기준 올리브영 조회 인기 ${post.rank}위로 잡힌 상품이라, 사진 보다가 마음에 들면 재고부터 보는 게 편합니다. 특히 올영픽이나 한정기획 붙은 제품은 옵션이 은근 빨리 달라져요.`,
    moodNotes: [
      ['색감', '쨍한 아쿠아 민트라 욕실이나 화장대에 올려도 산뜻해 보여요.'],
      ['패드', '동그란 패드가 아니라 네모패드라 크기감이 더 잘 보이는 편이에요.'],
      ['구성', '200매 대용량이라 데일리로 쓰려는 분들이 많이 볼 만한 느낌입니다.']
    ],
    photoTitle: '민트 네모패드, 사진으로 보면 이런 느낌',
    photoLead:
      '이 제품은 <span class="highlight">아쿠아 민트 통</span>이랑 <span class="highlight">큼직한 네모패드</span> 느낌이 먼저 보여야 예뻐요. 그래서 사진도 화장대, 욕실, 손등 컷처럼 실제 후기글에서 많이 보는 흐름으로 넣었습니다.',
    shoppingTitle: '예쁘다고 바로 누르기 전에, 옵션명은 한 번만 더 봐요',
    shoppingParagraphs: (post) => [
      `${htmlEscape(post.rawName)}처럼 상품명이 길면, 같은 메디힐 토너패드 안에서도 옵션이나 기획 구성이 달라질 수 있어요. 사진은 마음에 드는데 막상 들어가면 원하는 옵션이 없는 경우가 은근 있습니다.`,
      '그래서 저는 이런 올영픽 상품은 <span class="highlight">온라인 재고</span>랑 <span class="highlight">근처 매장 재고</span>를 같이 보는 쪽이 마음 편하다고 봐요.'
    ],
    checklist: [
      '메디힐 더마 토너패드 200매인지 상품명을 먼저 맞춰보기',
      '마데카소사이드, 티트리, 콜라겐처럼 옵션명이 다르면 다시 확인하기',
      '온라인 재고랑 근처 매장 재고를 따로 보기',
      '소량 재고면 다른 매장도 같이 열어두기'
    ],
    tipTitle: '마음에 들면, 재고는 바로 보는 게 좋아요',
    tipParagraph:
      '인기 있는 토너패드는 사진 보고 고민하는 사이에 옵션 재고가 바뀌기도 해요. 특히 대용량 기획은 한 번 품절되면 다시 들어올 때까지 기다려야 해서, 살 마음이 생겼다면 가볍게라도 체크해두는 게 좋습니다.',
    tips: [
      ['1. 상품명 길게 넣기', '메디힐 더마 토너패드 200매처럼 길게 검색하면 엉뚱한 상품이 덜 섞여요.'],
      ['2. 가까운 매장 먼저 보기', '오늘 들를 수 있는 매장부터 보면 시간 낭비가 확 줄어듭니다.'],
      ['3. 온라인도 같이 보기', '매장에 없으면 온라인 재고나 오늘드림 쪽이 더 빠를 때도 있어요.']
    ],
    captions: [
      ['첫 느낌', '민트 통 색감이 생각보다 산뜻해서 화장대 위에 올려두면 딱 깔끔해 보이는 느낌이에요.'],
      ['뚜껑 열면', '안쪽에 네모패드가 차곡차곡 보여서 대용량 느낌이 바로 와요. 이런 컷이 은근히 제일 궁금하죠.'],
      ['한 장 들어보면', '집게로 쓱 들어 올렸을 때 패드 표면이 촉촉하게 보여서 부분팩으로도 잘 어울릴 것 같은 무드예요.'],
      ['크기감', '손등 위에 올려보면 네모패드가 꽤 큼직해 보여요. 볼 쪽에 착 붙여두기 좋은 사이즈감입니다.'],
      ['욕실 컷', '세면대 옆에 두면 민트색이 확 살아나요. 패키지가 너무 튀지 않고 시원한 쪽이라 마음 편한 느낌.'],
      ['구성 느낌', '패드랑 파우치 느낌으로 같이 두면 기획세트 무드가 더 잘 보여요. 구성 옵션은 구매 전에 꼭 다시 봐야 해요.'],
      ['패드 결', '가까이 보면 엠보싱 결이 꽤 잘 보여요. 닦토로 쓸지, 잠깐 올려둘지 상상하게 되는 컷.'],
      ['두께감', '살짝 접힌 컷을 보면 너무 흐물흐물한 느낌은 아니고, 손에 잡히는 두께감이 있어 보여요.'],
      ['위에서 보기', '뚜껑을 열고 위에서 보면 한 장씩 꺼내 쓰는 구조가 딱 보여요. 매일 쓰는 패드는 이런 게 편하잖아요.'],
      ['붙였을 때', '얼굴 라인에 올린 느낌은 이런 무드. 민감한 날에는 자극 적은 더마패드 찾는 분들이 많아서 이 컷이 중요해요.'],
      ['루틴 안에', '세럼이랑 수건 옆에 두면 아침 루틴템 느낌이 납니다. 너무 광고컷 같지 않아서 더 자연스러워요.'],
      ['침구 플랫레이', '하얀 침구 위에 올려두니 색감이 더 맑아 보여요. 사진으로 봤을 때 청량한 느낌이 확 살아납니다.'],
      ['손에 들면', '손에 들었을 때 용기 크기가 딱 보여요. 올영픽 상품은 이런 상태에서 바로 재고 확인하고 움직이는 게 편해요.'],
      ['라벨 컷', '전면 라벨이 보이면 상품 찾기가 훨씬 쉬워요. 메디힐, 마데카소사이드, 더마패드 키워드가 눈에 들어옵니다.'],
      ['집게 컷', '뚜껑 열고 집게가 같이 보이는 컷은 사용 전 위생감까지 느껴져요. 이런 디테일 좋아하는 분들 많죠.'],
      ['사이즈 비교', '손바닥 옆에 두면 패드 크기가 더 잘 보여요. 82mm급 네모패드 느낌을 보고 싶다면 이 컷이 제일 직관적입니다.'],
      ['화장대 보관', '거울 옆에 열어두면 매일 꺼내 쓰는 패드 루틴템 느낌이 자연스럽게 나요.'],
      ['마지막 한 컷', '열린 통과 패드를 같이 두니 산뜻한 민트 무드가 마지막까지 잘 남아요.']
    ]
  },
  {
    id: 'mediheal-sun-serum',
    assetPrefix: 'mediheal-sun-serum',
    assetExt: 'jpg',
    detailFile: 'mediheal-sun-serum-detail-page-01.jpg',
    match: (post) => textOf(post).includes('메디힐') && textOf(post).includes('선세럼'),
    title: (shortName) => titleFor(shortName, '수분 선세럼 올리브영 재고'),
    description: (shortName) => descriptionFor(shortName, '흰 튜브, 민트 포인트, 촉촉한 선케어'),
    heroLead:
      '흰 튜브에 민트 포인트가 들어간 여름 선케어라 사진으로 봤을 때 첫인상이 꽤 맑아요. 기획 구성이라 옵션이 바뀌기 전에 재고까지 같이 보는 흐름으로 정리했습니다.',
    introBig: (shortName) =>
      `${htmlEscape(shortName)}, <span class="soft-word">흰 튜브에 민트 라인</span>이라 여름 느낌이 바로 나요.`,
    introBody: (post) =>
      `${post.rankingDateText} 기준 조회 인기 ${post.rank}위로 올라온 선케어라 관심이 확 붙은 상태예요. 50+50g 기획은 구성명이 길어서 구매 전에 같은 상품인지 한 번만 더 확인하는 게 좋아요.`,
    moodNotes: [
      ['색감', '화이트 튜브에 민트 포인트가 있어서 선케어인데 답답해 보이지 않아요.'],
      ['구성', '50+50g 기획이라 하나만 사는 느낌보다 쟁여두는 쪽에 가까워 보여요.'],
      ['계절감', '파란 배경이랑 잘 어울리는 여름 선세럼 무드라 검색에서 눈에 잘 띕니다.']
    ],
    photoTitle: '흰 튜브 선세럼, 사진으로 보면 이런 느낌',
    photoLead:
      '이 제품은 <span class="highlight">깨끗한 흰 튜브</span>랑 <span class="highlight">민트 세로 포인트</span>가 살아야 예뻐요. 그래서 파우치, 손등, 화장대 컷처럼 선세럼 후기에서 자주 보는 흐름으로 넣었습니다.',
    shoppingTitle: '기획 구성은 좋아 보일수록 옵션명을 꼭 봐요',
    shoppingParagraphs: (post) => [
      `${htmlEscape(post.rawName)}처럼 50+50g, 증정 구성, 올영픽이 같이 붙으면 같은 선세럼이어도 화면마다 구성 표현이 살짝 다를 수 있어요.`,
      '사진만 보고 바로 누르기보다는 <span class="highlight">온라인 재고</span>, <span class="highlight">오늘드림</span>, <span class="highlight">근처 매장 재고</span>를 한 번에 보는 쪽이 편합니다.'
    ],
    checklist: [
      '메디힐 마데카소사이드 수분 선세럼인지 상품명 맞추기',
      '50+50g 기획인지, 단품인지 옵션 확인하기',
      '선케어는 계절에 따라 품절 속도가 빨라질 수 있어서 재고 먼저 보기',
      '오늘 바로 쓸 거면 오늘드림/매장 픽업 가능 여부도 같이 보기'
    ],
    tipTitle: '선케어는 마음 생겼을 때 재고 먼저 보는 게 편해요',
    tipParagraph:
      '선세럼류는 날씨가 더워질수록 조회가 빠르게 붙어요. 특히 행사 묶음은 가격이 괜찮아 보이면 사람들이 바로 들어가니까, 마음에 들면 재고 확인을 먼저 열어두는 게 좋습니다.',
    tips: [
      ['1. 긴 상품명으로 검색', '마데카소사이드 수분 선세럼까지 넣으면 다른 선크림이 덜 섞여요.'],
      ['2. 기획/단품 구분', '50+50g인지 단품인지 먼저 맞추면 헷갈릴 일이 줄어듭니다.'],
      ['3. 받을 방식 고르기', '온라인, 오늘드림, 매장 픽업 중에 지금 제일 빠른 쪽을 보면 돼요.']
    ],
    captions: [
      ['기획 구성 첫 컷', '흰 튜브 두 개와 파란 증정품이 같이 보여서 기획 구성 느낌이 바로 와요.'],
      ['손에 든 튜브', '튜브를 손에 들었을 때 크기감이 보여서 파우치에 넣을지 감 잡기 좋습니다.'],
      ['두 튜브 나란히', '50+50g 기획은 두 개를 같이 세워두면 구성감이 가장 또렷해요.'],
      ['앰플과 플랫레이', '박스와 앰플을 같이 두니 선세럼 기획 상품 분위기가 자연스럽게 살아나요.'],
      ['캡 가까이', '투명한 민트 캡과 흰 튜브가 가까이 보이면 여름 선케어 무드가 더 산뜻해요.'],
      ['손등 제형', '손등 위에 살짝 올린 흰 제형이 보여서 촉촉한 선세럼 느낌을 보기 좋습니다.'],
      ['파우치 안 구성', '투명 파우치에 튜브와 미니템을 넣어두면 외출용 선케어 느낌이 잘 맞아요.'],
      ['창가 컷', '창가 빛이 들어오는 컷이랑 잘 어울려요. 선케어는 밝은 아침 느낌이 자연스럽죠.'],
      ['화장대 단독 컷', '거울 앞에 세워두니 흰 튜브와 민트 라인이 깔끔하게 보여요.'],
      ['바스켓 보관', '바구니 안에 튜브와 파우치를 같이 두면 휴대용 기획 구성처럼 보입니다.'],
      ['구성 한눈에', '튜브 두 개, 앰플, 파란 박스를 같이 놓으면 구매 전 구성 확인용으로 좋아요.'],
      ['손 위 제형', '튜브를 잡고 제형을 살짝 올린 컷이라 바르기 전 느낌을 상상하기 쉬워요.'],
      ['화장대 루틴', '스킨케어 제품 사이에 두어도 흰색이라 튀지 않고 데일리 루틴템처럼 보여요.'],
      ['타월 위 컷', '하얀 타월 위에 올려두면 튜브의 민트 포인트가 더 깨끗하게 살아나요.'],
      ['파우치 정리', '파우치 안에 넣어둔 컷은 여행이나 외출 전 챙기는 느낌이 있어요.'],
      ['캡 디테일', '캡을 가까이 보면 민트 컬러 포인트와 튜브형 용기가 한눈에 들어옵니다.'],
      ['휴대 전 메모', '휴대폰 옆에 두니 외출 전에 챙기는 선세럼 느낌이 자연스럽습니다.'],
      ['마지막 정리', '토너와 앰플 옆에 세워두면 기초 루틴 끝에 쓰는 선케어 분위기가 잘 남아요.']
    ]
  },
  {
    id: 'mediheal-gel-mask',
    assetPrefix: 'mediheal-gel-mask',
    assetExt: 'jpg',
    detailFile: 'mediheal-gel-mask-detail-page-01.jpg',
    match: (post) => textOf(post).includes('메디힐') && textOf(post).includes('겔마스크'),
    title: (shortName) => titleFor(shortName, '하이퍼 겔마스크 올리브영 재고'),
    description: (shortName) => descriptionFor(shortName, '핑크·보라·하늘색 박스, 촉촉한 겔마스크'),
    heroLead:
      '겔마스크는 색상 옵션이 여러 개라 사진으로 봤을 때 더 눈에 들어와요. 어떤 컬러 구성인지, 8+1 기획인지, 지금 재고가 있는지까지 같이 보려고 정리했습니다.',
    introBig: (shortName) =>
      `${htmlEscape(shortName)}, <span class="soft-word">핑크·보라·하늘색 팩</span>이 같이 보일 때 제일 예뻐요.`,
    introBody: (post) =>
      `${post.rankingDateText} 기준 조회 인기 ${post.rank}위로 잡힌 마스크팩이에요. 8+1 기획은 구성이 좋아 보이는 만큼 옵션 선택 화면에서 원하는 종류가 남아 있는지 보는 게 중요합니다.`,
    moodNotes: [
      ['컬러', '콜라겐, PDRN, 마데카소사이드, 히알루론산처럼 옵션 컬러가 달라서 사진 맛이 있어요.'],
      ['구성', '8+1 기획은 박스나 파우치가 여러 장 보일 때 한눈에 이해됩니다.'],
      ['느낌', '겔마스크 특유의 투명하고 말랑한 분위기가 보여야 관심이 오래 가요.']
    ],
    photoTitle: '겔마스크 색감, 사진으로 보면 이런 느낌',
    photoLead:
      '이 제품은 <span class="highlight">여러 컬러 팩</span>이랑 <span class="highlight">촉촉한 겔 시트</span> 느낌이 같이 보여야 예뻐요. 그래서 침구, 욕실, 파우치 컷처럼 후기글에서 많이 보는 장면으로 넣었습니다.',
    shoppingTitle: '겔마스크는 색상 옵션이 제일 헷갈려요',
    shoppingParagraphs: (post) => [
      `${htmlEscape(post.rawName)}처럼 4종 옵션과 8+1 기획이 함께 있으면, 상품 페이지에서 선택한 구성이 생각한 컬러와 다를 수 있어요.`,
      '구매 전에는 <span class="highlight">원하는 옵션명</span>, <span class="highlight">기획 매수</span>, <span class="highlight">근처 매장 재고</span>를 같이 보는 쪽이 안전합니다.'
    ],
    checklist: [
      '콜라겐/PDRN/마데카소사이드/히알루론산 중 원하는 옵션 확인하기',
      '8+1 기획인지 단품/다른 묶음인지 보기',
      '오늘 바로 쓸 거면 가까운 매장 재고부터 열기',
      '옵션별 품절이 있을 수 있으니 대체 컬러도 같이 보기'
    ],
    tipTitle: '팩 제품은 옵션별 재고가 따로 움직여요',
    tipParagraph:
      '마스크팩은 같은 상품명 안에서도 옵션별로 재고가 다르게 보일 수 있어요. 사진에서 마음에 든 컬러가 있다면 상품명만 보지 말고 옵션까지 맞춰서 확인하는 게 좋습니다.',
    tips: [
      ['1. 옵션명을 같이 보기', '콜라겐, PDRN, 마데카소사이드처럼 색상명이 섞이면 꼭 다시 봐야 해요.'],
      ['2. 가까운 매장 확인', '팩은 매장마다 옵션 재고 차이가 커서 주변 매장을 같이 보는 게 좋아요.'],
      ['3. 온라인도 열어두기', '원하는 옵션이 매장에 없으면 온라인 재고가 더 빠를 때도 있습니다.']
    ],
    captions: [
      ['컬러 첫 컷', '핑크, 보라, 하늘색 팩을 같이 두면 겔마스크 4종 분위기가 바로 보여요.'],
      ['손에 든 콜라겐', '핑크 콜라겐 팩을 손에 들면 패키지 크기와 컬러감이 한눈에 들어옵니다.'],
      ['네 가지 옵션', '거울 앞에 네 가지 컬러를 세워두면 옵션 비교가 가장 쉽습니다.'],
      ['겔 시트 느낌', '투명한 겔 시트를 꺼낸 컷이라 일반 시트팩과 다른 말랑한 느낌이 보여요.'],
      ['욕실 콜라겐', '세면대 옆에 세워두면 씻고 바로 붙이는 홈케어팩 분위기가 납니다.'],
      ['보라색 옵션', '보라색 PDRN 팩은 차분한 색감이라 플랫레이 컷에서 은근히 눈에 들어와요.'],
      ['파우치 속 팩', '파우치 안에 여러 장 넣어두면 여행이나 외출 때 챙기는 느낌이 자연스럽습니다.'],
      ['라벨 가까이', '핑크 겔 이미지가 크게 보이면 콜라겐 옵션을 구분하기 쉬워요.'],
      ['여러 장 쌓기', '박스로 여러 장 쌓아두면 8+1 기획 구성감이 딱 보여요.'],
      ['옵션 펼쳐보기', '박스와 팩을 같이 펼쳐두면 어떤 옵션을 고를지 비교하기 편합니다.'],
      ['손에 든 4종', '손에 네 가지 컬러를 들면 색상 차이가 한 번에 보여서 선택하기 쉬워요.'],
      ['구매 전 확인', '패키지 뒷면과 앞면을 같이 두면 옵션명과 기획 구성을 다시 보기 좋아요.'],
      ['겔 꺼내는 컷', '팩 안에서 투명 겔을 꺼내는 장면은 실제 후기글에서 가장 궁금한 포인트예요.'],
      ['서랍 보관', '여러 장 사두는 팩은 서랍에 컬러별로 정리한 컷도 꽤 자연스럽습니다.'],
      ['침구 위 4종', '하얀 침구 위에 네 가지 컬러를 놓으면 홈케어팩 느낌이 부드럽게 살아나요.'],
      ['오늘 쓸 한 장', '수건 옆에 콜라겐 팩 한 장만 꺼내두니 오늘 붙일 팩 고르는 느낌이에요.'],
      ['박스 가까이', '콜라겐과 PDRN 박스를 가까이 보면 옵션명이 또렷해서 상품 찾기가 쉬워요.'],
      ['마무리 정리', '거울 옆에 하늘색과 민트 옵션을 두면 촉촉한 겔마스크 무드가 잘 남아요.']
    ]
  },
  {
    id: 'tonymoly-shocking-lip-tint',
    assetPrefix: 'tonymoly-shocking-lip-tint',
    assetExt: 'jpg',
    detailFile: 'tonymoly-shocking-lip-tint-detail-page-01.jpg',
    match: (post) => textOf(post).includes('토니모리') && textOf(post).includes('쇼킹립') && textOf(post).includes('틴트'),
    title: (shortName) => titleFor(shortName, '쇼킹립 틴트 올리브영 재고'),
    description: (shortName) => descriptionFor(shortName, '코랄·레드 틴트 색감, 어플리케이터, 발색 스와치'),
    heroLead:
      '알로하선셋 무드라 코랄, 레드, 버건디 색감이 먼저 눈에 들어와요. 립 제품은 색상 옵션이 많아서 사진으로 느낌을 보고 재고까지 같이 확인하는 흐름이 편합니다.',
    introBig: (shortName) =>
      `${htmlEscape(shortName)}, <span class="soft-word">쨍한 립 컬러</span>가 여름 느낌으로 확 보여요.`,
    introBody: (post) =>
      `${post.rankingDateText} 기준 조회 인기 ${post.rank}위로 올라온 립틴트예요. 컬러가 여러 개라 예쁜 색 먼저 고르고, 옵션명이 남아 있는지 바로 확인하는 게 좋습니다.`,
    moodNotes: [
      ['색감', '코랄, 오렌지, 레드, 버건디 계열이 같이 보이면 선택지가 한눈에 들어와요.'],
      ['발색', '립틴트는 팔목 스와치랑 어플리케이터 컷이 있어야 감이 빨리 와요.'],
      ['옵션', '컬러명이 많아서 구매 전 선택 옵션을 꼭 한 번 더 보는 편이 좋아요.']
    ],
    photoTitle: '쇼킹립 틴트, 색감은 이런 느낌',
    photoLead:
      '이 제품은 <span class="highlight">작은 틴트 튜브</span>랑 <span class="highlight">코랄·레드 스와치</span>가 보여야 예뻐요. 그래서 파우치, 화장대, 어플리케이터 컷처럼 립틴트 후기에서 많이 보는 장면으로 넣었습니다.',
    shoppingTitle: '립틴트는 컬러 옵션을 꼭 맞춰봐요',
    shoppingParagraphs: (post) => [
      `${htmlEscape(post.rawName)}처럼 에디션과 컬러가 같이 붙은 립 제품은 들어가서 고른 색상이 생각한 색과 다를 수 있어요.`,
      '사진으로 마음에 든 컬러가 있으면 <span class="highlight">옵션명</span>, <span class="highlight">온라인 재고</span>, <span class="highlight">근처 매장 재고</span>를 같이 보는 게 편합니다.'
    ],
    checklist: [
      '토니모리 퍼펙트립스 쇼킹립 틴트인지 상품명 맞추기',
      '코랄/오렌지/레드/버건디 계열 중 원하는 컬러 옵션 확인하기',
      '온라인 재고와 가까운 매장 재고를 같이 보기',
      '립 제품은 컬러별 품절이 있을 수 있으니 대체 컬러도 열어두기'
    ],
    tipTitle: '색 예쁜 립은 옵션별 재고가 따로 움직여요',
    tipParagraph:
      '립틴트는 인기 컬러부터 먼저 빠지는 경우가 많아요. 사진에서 마음에 든 컬러가 있다면 상품명만 보지 말고 옵션명까지 맞춰서 재고를 확인하는 게 좋습니다.',
    tips: [
      ['1. 쇼킹립 틴트까지 넣기', '브랜드명만 검색하면 다른 립 제품이 많이 섞일 수 있어요.'],
      ['2. 컬러명 확인', '비슷한 레드라도 옵션명이 다르면 실제 색감이 꽤 달라요.'],
      ['3. 매장 픽업도 보기', '오늘 써보고 싶은 립은 가까운 매장 재고가 제일 빠릅니다.']
    ],
    captions: [
      ['컬러 한눈컷', '코랄부터 버건디까지 쭉 놓으면 컬러감이 바로 보여요. 립틴트는 이런 첫 컷이 제일 편합니다.'],
      ['손에 든 코랄', '작은 틴트 튜브라 손에 들었을 때 크기감이 딱 보여요. 파우치에 넣기도 좋아 보입니다.'],
      ['어플리케이터', '팁에 묻은 레드빛 컬러가 보이면 제형과 발색감을 상상하기 쉬워요.'],
      ['팔목 스와치', '오렌지, 레드, 베리톤을 나란히 보면 원하는 색을 고르기 훨씬 쉬워집니다.'],
      ['파우치 컬러들', '파우치 안에 여러 컬러를 넣어두면 매일 고르는 립틴트 느낌이 나요.'],
      ['거울 옆 단독컷', '화장대 거울 옆에 한 컬러만 세워도 데일리 메이크업템 무드가 살아납니다.'],
      ['컬러표 느낌', '컬러명과 스와치를 같이 두면 옵션 고를 때 도움이 됩니다.'],
      ['썸머 무드', '오렌지 소품이랑 두면 알로하선셋 에디션 느낌이 더 잘 보여요.'],
      ['플랫레이 컷', '쿠션과 브러시 옆에 두면 실제 화장대 위 립틴트처럼 자연스럽습니다.'],
      ['파우치 안 정리', '여러 개를 넣어둔 컷은 색상 고민하는 느낌이 자연스럽습니다.'],
      ['단독 트레이 컷', '한 가지 컬러만 깔끔하게 세워두면 용기 모양과 라벨이 또렷하게 보여요.'],
      ['글로시한 발색', '윤기 있는 팔목 스와치가 보이면 촉촉한 틴트 무드가 잘 살아나요.'],
      ['오픈 컷', '뚜껑을 열어 둔 컷은 어플리케이터와 용기 입구를 같이 볼 수 있어 좋아요.'],
      ['거울 앞 컬러 비교', '여러 컬러를 거울 앞에 세워두면 톤 차이가 한 번에 들어옵니다.'],
      ['세 가지 톤', '코랄, 레드, 딥레드가 같이 보이면 어떤 분위기로 바를지 고르기 쉬워요.'],
      ['타월 위 컬러', '오렌지 타월 위에 올리면 따뜻한 여름 립 컬러 느낌이 잘 살아납니다.'],
      ['구매 전 확인', '영수증 옆에 두면 올영에서 옵션과 가격을 다시 확인하는 장면처럼 보여요.'],
      ['마지막 코랄', '거울 옆 코랄 톤으로 마무리하면 데일리 립틴트 느낌이 오래 남아요.']
    ]
  },
  {
    id: 'mediheal-repair-serum',
    assetPrefix: 'mediheal-repair-serum',
    assetExt: 'jpg',
    detailFile: 'mediheal-repair-serum-detail-page-01.jpg',
    match: (post) => textOf(post).includes('메디힐') && textOf(post).includes('흔적 리페어 세럼') && !textOf(post).includes('선세럼'),
    title: (shortName) => titleFor(shortName, '흔적 리페어 세럼 올리브영 재고'),
    description: (shortName) => descriptionFor(shortName, '검정 스포이드 병, 청록 라벨, 랩핑 세럼 마스크 구성'),
    heroLead:
      '검정 스포이드 병에 청록 라벨이 들어가서 메디힐 흔적 세럼 라인 느낌이 또렷해요. 더블 기획에 마스크 증정까지 붙어 있어서 구성 확인이 중요합니다.',
    introBig: (shortName) =>
      `${htmlEscape(shortName)}, <span class="soft-word">청록 라벨 세럼</span>이라 사진에서 바로 보여요.`,
    introBody: (post) =>
      `${post.rankingDateText} 기준 조회 인기 ${post.rank}위로 올라온 세럼입니다. 40+40mL 구성에 랩핑 세럼 마스크까지 붙은 기획이라, 구매 전 옵션과 재고를 같이 보는 게 좋아요.`,
    moodNotes: [
      ['패키지', '검정 병과 청록 라벨 조합이라 다른 메디힐 제품이랑도 구분이 쉬워요.'],
      ['구성', '세럼 더블 구성에 마스크 증정이 붙어 상품명 확인이 중요합니다.'],
      ['제형', '스포이드 컷이 있으면 세럼 제형과 루틴 느낌이 바로 살아나요.']
    ],
    photoTitle: '메디힐 흔적 세럼, 사진으로 보면 이런 느낌',
    photoLead:
      '이 제품은 <span class="highlight">검정 스포이드 병</span>과 <span class="highlight">청록 라벨</span>이 살아야 예뻐요. 세럼 병, 랩핑 마스크, 손등 제형 컷을 같이 넣어서 구성감이 보이게 했습니다.',
    shoppingTitle: '더블 세럼 구성은 상품명을 끝까지 봐요',
    shoppingParagraphs: (post) => [
      `${htmlEscape(post.rawName)}처럼 40+40mL와 마스크 증정이 같이 붙으면 단품과 기획 구성이 헷갈릴 수 있어요.`,
      '구매 전에는 <span class="highlight">기획 구성</span>, <span class="highlight">온라인 재고</span>, <span class="highlight">근처 매장 재고</span>를 같이 보는 쪽이 마음 편합니다.'
    ],
    checklist: [
      '메디힐 마데카소사이드 흔적 리페어 세럼인지 상품명 맞추기',
      '40+40mL 더블 기획과 랩핑 세럼 마스크 증정 구성 확인하기',
      '온라인 재고와 오늘드림 가능 여부 보기',
      '가까운 매장 재고도 같이 열어두기'
    ],
    tipTitle: '세럼 기획은 구성 차이가 은근 커요',
    tipParagraph:
      '같은 세럼이라도 단품, 더블 기획, 증정 구성에 따라 구매 만족도가 달라질 수 있어요. 마음에 드는 구성이 보이면 재고부터 빠르게 확인하는 게 좋습니다.',
    tips: [
      ['1. 흔적 리페어 세럼까지 검색', '마데카소사이드만 검색하면 선세럼이나 마스크팩도 같이 섞일 수 있어요.'],
      ['2. 40+40mL 확인', '기획 구성인지 단품인지 먼저 맞추면 실수가 줄어듭니다.'],
      ['3. 마스크 증정 보기', '증정 구성은 시기별로 바뀔 수 있어 구매 화면에서 마지막으로 확인해야 해요.']
    ],
    captions: [
      ['첫 컷', '검정 병 두 개를 세워두면 더블 기획 느낌이 바로 보여요.'],
      ['손에 들면', '청록 라벨이 선명해서 제품명이 눈에 잘 들어옵니다.'],
      ['라벨 가까이', 'Madecassoside, 20612, MEDIHEAL 라인이 보이면 상품 찾기가 쉬워요.'],
      ['스포이드', '스포이드에 맺힌 제형을 보면 세럼 제품이라는 게 확 느껴져요.'],
      ['마스크 구성', '랩핑 세럼 마스크를 같이 두면 기획세트 무드가 살아납니다.'],
      ['타월 위', '하얀 타월 위에 두면 검정 병과 청록 라벨이 더 또렷해 보여요.'],
      ['서랍 보관', '기초 제품 서랍 안에 넣어둔 컷은 쟁여둔 느낌이 자연스럽습니다.'],
      ['거울 앞', '화장대 거울 앞에 세워두면 아침 루틴템처럼 보여요.'],
      ['창가 컷', '창가 빛에 두면 병 색감과 라벨이 깨끗하게 살아납니다.'],
      ['파우치 안', '파우치에 세럼과 마스크를 같이 넣으면 구성 확인이 쉬워요.'],
      ['뚜껑 위주', '검정 스포이드 캡을 가까이 보면 세럼 라인 느낌이 더 강해요.'],
      ['마스크 패키지', '랩핑 세럼 마스크 포장이 같이 보이면 증정 구성 확인이 쉬워요.'],
      ['두 병 구성', '두 병을 나란히 들면 40+40mL 기획이라는 게 바로 보여요.'],
      ['손등 제형', '손등 위에 투명한 세럼을 올려두면 제형 느낌을 가볍게 상상하기 좋아요.'],
      ['트레이 두 병', '마블 트레이 위에 두 병을 놓으면 청록 라벨이 깔끔하게 돋보입니다.'],
      ['영수증 옆', '방금 올영에서 사온 듯한 생활감 있는 컷도 자연스러워요.'],
      ['보관 컷', '마스크팩과 세럼을 서랍에 같이 넣으면 세트 구성 느낌이 잘 납니다.'],
      ['마지막 컷', '검정 병 하나만 세워도 청록 라벨 덕분에 제품 인상이 또렷하게 남아요.']
    ]
  },
  {
    id: 'mediheal-essential-mask-pack-217620',
    assetPrefix: 'mediheal-mask-pack-stock-a000000217620',
    assetExt: 'png',
    detailFile: 'mediheal-mask-pack-stock-a000000217620-detail-page-01.png',
    match: (post) => post.slug === 'mediheal-mask-pack-stock-a000000217620',
    title: (shortName) => titleFor(shortName, '마스크팩 올리브영 재고'),
    description: (shortName) => descriptionFor(shortName, '메디힐 컬러별 1매 마스크팩, 로즈 PDRN·마데카소사이드·세라마이드·티트리·히알루로네이트 옵션'),
    heroLead:
      '메디힐 에센셜 마스크팩은 컬러별 파우치가 한눈에 들어오는 상품이라 사진으로 옵션을 먼저 보는 게 편해요. 7종 골라담기라 원하는 옵션과 재고를 같이 확인하면 좋습니다.',
    introBig: (shortName) =>
      `${htmlEscape(shortName)}, <span class="soft-word">컬러별 1매 파우치</span>가 쭉 보이는 타입이에요.`,
    introBody: (post) =>
      `${post.rankingDateText} 기준 조회 인기 ${post.rank}위로 올라온 마스크팩이에요. 로즈 PDRN, 마데카소사이드, 세라마이드처럼 옵션이 여러 개라 사진으로 색을 먼저 보고 재고를 보는 흐름이 편합니다.`,
    moodNotes: [
      ['옵션', '핑크, 청록, 노랑, 초록, 하늘색 파우치가 있어서 옵션 비교가 먼저 눈에 들어와요.'],
      ['구성', '1매 골라담기 상품이라 원하는 파우치 옵션이 남아 있는지 확인하는 게 중요합니다.'],
      ['사용 전', '파우치와 시트 가장자리가 보이면 실제 마스크팩 느낌이 더 자연스럽게 살아나요.']
    ],
    photoTitle: '메디힐 에센셜 마스크팩, 사진으로 보면 이런 느낌',
    photoLead:
      '이 제품은 <span class="highlight">컬러별 파우치 옵션</span>과 <span class="highlight">1매 마스크팩 느낌</span>이 같이 보여야 예뻐요. 그래서 침구, 욕실, 파우치, 서랍 보관 컷처럼 후기글에서 자주 보는 장면으로 넣었습니다.',
    shoppingTitle: '마스크팩은 옵션별 재고를 꼭 따로 봐요',
    shoppingParagraphs: (post) => [
      `${htmlEscape(post.rawName)}처럼 7종 골라담기 상품은 같은 상품명이어도 선택 옵션에 따라 재고가 다르게 보일 수 있어요.`,
      '사진으로 마음에 든 옵션이 있으면 <span class="highlight">옵션명</span>, <span class="highlight">온라인 재고</span>, <span class="highlight">근처 매장 재고</span>를 같이 확인하는 게 좋습니다.'
    ],
    checklist: [
      '메디힐 에센셜 마스크팩 1매 상품명 확인하기',
      '로즈 PDRN/마데카소사이드/세라마이드/티트리/히알루로네이트 옵션 확인하기',
      '옵션별 온라인 재고와 매장 재고 같이 보기',
      '여러 장 담을 경우 대체 옵션도 같이 열어두기'
    ],
    tipTitle: '팩은 색상 옵션별로 품절 흐름이 달라요',
    tipParagraph:
      '마스크팩은 같은 라인 안에서도 옵션별 관심도가 달라서 재고가 따로 움직일 수 있어요. 사진에서 고른 파우치 이름을 구매 화면에서 한 번 더 맞춰보면 실수가 줄어듭니다.',
    tips: [
      ['1. 옵션명을 같이 보기', '마데카소사이드, 로즈 PDRN처럼 옵션명이 길어도 같이 봐야 헷갈리지 않아요.'],
      ['2. 여러 장 담기 전 확인', '골라담기라면 선택한 옵션이 모두 재고 있는지 마지막에 다시 보는 게 좋습니다.'],
      ['3. 가까운 매장 확인', '오늘 쓰고 싶은 팩은 가까운 매장 재고나 오늘드림 가능 여부를 같이 보면 편해요.']
    ],
    captions: [
      ['옵션 한눈컷', '여러 컬러 파우치를 쭉 놓으면 골라담기 상품이라는 느낌이 바로 보여요.'],
      ['마데카 손에 들기', '청록색 마데카소사이드 파우치는 손에 들었을 때 색과 크기가 또렷하게 보입니다.'],
      ['로즈 PDRN', '핑크 로즈 PDRN 파우치는 타월 위에서 부드러운 홈케어팩 분위기가 나요.'],
      ['거울 앞 옵션', '거울 앞에 여러 컬러를 세워두면 옵션 비교가 가장 쉽습니다.'],
      ['파우치 속 팩', '파우치 안에 몇 장 넣어두면 여행이나 외출 때 챙기는 느낌이 자연스러워요.'],
      ['라벨 가까이', '마데카소사이드 이름과 패키지 그림을 가까이 보면 상품 찾기가 쉬워집니다.'],
      ['시트 살짝 보기', '파우치에서 흰 시트가 살짝 보이면 실제 마스크팩 느낌이 살아나요.'],
      ['손에 든 로즈', '로즈 PDRN 한 장만 들어도 핑크 파우치 색감이 먼저 눈에 들어옵니다.'],
      ['구매 전 확인', '영수증 옆에 두면 옵션과 수량을 다시 체크하는 장면처럼 보여요.'],
      ['침구 위 옵션', '하얀 침구 위에 컬러별 파우치를 펼치면 선택지가 깔끔하게 보입니다.'],
      ['서랍 보관', '서랍 안에 옵션별로 넣어두면 여러 장 쟁여둔 느낌이 자연스럽습니다.'],
      ['세라마이드 옵션', '노란 세라마이드 파우치는 욕실 조명에서도 산뜻하게 보여요.'],
      ['히알루로네이트', '하늘색 히알루로네이트 파우치는 물컵 옆에서 촉촉한 무드가 잘 살아납니다.'],
      ['티트리 타월컷', '초록 티트리 파우치는 하얀 타월 위에서 차분하게 보여요.'],
      ['두 가지 비교', '로즈와 마데카소사이드를 같이 세우면 컬러 차이가 바로 들어옵니다.'],
      ['시트 확인', '접힌 시트가 보이는 컷은 실제 붙이기 전 느낌을 상상하기 좋아요.'],
      ['골라담기 느낌', '여러 파우치를 겹쳐 들면 7종 골라담기 분위기가 잘 납니다.'],
      ['마지막 정리', '세 가지 옵션을 세워두면 마스크팩 라인의 산뜻한 느낌이 남아요.']
    ]
  },
  {
    id: 'arencia-fresh-cleanser-214907',
    assetPrefix: 'oliveyoung-cleanser-stock-a000000214907',
    assetExt: 'png',
    detailFile: 'oliveyoung-cleanser-stock-a000000214907-detail-page-01.png',
    match: (post) => post.slug === 'oliveyoung-cleanser-stock-a000000214907',
    title: (shortName) => titleFor(shortName, '떡솝 클렌저 올리브영 재고'),
    description: (shortName) => descriptionFor(shortName, '아렌시아 파스텔 3종 클렌저, 그린·로즈힙·블루히솝 용기와 휘핑 제형'),
    heroLead:
      '파스텔 단지에 휘핑처럼 올라온 제형이 딱 보이는 클렌저라 사진으로 먼저 보면 훨씬 감이 와요. 그린, 로즈힙, 블루히솝 3종 기획이라 옵션명과 재고를 같이 확인하기 좋게 정리했습니다.',
    introBig: (shortName) =>
      `${htmlEscape(shortName)}, <span class="soft-word">파스텔 떡솝 단지</span>가 너무 말랑하게 보여요.`,
    introBody: (post) =>
      `${post.rankingDateText} 기준 조회 인기 ${post.rank}위로 잡힌 클렌저예요. 그린, 로즈힙, 블루히솝 3종이 같이 보이는 상품이라 사진으로 색을 먼저 보고 옵션 재고를 보는 흐름이 편합니다.`,
    moodNotes: [
      ['색감', '연두, 핑크, 하늘색 단지가 같이 있으면 아렌시아 떡솝 특유의 말랑한 분위기가 바로 보여요.'],
      ['제형', '뚜껑을 열었을 때 휘핑처럼 올라온 텍스처가 보여야 클렌저 느낌이 확 살아납니다.'],
      ['구성', '120g 본품에 15g 증정 기획 느낌이 있어서 작은 미니 단지까지 같이 보면 좋아요.']
    ],
    photoTitle: '아렌시아 떡솝 클렌저, 사진으로 보면 이런 느낌',
    photoLead:
      '이 제품은 <span class="highlight">파스텔 원형 단지</span>랑 <span class="highlight">휘핑 제형</span>이 같이 보여야 예뻐요. 그래서 욕실, 수건, 스패출러, 파우치 컷처럼 후기글에서 자연스럽게 볼 만한 장면으로 넣었습니다.',
    shoppingTitle: '떡솝은 색상 옵션과 기획 구성을 같이 봐요',
    shoppingParagraphs: (post) => [
      `${htmlEscape(post.rawName)}처럼 그린, 로즈힙, 블루히솝 3종이 같이 있는 상품은 옵션에 따라 원하는 색이 달라질 수 있어요.`,
      '사진으로 마음에 드는 색을 골랐다면 <span class="highlight">옵션명</span>, <span class="highlight">15g 증정 구성</span>, <span class="highlight">근처 매장 재고</span>까지 같이 확인하는 게 좋습니다.'
    ],
    checklist: [
      '아렌시아 떡솝 프레시 클렌저 120g 상품명 확인하기',
      '그린/로즈힙/블루히솝 중 원하는 옵션명 맞추기',
      '15g 증정 기획 구성인지 구매 화면에서 다시 보기',
      '온라인 재고와 가까운 매장 재고 같이 확인하기'
    ],
    tipTitle: '클렌저도 옵션 색상별로 재고가 따로 움직여요',
    tipParagraph:
      '이런 3종 클렌저는 사진으로는 한 세트처럼 보여도 구매 화면에서는 옵션을 따로 고르는 경우가 많아요. 마음에 드는 색이 있으면 옵션명을 한 번 더 보고 재고를 여는 게 실수가 적습니다.',
    tips: [
      ['1. 아렌시아 떡솝까지 검색', '아렌시아만 검색하면 다른 라인이 같이 섞일 수 있어요.'],
      ['2. 색상 옵션 확인', '그린, 로즈힙, 블루히솝 중 원하는 색을 먼저 정해두면 편합니다.'],
      ['3. 증정 구성 보기', '15g 증정 기획은 행사에 따라 달라질 수 있으니 구매 화면에서 다시 봐야 해요.']
    ],
    captions: [
      ['3종 첫 컷', '연두, 핑크, 하늘색 단지가 같이 보이니까 떡솝 3종 느낌이 바로 와요.'],
      ['그린 제형', '뚜껑을 열면 휘핑처럼 올라온 그린 제형이 보여서 클렌저 느낌이 확 살아납니다.'],
      ['로즈힙 컷', '핑크 단지와 스패출러를 같이 두면 로즈힙 옵션의 부드러운 무드가 잘 보여요.'],
      ['블루히솝', '하늘색 단지는 세면대 옆에 두니 시원하고 산뜻한 느낌이 나요.'],
      ['손에 들면', '손에 들었을 때 단지 크기가 보여서 120g 용량감 보기에 좋습니다.'],
      ['제형 가까이', '스패출러에 올라온 핑크 제형을 가까이 보면 꾸덕한 텍스처가 잘 보여요.'],
      ['파우치 구성', '투명 파우치 안에 본품과 미니 단지를 넣으니 기획 구성 느낌이 자연스럽습니다.'],
      ['욕실 보관', '샤워 선반에 3종을 나란히 두면 매일 쓰는 클렌저처럼 보여요.'],
      ['거품 느낌', '손바닥의 가벼운 거품과 열린 단지를 같이 두면 클렌징 전 느낌이 잘 납니다.'],
      ['위에서 보기', '세 가지 제형과 뚜껑을 위에서 보면 색 차이가 한눈에 들어와요.'],
      ['라벨 확인', '닫힌 그린 단지는 Arencia 라벨과 원형 용기 모양이 깔끔하게 보여요.'],
      ['퍼프 옆 컷', '블루히솝 단지 옆에 젖은 퍼프와 타월을 두니 세안템 분위기가 살아납니다.'],
      ['미니 증정', '작은 미니 단지를 같이 두면 15g 증정 기획 느낌을 확인하기 좋아요.'],
      ['떠낸 제형', '그린 제형을 살짝 떠낸 컷은 실제 사용 전 가장 궁금한 장면이에요.'],
      ['구매 전 확인', '영수증과 휴대폰 옆에 두면 옵션과 재고를 다시 보는 장면처럼 자연스러워요.'],
      ['서랍 보관', '욕실장 안에 넣어두면 여러 옵션을 쟁여둔 느낌이 깔끔하게 보여요.'],
      ['블루 클로즈업', '물방울이 살짝 있는 블루 단지는 상쾌한 세안 무드가 잘 맞아요.'],
      ['마지막 정리', '거울 옆에 3종을 모아두니 파스텔 클렌저 라인 느낌이 예쁘게 남습니다.']
    ]
  },
  {
    id: 'peripera-ink-pocket-palette',
    assetPrefix: 'peripera-hot-item-stock-a000000124399',
    assetExt: 'png',
    detailFile: 'peripera-hot-item-stock-a000000124399-detail-page-01.png',
    match: (post) => textOf(post).includes('페리페라') && textOf(post).includes('잉크 포켓 섀도우 팔레트'),
    title: (shortName) => titleFor(shortName, '팔레트 올리브영 재고'),
    description: (shortName) => descriptionFor(shortName, '핑크 투명 4구 팔레트, 피치·브라운 섀도우, 애교살 스틱 증정'),
    heroLead:
      '핑크 투명 케이스에 피치, 로즈, 브라운 컬러가 들어간 작은 4구 팔레트라 사진으로 봤을 때 분위기가 바로 보여요. 애교살 스틱 증정 기획이라 구성까지 같이 확인하면 편합니다.',
    introBig: (shortName) =>
      `${htmlEscape(shortName)}, <span class="soft-word">핑크 4구 팔레트</span>라 일단 귀엽게 눈에 들어와요.`,
    introBody: (post) =>
      `${post.rankingDateText} 기준 조회 인기 ${post.rank}위 상품이에요. 작은 팔레트에 애교살 스틱 증정이 붙은 기획이라, 색감과 구성명을 같이 보고 재고를 확인하는 게 좋습니다.`,
    moodNotes: [
      ['색감', '피치 베이지, 로즈 핑크, 브라운 조합이라 데일리 눈화장 분위기가 부드럽게 보여요.'],
      ['구성', '팔레트 단품만 볼 게 아니라 애교살 스틱 증정 여부까지 같이 보는 게 포인트예요.'],
      ['크기', '손에 든 컷이나 파우치 컷이 있으면 작은 포켓 팔레트 느낌이 잘 살아납니다.']
    ],
    photoTitle: '페리페라 포켓 팔레트, 사진으로 보면 이런 느낌',
    photoLead:
      '이 제품은 <span class="highlight">투명 핑크 4구 팔레트</span>와 <span class="highlight">애교살 스틱</span>이 같이 보여야 예뻐요. 그래서 손에 든 컷, 스와치, 파우치, 화장대 컷처럼 후기글에 자연스러운 장면으로 넣었습니다.',
    shoppingTitle: '팔레트는 컬러명과 증정 구성을 같이 봐요',
    shoppingParagraphs: (post) => [
      `${htmlEscape(post.rawName)}처럼 올영픽이나 증정 문구가 붙은 상품은 같은 팔레트라도 구성명이 달라질 수 있어요.`,
      '사진으로 색감이 마음에 들면 <span class="highlight">옵션명</span>, <span class="highlight">증정 스틱</span>, <span class="highlight">근처 매장 재고</span>를 같이 보는 쪽이 편합니다.'
    ],
    checklist: [
      '페리페라 잉크 포켓 섀도우 팔레트인지 상품명 확인하기',
      '원하는 컬러 옵션과 애교살 스틱 증정 여부 보기',
      '온라인 재고와 가까운 매장 재고 같이 확인하기',
      '메이크업 제품은 옵션별 품절이 있을 수 있으니 대체 옵션도 열어두기'
    ],
    tipTitle: '작은 팔레트는 옵션명이 은근 헷갈려요',
    tipParagraph:
      '섀도우 팔레트는 비슷한 핑크·피치 톤이라도 옵션명이 다르면 분위기가 달라질 수 있어요. 사진에서 마음에 든 색감이 있다면 구매 화면에서 옵션명을 한 번 더 맞춰보는 게 좋습니다.',
    tips: [
      ['1. 잉크 포켓 팔레트까지 검색', '페리페라 팔레트만 검색하면 다른 라인이 같이 섞일 수 있어요.'],
      ['2. 증정 구성 확인', '애교살 스틱 증정은 행사에 따라 달라질 수 있어 구매 화면에서 다시 봐야 해요.'],
      ['3. 매장 재고도 보기', '색조는 인기 옵션부터 빠질 수 있어 가까운 매장 재고를 같이 보는 편이 좋아요.']
    ],
    captions: [
      ['화장대 첫 컷', '투명 핑크 케이스와 4구 컬러가 화장대 위에서 바로 눈에 들어와요.'],
      ['손에 든 팔레트', '손에 들면 포켓 팔레트라는 크기감이 잘 보여서 구매 전 느낌 잡기 좋아요.'],
      ['오픈 팔레트', '뚜껑을 열어두면 피치, 로즈, 브라운 컬러 구성이 한눈에 보입니다.'],
      ['스틱 구성', '팔레트 옆에 애교살 스틱을 같이 두면 증정 기획 느낌이 자연스럽게 살아나요.'],
      ['팔목 스와치', '베이지, 로즈, 브라운 발색을 나란히 보면 데일리 톤인지 바로 감이 옵니다.'],
      ['타월 위 플랫레이', '하얀 타월 위에 두면 핑크 투명 케이스가 더 부드럽게 보여요.'],
      ['파우치 속 팔레트', '파우치 안에 팔레트와 스틱을 같이 넣으면 휴대하기 좋은 느낌이 납니다.'],
      ['거울 앞 세팅', '거울 앞에 팔레트와 스틱을 세워두면 아침 메이크업 준비 컷처럼 보여요.'],
      ['구매 전 확인', '영수증 옆에 두면 올영에서 옵션과 증정 구성을 다시 확인하는 장면처럼 자연스러워요.'],
      ['브러시 가까이', '브러시가 쉬머 컬러에 닿은 컷은 섀도우 질감이 제일 잘 보여요.'],
      ['두께감 보기', '옆에서 보면 작은 팔레트 두께와 투명 케이스 느낌이 잘 살아납니다.'],
      ['원형 파우치', '작은 파우치에 들어간 컷은 포켓 팔레트라는 이름과 잘 맞아요.'],
      ['트레이 위 구성', '스틱과 브러시를 같이 두면 눈화장 준비물이 깔끔하게 정리돼 보여요.'],
      ['메이크업 준비', '브러시로 컬러를 찍는 장면은 실제 쓰기 전 분위기를 상상하기 좋습니다.'],
      ['피치 무드', '복숭아 톤 소품과 두면 팔레트의 부드러운 피치 색감이 더 살아나요.'],
      ['타월 단독컷', '팔레트만 하얀 타월 위에 두어도 색 구성이 또렷하게 보여요.'],
      ['스와치 가까이', '팔목 스와치와 팔레트를 같이 두면 실제 발색을 비교하기 편합니다.'],
      ['마지막 정리', '거울 옆에 팔레트와 스틱을 세워두면 데일리 메이크업템 느낌으로 마무리돼요.']
    ]
  },
  {
    id: 'foddle-cleansing-balm',
    assetPrefix: 'foddle-cleansing-balm',
    assetExt: 'jpg',
    detailFile: 'foddle-cleansing-balm-detail-page-01.jpg',
    match: (post) => textOf(post).includes('포들') && (textOf(post).includes('클렌징밤') || textOf(post).includes('밤투폼')),
    title: (shortName) => titleFor(shortName, '밤투폼 클렌징밤 올리브영 재고'),
    description: (shortName) => descriptionFor(shortName, '크림색 단지, 밤 제형, 미니 밤투폼 구성'),
    heroLead:
      '크림색 단지에 PO:DL 로고가 깔끔하게 들어간 클렌징밤이라 욕실 컷이 잘 어울려요. 단독기획과 미니 증정 구성이 붙어 있어 재고 확인까지 같이 보기 좋습니다.',
    introBig: (shortName) =>
      `${htmlEscape(shortName)}, <span class="soft-word">하얀 단지 밤 제형</span>이 먼저 보여요.`,
    introBody: (post) =>
      `${post.rankingDateText} 기준 조회 인기 ${post.rank}위로 올라온 클렌징밤이에요. 대용량 기획에 미니 밤투폼 구성이 붙어 있어서 상품명과 구성 확인을 같이 하는 게 편합니다.`,
    moodNotes: [
      ['패키지', '크림색 넓은 단지에 PO:DL 로고가 들어가서 욕실에 둬도 깔끔해 보여요.'],
      ['제형', '밤 제형과 스패출러 컷이 있으면 클렌징밤 느낌이 바로 살아납니다.'],
      ['구성', '미니 밤투폼 증정이 붙은 기획이라 구성 확인이 중요해요.']
    ],
    photoTitle: '포들 클렌징밤, 사진으로 보면 이런 느낌',
    photoLead:
      '이 제품은 <span class="highlight">크림색 PO:DL 단지</span>와 <span class="highlight">베이지 밤 제형</span>이 보여야 예뻐요. 욕실, 스패출러, 미니 샘플 컷처럼 클렌징밤 후기에서 자연스러운 장면으로 넣었습니다.',
    shoppingTitle: '클렌징밤은 용량과 증정 구성을 같이 봐요',
    shoppingParagraphs: (post) => [
      `${htmlEscape(post.rawName)}처럼 130ml 기획과 미니 밤투폼 증정이 붙으면 단품과 구성 차이가 있을 수 있어요.`,
      '바로 누르기 전에는 <span class="highlight">용량</span>, <span class="highlight">증정품</span>, <span class="highlight">매장 재고</span>를 같이 보면 실수가 줄어듭니다.'
    ],
    checklist: [
      '포들 2엑스 프레시밤 밤투폼 클렌징밤인지 상품명 확인하기',
      '130ml 기획과 미니 밤투폼 3개 증정 구성이 맞는지 보기',
      '오늘드림/온라인 재고와 근처 매장 재고 같이 보기',
      '클렌징밤은 무게감이 있어서 픽업 가능 매장도 같이 확인하기'
    ],
    tipTitle: '클렌징밤 기획은 증정 구성이 포인트예요',
    tipParagraph:
      '대용량 클렌징밤은 한 번 사면 오래 쓰는 제품이라 구성 차이가 꽤 중요해요. 미니 증정이 마음에 들면 재고가 있을 때 바로 확인해두는 게 좋습니다.',
    tips: [
      ['1. 포들 밤투폼까지 검색', '클렌징밤만 검색하면 다른 브랜드 제품이 많이 섞입니다.'],
      ['2. 130ml 기획 확인', '단품인지 기획인지 먼저 보면 헷갈릴 일이 줄어들어요.'],
      ['3. 미니 증정 확인', '증정품은 재고나 행사에 따라 달라질 수 있어 구매 화면에서 다시 봐야 해요.']
    ],
    captions: [
      ['첫 느낌', '크림색 단지만 놓아도 욕실 선반에 잘 어울리는 깔끔한 분위기예요.'],
      ['손에 들면', '넓은 단지라 손에 들었을 때 용량감이 바로 보여요.'],
      ['밤 제형', '뚜껑을 열면 베이지빛 밤 제형이 보여서 클렌징밤 느낌이 확 납니다.'],
      ['스패출러', '스패출러로 떠낸 컷은 실제 사용 전 가장 궁금한 부분이에요.'],
      ['기획 구성', '본품과 미니 밤투폼을 같이 두면 증정 구성이 한눈에 들어와요.'],
      ['타월 위', '하얀 타월 위에 두면 크림색 단지가 더 부드럽게 보여요.'],
      ['욕실 컷', '세면대 옆에 두면 매일 쓰는 클렌징 루틴템 느낌이 납니다.'],
      ['파우치 안', '여행 파우치에 넣어둔 컷은 미니 증정품 느낌과 잘 맞아요.'],
      ['거울 앞', '거울 옆에 단지를 세워두면 욕실 사진이 자연스럽습니다.'],
      ['오픈 컷', '열어둔 단지는 제형 확인용으로 꼭 필요한 컷이에요.'],
      ['손등 테스트', '손등 위 밤 제형은 녹는 느낌을 상상하기 좋아요.'],
      ['서랍 보관', '클렌징 제품 사이에 넣어두면 생활감이 있어서 좋아요.'],
      ['박스와 함께', '상자와 본품, 미니 샘플이 같이 있으면 구성 확인이 쉬워요.'],
      ['세면대 옆', '물기 있는 욕실 컷은 실제 클렌징 전후 느낌이 자연스럽게 나요.'],
      ['제형 가까이', '밤 표면을 가까이 보면 촉촉하고 꾸덕한 느낌이 살아납니다.'],
      ['여행 준비', '파우치에 본품과 미니를 같이 두면 기획세트 무드가 잘 보여요.'],
      ['타월 위 오픈컷', '타월 위에 열어둔 단지를 놓으면 클렌징 전후 루틴 느낌이 자연스럽습니다.'],
      ['마지막 컷', '깔끔한 흰 단지 하나만으로도 제품 이미지가 또렷하게 남습니다.']
    ]
  }
];

function getBlogProductProfile(post) {
  const manualProfile = BLOG_PRODUCT_PROFILES.find((profile) => profile.match(post));
  if (manualProfile) return manualProfile;
  if (post && post.profile && post.profile.id && String(post.profile.id).startsWith('auto-')) {
    return buildAutoProductProfile(post);
  }
  if (post && post.profile && post.profile.id) return post.profile;
  return null;
}

const COLOR_WORDS = [
  ['민트', '#4fd7cb', '#0a8f8e', '#dffcf8', '#0c6d74'],
  ['아쿠아', '#53d4ef', '#157fb7', '#e5fbff', '#0f5f85'],
  ['블루', '#3d8cff', '#1551b7', '#e9f4ff', '#113f8d'],
  ['하늘', '#7ad8ff', '#1676c2', '#effbff', '#115387'],
  ['핑크', '#ff9cbc', '#c24f7f', '#fff0f6', '#973960'],
  ['코랄', '#ff9b7a', '#db6b4c', '#fff2ec', '#a84d37'],
  ['레드', '#f16a6a', '#b83245', '#fff0f1', '#87263a'],
  ['버건디', '#9e4a61', '#6f2137', '#f9eef2', '#561c2d'],
  ['보라', '#af8fff', '#6e4bc7', '#f5f1ff', '#53378f'],
  ['라벤더', '#b7a6ff', '#7763d2', '#f5f1ff', '#5c4aa9'],
  ['옐로', '#ffd45f', '#c69b18', '#fff9e2', '#8d6b0c'],
  ['골드', '#e4bb68', '#9f7322', '#fbf4de', '#7d5912'],
  ['오렌지', '#ffb067', '#d87922', '#fff3e4', '#9a5318'],
  ['그린', '#82ce8c', '#2f8e53', '#effcf1', '#256f41'],
  ['화이트', '#f8f7f1', '#d9d5cc', '#ffffff', '#80776b'],
  ['블랙', '#3b4654', '#1f2631', '#edf1f4', '#161c25'],
  ['베이지', '#dbc6aa', '#a38359', '#f9f4ea', '#765636'],
  ['브라운', '#b28762', '#744f36', '#f7efe7', '#5a3c29']
];

const BRAND_ROMAN = {
  메디힐: 'MEDIHEAL',
  토리든: 'TORRIDEN',
  토니모리: 'TONYMOLY',
  포들: 'PO:DL',
  도브: 'Dove',
  롬앤: 'rom&nd',
  퓌: 'fwee',
  비오레: 'Biore',
  클리오: 'CLIO',
  이브네: '이브네',
  에스네이처: 'S.NATURE',
  홀리카홀리카: 'HOLIKA HOLIKA',
  오호라: 'ohora',
  웰라쥬: 'WELLAGE'
};

function normalizeHex(value, fallback) {
  const raw = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw : fallback;
}

function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}

function hexToRgb(hex) {
  const raw = String(hex || '').replace('#', '');
  return {
    r: Number.parseInt(raw.slice(0, 2), 16),
    g: Number.parseInt(raw.slice(2, 4), 16),
    b: Number.parseInt(raw.slice(4, 6), 16)
  };
}

function rgbToHex(rgb) {
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((value) => clampChannel(value).toString(16).padStart(2, '0'))
    .join('')}`;
}

function mixHex(hexA, hexB, ratio) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const blend = (from, to) => from + (to - from) * ratio;
  return rgbToHex({
    r: blend(a.r, b.r),
    g: blend(a.g, b.g),
    b: blend(a.b, b.b)
  });
}

function colorNameFor(text) {
  const found = COLOR_WORDS.find(([label]) => String(text || '').includes(label));
  return found ? found[0] : '';
}

function colorPaletteFor(post) {
  const profile = post && post.visualProfile;
  if (profile && profile.palette) {
    return {
      accent: normalizeHex(profile.palette.accent, '#47c8d6'),
      accentDark: normalizeHex(profile.palette.accentDark, '#0e7b96'),
      second: normalizeHex(profile.palette.second, '#8de4ee'),
      soft: normalizeHex(profile.palette.soft, '#eefbff'),
      warm: normalizeHex(profile.palette.warm, '#ffe889'),
      colorName: profile.palette.colorName || colorNameFor(post.rawName || post.cleanName || post.shortName)
    };
  }

  const found = COLOR_WORDS.find(([label]) => textOf(post).includes(label));
  if (found) {
    return {
      colorName: found[0],
      accent: found[1],
      accentDark: found[2],
      soft: found[3],
      second: mixHex(found[1], '#ffffff', 0.42),
      warm: mixHex(found[1], '#ffd86b', 0.36)
    };
  }

  const kind = detectProductKind(post);
  const fallbackByKind = {
    tint: ['코랄', '#ff8d7b', '#bf4a4c', '#fff3ef', '#ffc6b8'],
    palette: ['베이지', '#c9a56f', '#825f33', '#fbf6ee', '#e6b08d'],
    jar: ['화이트', '#f3efe9', '#b69f7f', '#fffdfa', '#f1d6b5'],
    pack: ['하늘', '#79dfff', '#1360b7', '#eefbff', '#b198ff'],
    padJar: ['민트', '#49d9d0', '#0b8f8e', '#e8fffc', '#d5f2ff'],
    stick: ['핑크', '#ef95b4', '#9c4c6c', '#fff2f8', '#ffd7a4'],
    tube: ['아쿠아', '#4fcfff', '#0b7bc1', '#effcff', '#ffe870'],
    pouch: ['베이지', '#d7be99', '#8d6f4a', '#faf4ec', '#ffd6b3'],
    bottle: ['블루', '#4f90ff', '#214fa0', '#eef4ff', '#8fd8ff']
  };
  const base = fallbackByKind[kind] || fallbackByKind.bottle;
  return {
    colorName: base[0],
    accent: base[1],
    accentDark: base[2],
    soft: base[3],
    second: mixHex(base[1], '#ffffff', 0.36),
    warm: base[4]
  };
}

function detectProductKind(post) {
  const text = textOf(post);
  if (/토너패드/.test(text)) return 'padJar';
  if (/마스크팩|겔마스크/.test(text)) return 'pack';
  if (/틴트|글로스|립 포션|립밤/.test(text)) return 'tint';
  if (/팔레트|아이섀도우|토퍼|네일강화제/.test(text)) return 'palette';
  if (/스크럽|클렌징밤|밤투폼|밤\b|크림/.test(text)) return 'jar';
  if (/젤리|생리대|벨리곰/.test(text)) return 'pouch';
  if (/세럼|앰플/.test(text)) return 'dropper';
  if (/선세럼|선크림|에센스|폼|클렌저/.test(text)) return 'tube';
  if (/네일/.test(text)) return 'bottle';
  return 'bottle';
}

function brandTextFor(post) {
  if (post && post.visualProfile && post.visualProfile.brandText) return post.visualProfile.brandText;
  return BRAND_ROMAN[post.brand] || post.brand || '상품 패키지';
}

function optionSummaryFor(post) {
  const text = String(post.rawName || post.cleanName || '');
  const match =
    text.match(/(\d+\s?종\s?(?:택\s?\d|골라담기)?)/) ||
    text.match(/(\d+\+\d+\w*)/) ||
    text.match(/(더블 기획)/) ||
    text.match(/(단품\/기획)/) ||
    text.match(/(\([^)]+\))/);
  return match ? match[1].replace(/\s+/g, ' ').trim() : '';
}

function labelTextFor(post) {
  const base = String(post.cleanName || post.shortName || '').replace(/\([^)]*\)/g, '').trim();
  const type = deriveType(base);
  const brand = post.brand || '';
  const trimmed = base.replace(new RegExp(`^${brand}\\s*`), '').trim();
  const candidate = trimmed || base;
  const words = candidate
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  if (words.length === 0) return type || 'HOT ITEM';
  return words.join('\n').toUpperCase();
}

function packageCueFor(post, kind) {
  const colorName = colorPaletteFor(post).colorName || '은은한';
  const map = {
    dropper: `${colorName} 보틀과 스포이드`,
    tube: `${colorName} 포인트 튜브`,
    jar: `${colorName} 단지와 크림 제형`,
    padJar: `${colorName} 용기와 네모 패드`,
    pack: `${colorName} 패키지와 시트팩 무드`,
    tint: `${colorName} 발색과 슬림 패키지`,
    palette: `${colorName} 팔레트와 반짝 포인트`,
    pouch: `${colorName} 패키지와 말랑한 실루엣`,
    bottle: `${colorName} 패키지와 깔끔한 라벨`
  };
  return map[kind] || `${colorName} 패키지 분위기`;
}

function moodCueFor(post) {
  const colorName = colorPaletteFor(post).colorName || '산뜻한';
  const type = deriveType(post.cleanName || post.shortName || '');
  return type === '인기상품'
    ? `${colorName} 톤 제품이라 사진에서 분위기가 먼저 들어옵니다.`
    : `${colorName} 톤 ${type} 무드라 사진에서 분위기가 먼저 들어옵니다.`;
}

function kindNoun(kind) {
  return (
    {
      dropper: '세럼',
      tube: '튜브',
      jar: '단지',
      padJar: '패드',
      pack: '팩',
      tint: '립',
      palette: '팔레트',
      pouch: '파우치',
      bottle: '보틀'
    }[kind] || '제품'
  );
}

function buildDynamicCaptions(post, kind) {
  const colorName = colorPaletteFor(post).colorName || '산뜻한';
  const noun = kindNoun(kind);
  const optionSummary = optionSummaryFor(post);
  const lines = [
    ['첫 느낌', `${colorName} 톤 ${noun}이 먼저 보여서 검색 화면에서도 제품 인상이 또렷하게 남아요.`],
    ['손에 들면', `손에 들었을 때 크기감이 보여서 ${post.shortName} 무드가 훨씬 자연스럽게 느껴집니다.`],
    ['라벨 컷', '상품명과 패키지 컬러가 보이면 같은 상품인지 맞춰보기 훨씬 쉬워요.'],
    ['화장대 컷', `화장대나 욕실 선반에 두면 데일리 루틴템 같은 분위기가 잘 살아나요.`],
    ['가까이 보기', `${packageCueFor(post, kind)}이 가까이서 더 또렷하게 보여서 사진 맛이 있어요.`],
    ['구성 느낌', `${optionSummary || '행사 구성'}이 있는 상품은 본품을 여러 개 두는 컷이 한눈에 들어옵니다.`],
    ['생활감', `수건이나 파우치 옆에 두면 너무 광고컷 같지 않고 블로그 후기 무드로 보여요.`],
    ['위에서 보기', `위에서 내려다본 컷은 패키지 모양과 색 조합이 정리돼 보여서 보기 편합니다.`],
    ['책상 위', `하얀 배경 위에 두면 ${colorName} 포인트가 더 맑게 살아납니다.`],
    ['루틴 컷', `아침이나 저녁 루틴에 끼워 넣은 듯한 장면이 실제 사용 상상을 돕는 편이에요.`],
    ['보관 컷', `서랍이나 선반에 넣어둔 컷은 자주 꺼내 쓰는 제품 느낌이 자연스럽습니다.`],
    ['단독 컷', `제품 하나만 세워도 브랜드 라인 인상이 남아 썸네일용으로도 잘 맞아요.`],
    ['질감 무드', `${kind === 'tint' ? '발색' : kind === 'pack' ? '시트' : '제형'} 느낌을 과하게 쓰지 않고 살짝만 보여주면 더 자연스럽습니다.`],
    ['소품 옆', `톤이 맞는 작은 소품 옆에 두면 상세 페이지에서 봤던 색감 방향이 더 또렷해 보여요.`],
    ['패키지 포인트', `${post.shortName}에서 눈에 띄는 포인트를 한 컷에 모아두면 구매 전 확인용으로 좋아요.`],
    ['행사 무드', `${optionSummary || '기획 구성'}이 붙은 상품은 여러 개를 같이 두는 컷이 특히 잘 어울려요.`],
    ['정리 컷', `브랜드명과 제품 타입이 한 번에 보이게 정리하면 검색 유입 글에 잘 맞습니다.`],
    ['마지막 컷', `${colorName} 톤으로 마무리하면 ${post.shortName} 무드가 끝까지 깔끔하게 남아요.`]
  ];
  return lines.slice(0, REVIEW_PHOTO_COUNT);
}

function buildAutoProductProfile(post) {
  if (!post) return null;
  const kind = detectProductKind(post);
  const palette = colorPaletteFor(post);
  const optionSummary = optionSummaryFor(post);
  const noun = kindNoun(kind);
  const suffixByKind = {
    dropper: `${deriveType(post.cleanName) === '앰플' ? '앰플' : '세럼'} 올리브영 재고`,
    tube: `${deriveType(post.cleanName) || '튜브템'} 올리브영 재고`,
    jar: `${deriveType(post.cleanName) || '단지템'} 올리브영 재고`,
    padJar: '토너패드 올리브영 재고',
    pack: `${deriveType(post.cleanName) || '마스크팩'} 올리브영 재고`,
    tint: `${deriveType(post.cleanName) || '립템'} 올리브영 재고`,
    palette: `${deriveType(post.cleanName) || '메이크업'} 올리브영 재고`,
    pouch: `${deriveType(post.cleanName) || '기획템'} 올리브영 재고`,
    bottle: `${deriveType(post.cleanName) || '인기상품'} 올리브영 재고`
  };
  const titleSuffix = suffixByKind[kind] || '올리브영 재고';
  const packageCue = packageCueFor(post, kind);
  const photoLead =
    `이 제품은 <span class="highlight">${htmlEscape(packageCue)}</span>이 먼저 보여야 예뻐요. ` +
    `그래서 사진도 실제 후기글에서 많이 보는 화장대, 손에 든 컷, 보관 컷 흐름으로 맞췄습니다.`;
  const shoppingParagraphs = [
    `${htmlEscape(post.rawName || post.shortName)}처럼 상품명이 길거나 기획 문구가 붙은 상품은 같은 라인 안에서도 구성 표현이 달라질 수 있어요.`,
    `사진으로 분위기를 본 뒤에는 <span class="highlight">옵션명</span>, <span class="highlight">온라인 재고</span>, <span class="highlight">근처 매장 재고</span>를 같이 보는 쪽이 실수가 적습니다.`
  ];

  return {
    id: `auto-${post.slug}`,
    assetPrefix: post.slug,
    assetExt: 'png',
    detailFile: `${post.slug}-detail-page-01.png`,
    title: titleFor(post.shortName, titleSuffix),
    description: descriptionFor(post.shortName, `${packageCue}, ${moodCueFor(post).replace(/\.$/, '')}`),
    heroLead: `${moodCueFor(post)} ${optionSummary ? `${optionSummary} 구성이라 옵션명을 같이 보는 흐름이 편합니다.` : '마음에 들면 재고부터 같이 확인하는 흐름이 편합니다.'}`,
    introBig: `${htmlEscape(post.shortName)}, 일단 <span class="soft-word">${htmlEscape(packageCue)}</span> 쪽이 먼저 눈에 들어와요.`,
    introBody: `${post.rankingDateText || ''} 기준 조회 인기 ${post.rank || ''}위로 올라온 상품이에요. ${optionSummary ? `${htmlEscape(optionSummary)} 구성이라` : '행사 문구가 붙어 있으면'} 화면에서 같은 상품인지 한 번 더 맞춰보는 편이 좋습니다.`,
    moodNotes: [
      ['색감', `${palette.colorName || '산뜻한'} 톤 패키지라 상세 썸네일에서 존재감이 또렷합니다.`],
      ['패키지', `${packageCue}이 보여서 제품 타입을 바로 떠올리기 쉬워요.`],
      ['구성', optionSummary ? `${optionSummary} 문구가 붙어 있으면 옵션 확인이 특히 중요합니다.` : '행사/증정 문구는 연결된 구매 화면에서 마지막으로 확인하면 됩니다.']
    ],
    photoTitle: `${post.shortName}, 사진으로 보면 이런 느낌`,
    photoLead,
    shoppingTitle: '예뻐 보여도 옵션명은 한 번만 더 봐요',
    shoppingParagraphs,
    checklist: [
      `${post.shortName} 상품명 먼저 맞춰보기`,
      optionSummary ? `${optionSummary} 같은 기획/옵션 문구 확인하기` : '같은 라인 다른 옵션이 섞이지 않았는지 보기',
      '온라인 재고와 가까운 매장 재고 같이 보기',
      '오늘드림이나 픽업 가능 여부까지 한 번에 열어두기'
    ],
    tipTitle: '조회가 붙은 상품은 옵션별 재고가 빨리 움직여요',
    tipParagraph:
      `특히 ${deriveType(post.cleanName) === '인기상품' ? '기획 상품' : deriveType(post.cleanName)}은 행사 문구와 옵션 차이로 체감 구성이 달라질 수 있어요. 마음에 든 구성이 보이면 재고부터 먼저 확인하는 게 덜 번거롭습니다.`,
    tips: [
      ['1. 상품명 길게 검색', '브랜드명과 제품 타입까지 같이 넣으면 비슷한 상품이 덜 섞여요.'],
      ['2. 옵션/기획 문구 확인', optionSummary ? `${optionSummary}처럼 행사 구성이 다르면 원하는 상품이 달라질 수 있어요.` : '증정이나 기획 문구가 붙었는지 먼저 보면 실수가 줄어듭니다.'],
      ['3. 받을 방식 고르기', '온라인, 오늘드림, 매장 픽업 중 지금 제일 편한 쪽을 먼저 확인하면 됩니다.']
    ],
    captions: buildDynamicCaptions(post, kind),
    visual: {
      kind,
      brand: brandTextFor(post),
      title: labelTextFor(post),
      sub: optionSummary || deriveType(post.cleanName || post.shortName || ''),
      accent: palette.accent,
      accentDark: palette.accentDark,
      second: palette.second,
      soft: palette.soft,
      warm: palette.warm,
      pageBg: `linear-gradient(180deg,${mixHex(palette.accentDark, '#0f172a', 0.18)} 0%,${palette.accent} 48%,${palette.soft} 100%)`,
      detailTitle: `${post.shortName}${optionSummary ? ` · ${optionSummary}` : ''}`,
      detailSub: `${packageCue}이 보이는 올리브영 상품 이미지 컷`,
      features: [
        ['패키지 포인트', packageCue],
        ['상품명 확인', '상품명과 패키지 컬러를 먼저 맞춰보면 비슷한 옵션이 덜 헷갈려요.'],
        ['구매 전 확인', optionSummary ? `${optionSummary} 같은 구성 문구는 구매 화면에서 다시 확인해 주세요.` : '최종 옵션과 가격은 연결된 구매 화면에서 다시 확인해 주세요.']
      ],
      palette: {
        accent: palette.accent,
        accentDark: palette.accentDark,
        second: palette.second,
        soft: palette.soft,
        warm: palette.warm
      }
    }
  };
}

function genericCopy(post) {
  const shortName = post.shortName || '올리브영 인기상품';
  return {
    title: titleFor(shortName, '올리브영 재고'),
    description: `${shortName}의 상품 분위기와 구매 전 확인할 점을 보고 올리브영 온라인·매장 재고까지 바로 이어볼 수 있게 정리했습니다.`,
    heroLead: '올리브영에서 조회가 많이 붙은 상품이라, 사진 느낌과 재고 확인 흐름을 같이 보려고 정리했습니다.',
    introBig: `${htmlEscape(shortName)}, 지금 올리브영에서 많이 보고 있는 상품이에요.`,
    introBody: `${post.rankingDateText || ''} 기준 조회 인기 ${post.rank || ''}위로 잡힌 상품입니다. 마음에 들면 상품명과 옵션을 맞춰 보고 재고를 같이 확인하는 게 편해요.`,
    moodNotes: [
      ['상품명', '행사명이나 옵션명이 길면 실제 구매 화면에서 한 번 더 맞춰보는 게 좋아요.'],
      ['재고', '온라인 재고와 매장 재고가 다르게 움직일 수 있어요.'],
      ['구매 전', '쿠폰, 구성, 배송 방식은 연결된 구매 화면에서 마지막으로 확인하면 됩니다.']
    ],
    photoTitle: '사진으로 쓱 보기',
    photoLead: '상품 분위기와 구매 전 체크할 부분을 보기 쉽게 정리했습니다.',
    shoppingTitle: '바로 사기 전에 옵션명은 한 번만 더 봐요',
    shoppingParagraphs: [
      `${htmlEscape(post.rawName || shortName)}처럼 상품명이 길면 같은 라인 안에서도 구성이나 옵션이 달라질 수 있어요.`,
      '구매 전에는 <span class="highlight">온라인 재고</span>와 <span class="highlight">근처 매장 재고</span>를 같이 보는 쪽이 마음 편합니다.'
    ],
    checklist: [
      '상품명과 옵션명을 먼저 맞춰보기',
      '온라인 재고와 매장 재고를 같이 보기',
      '오늘드림이나 픽업 가능 여부 확인하기',
      '최종 가격과 쿠폰은 구매 화면에서 다시 보기'
    ],
    tipTitle: '마음에 들면 재고는 바로 보는 게 좋아요',
    tipParagraph: '조회가 많이 붙은 상품은 옵션별 재고가 빠르게 바뀔 수 있어요. 살 마음이 생겼다면 재고 확인을 먼저 열어두는 게 편합니다.',
    tips: [
      ['1. 상품명 길게 넣기', '짧게 검색하면 비슷한 상품이 섞일 수 있어요.'],
      ['2. 가까운 매장 먼저 보기', '오늘 들를 수 있는 매장부터 보면 시간이 줄어듭니다.'],
      ['3. 온라인도 같이 보기', '매장에 없으면 온라인 재고나 오늘드림이 더 빠를 수 있어요.']
    ],
    captions: []
  };
}

function buildBlogCopy(post, profile = getBlogProductProfile(post)) {
  const shortName = post.shortName || '올리브영 인기상품';
  if (!profile) return genericCopy(post);
  if (profile && profile.id && profile.heroLead && typeof profile.title !== 'function') {
    return {
      ...profile,
      title: profile.title || titleFor(shortName, '올리브영 재고'),
      description: profile.description || genericCopy(post).description
    };
  }
  return {
    ...profile,
    title: profile.title(shortName),
    description: profile.description(shortName),
    introBig: profile.introBig(shortName),
    introBody: profile.introBody(post),
    shoppingParagraphs: profile.shoppingParagraphs(post)
  };
}

module.exports = {
  BLOG_PRODUCT_PROFILES,
  REVIEW_PHOTO_COUNT,
  buildAutoProductProfile,
  buildBlogCopy,
  getBlogProductProfile
};
