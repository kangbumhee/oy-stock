import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const guideDir = path.join(publicDir, 'guide');
const imageDir = path.join(publicDir, 'images');

const SITE_URL = 'https://olivestock.co.kr';
const SITE_NAME = '올리브재고';
const GA_MEASUREMENT_ID = 'G-W7B566LXQ3';
const WRITE_DISCOVERY_FILES = process.env.WRITE_GUIDE_DISCOVERY_FILES === '1';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(
  new Date()
);

const pages = [
  {
    slug: 'oliveyoung-stock-check',
    keyword: '올리브영 재고확인',
    title: '올리브영 재고확인｜근처 매장·온라인 재고 빠르게 보는 법',
    description: '올리브영 재고확인을 할 때 근처 매장, 전국 매장, 온라인 재고를 어떤 순서로 보면 좋은지 정리했습니다.',
    query: '선크림',
    lead: '올리브영 재고확인은 품절이 잦은 선케어, 마스크팩, 메이크업 상품을 찾을 때 가장 먼저 확인해야 하는 단계입니다.',
    points: ['위치 기준 근처 매장 보유 여부 확인', '온라인 재고와 매장 재고를 함께 비교', '상품 클릭 후 옵션별 재고까지 재확인'],
    sections: [
      ['재고확인을 먼저 해야 하는 이유', '올리브영 인기 상품은 행사 기간, 올영세일, 신상품 출시 직후에 빠르게 품절될 수 있습니다. 집 근처 매장에 방문하기 전에 상품명을 검색해 재고가 있는 매장과 온라인 구매 가능 여부를 함께 보는 것이 시간을 줄이는 방법입니다.'],
      ['올리브재고에서 보는 순서', '먼저 상품명을 입력하고 검색 결과의 재고 배지를 확인합니다. 관심 상품을 누르면 근처 매장 재고, 온라인 재고, 옵션별 상태가 분리되어 보이므로 같은 상품이라도 색상이나 용량별 차이를 확인하기 좋습니다.'],
      ['방문 전 체크포인트', '검색 결과는 재고 확인을 돕는 참고 정보입니다. 행사 상품이나 소량 재고는 매장 이동 중에도 변동될 수 있으니, 수량이 적게 표시되는 상품은 가까운 매장부터 빠르게 비교하는 편이 좋습니다.']
    ]
  },
  {
    slug: 'oliveyoung-stock-search',
    keyword: '올리브영 재고조회',
    title: '올리브영 재고조회｜상품명으로 매장 재고 찾는 방법',
    description: '올리브영 재고조회 검색어로 들어온 사용자를 위해 상품명 검색, 옵션 확인, 재고 비교 방법을 안내합니다.',
    query: '토너',
    lead: '올리브영 재고조회는 정확한 상품명을 몰라도 카테고리나 대표 키워드로 시작할 수 있습니다.',
    points: ['상품명 일부로 검색 시작', '검색 결과에서 가격·할인·재고 배지 확인', '상세 팝업에서 매장별 재고 비교'],
    sections: [
      ['상품명 검색을 넓게 시작하기', '정확한 제품명을 모를 때는 토너, 세럼, 클렌징오일처럼 넓은 키워드로 검색한 뒤 브랜드명이나 옵션명을 보고 좁혀 가는 방식이 좋습니다.'],
      ['재고조회 결과 읽는 법', '검색 결과 카드에는 품절 여부, 온라인 재고, 매장 재고 상태가 함께 표시됩니다. 같은 상품이라도 옵션별로 재고가 다를 수 있으므로 상세 팝업에서 옵션 목록을 확인해야 합니다.'],
      ['재고가 안 보일 때', '일부 업체배송 상품이나 외부 판매 상품은 실시간 재고 대상이 아닐 수 있습니다. 이 경우 상품 페이지에서 구매 가능 여부를 추가로 확인하는 흐름이 안전합니다.']
    ]
  },
  {
    slug: 'nearby-store-stock',
    keyword: '올리브영 매장 재고',
    title: '올리브영 매장 재고｜근처 매장 보유 수량 확인 팁',
    description: '올리브영 매장 재고를 근처 위치 기준으로 확인하고 방문 전 비교하는 방법을 정리했습니다.',
    query: '마스크팩',
    lead: '올리브영 매장 재고는 같은 지역 안에서도 매장별로 차이가 커서 위치 기준 비교가 중요합니다.',
    points: ['현재 위치 또는 지역 선택', '가까운 매장부터 보유 상태 확인', '전국 재고로 대체 매장 탐색'],
    sections: [
      ['근처 매장부터 확인하기', '현재 위치를 사용하거나 지역을 직접 선택하면 가까운 매장을 기준으로 재고를 비교할 수 있습니다. 자주 가는 매장이 있다면 즐겨찾기 상품과 함께 확인하면 반복 조회가 편합니다.'],
      ['소량 재고는 빠르게 판단하기', '재고 소량으로 보이는 상품은 방문 전에 품절될 가능성이 있습니다. 근처 매장 여러 곳을 동시에 비교하고, 온라인 재고가 있으면 대체 구매 가능성도 함께 보세요.'],
      ['전국 재고가 필요한 경우', '동네 매장에 재고가 없을 때는 상품 상세에서 전국 매장 재고를 확인해 다른 지역의 보유 매장을 찾을 수 있습니다.']
    ]
  },
  {
    slug: 'national-store-stock',
    keyword: '올리브영 전국 매장 재고',
    title: '올리브영 전국 매장 재고｜지역별 재고 비교 가이드',
    description: '올리브영 전국 매장 재고를 확인해 가까운 지역 외 대체 매장을 찾는 방법을 안내합니다.',
    query: '클렌징오일',
    lead: '전국 매장 재고는 근처 매장에 품절이 많은 상품을 다른 지역에서 찾을 때 유용합니다.',
    points: ['상품 상세에서 전국 재고 열기', '옵션별 보유 매장 분리 확인', '지역명·매장명 기준으로 비교'],
    sections: [
      ['전국 재고를 보는 상황', '한정 기획세트, 인기 색상, 세일 상품처럼 지역별 편차가 큰 상품은 근처 매장만 보는 것보다 전국 재고를 함께 확인하는 편이 좋습니다.'],
      ['옵션별 확인이 중요한 이유', '립, 쿠션, 헤어 제품은 색상이나 용량에 따라 재고가 완전히 다를 수 있습니다. 전국 재고를 볼 때도 옵션명을 먼저 확인해야 잘못된 방문을 줄일 수 있습니다.'],
      ['방문 가능 지역 좁히기', '전국 재고는 후보 매장을 넓히는 용도입니다. 실제 방문 전에는 거리, 영업시간, 이동 가능 여부까지 같이 판단하는 것이 좋습니다.']
    ]
  },
  {
    slug: 'online-stock',
    keyword: '올리브영 온라인 재고',
    title: '올리브영 온라인 재고｜품절 전 확인 체크리스트',
    description: '올리브영 온라인 재고를 매장 재고와 함께 비교하고 품절 전에 확인하는 방법을 정리했습니다.',
    query: '세럼',
    lead: '온라인 재고는 매장 방문 없이 구매 가능성을 판단할 수 있는 기준입니다.',
    points: ['온라인 재고 배지 확인', '옵션별 온라인 수량 비교', '매장 품절 시 대체 구매 흐름 확인'],
    sections: [
      ['온라인 재고가 중요한 경우', '가까운 매장에 재고가 없거나 이동 시간이 길 때 온라인 재고가 있는지 먼저 보는 것이 효율적입니다. 특히 세일 기간에는 온라인과 매장 품절 속도가 다를 수 있습니다.'],
      ['매장 재고와 함께 보기', '온라인 재고가 있어도 배송 방식, 가격, 쿠폰 조건은 변동될 수 있습니다. 올리브재고에서는 매장과 온라인 상태를 나란히 보고 최종 구매 화면에서 조건을 확인하는 흐름을 권장합니다.'],
      ['품절 전 판단 기준', '온라인 재고가 소량으로 줄어드는 상품은 인기상품 랭킹이나 재고 변화 목록과 함께 보면 빠르게 판단할 수 있습니다.']
    ]
  },
  {
    slug: 'today-dream-stock',
    keyword: '올리브영 오늘드림 재고',
    title: '올리브영 오늘드림 재고｜당일 배송 전 확인 방법',
    description: '올리브영 오늘드림을 이용하기 전 온라인 재고와 근처 매장 재고를 함께 확인하는 방법을 설명합니다.',
    query: '립밤',
    lead: '오늘드림 가능 여부는 상품과 지역, 시간대에 따라 달라질 수 있어 재고와 함께 확인하는 것이 좋습니다.',
    points: ['근처 매장 재고 확인', '온라인 재고 상태 비교', '결제 전 배송 조건 재확인'],
    sections: [
      ['오늘드림 전 재고 확인', '당일 수령을 기대할 때는 상품 검색 후 근처 매장 재고와 온라인 재고 상태를 먼저 비교하세요. 같은 상품도 옵션별로 배송 가능성이 달라질 수 있습니다.'],
      ['시간대에 따른 변동', '저녁 시간대나 행사 기간에는 재고와 배송 조건이 빠르게 바뀔 수 있습니다. 올리브재고에서 후보 상품을 찾은 뒤 최종 결제 화면에서 배송 가능 여부를 확인하는 흐름이 안전합니다.'],
      ['대체 상품 찾기', '오늘드림이 어렵거나 품절이라면 같은 카테고리의 인기상품을 검색해 대체 가능한 상품을 비교해 볼 수 있습니다.']
    ]
  },
  {
    slug: 'popular-products',
    keyword: '올리브영 인기상품',
    title: '올리브영 인기상품｜매일 확인하는 인기템과 재고 흐름',
    description: '올리브영 인기상품을 조회수와 재고 흐름 기준으로 보고 품절 가능성이 높은 상품을 확인하는 방법입니다.',
    query: '선크림',
    lead: '인기상품은 재고 변동이 빠르기 때문에 순위와 재고 상태를 같이 보는 것이 중요합니다.',
    points: ['인기템 탭에서 순위 확인', '조회수·판매 흐름 기준 비교', '재고 급감 상품 우선 확인'],
    sections: [
      ['인기상품을 보는 이유', '검색량이 많은 상품은 매장마다 입고와 품절 속도가 다릅니다. 인기템 탭에서는 하루 단위 흐름을 기준으로 어떤 상품이 많이 움직이는지 빠르게 파악할 수 있습니다.'],
      ['랭킹과 재고를 함께 보기', '순위만 높다고 바로 구매하기보다 현재 재고가 있는지, 온라인 재고가 남아 있는지, 옵션별 품절이 있는지 함께 확인해야 합니다.'],
      ['세일 기간 활용법', '올영세일이나 브랜드 행사 기간에는 랭킹 상위 상품부터 품절될 가능성이 높습니다. 관심 상품은 즐겨찾기에 넣어 반복 확인하는 방식이 좋습니다.']
    ]
  },
  {
    slug: 'ranking-sales',
    keyword: '올리브영 랭킹 매출 순위',
    title: '올리브영 랭킹·매출 순위｜조회수와 판매 흐름 보는 법',
    description: '올리브영 랭킹과 매출 순위 흐름을 참고해 인기 상품과 재고 변화를 함께 확인하는 방법을 정리했습니다.',
    query: '쿠션',
    lead: '랭킹과 매출 흐름은 인기 상품을 고를 때 참고할 수 있는 보조 지표입니다.',
    points: ['조회수 흐름 확인', '판매·매출 변화 참고', '재고 변화와 함께 판단'],
    sections: [
      ['랭킹만 보면 놓치는 부분', '상위권 상품이라도 특정 옵션은 이미 품절일 수 있습니다. 랭킹은 관심 상품을 찾는 출발점으로 보고 실제 재고 상태와 함께 판단해야 합니다.'],
      ['매출 흐름의 의미', '판매량과 매출 흐름은 상품 관심도가 올라가는지 확인하는 데 도움이 됩니다. 다만 가격, 행사, 구성 변경에 따라 수치 해석이 달라질 수 있어 재고 확인과 병행하는 것이 좋습니다.'],
      ['실전 활용 순서', '인기템 탭에서 카테고리를 고르고, 랭킹 상위 상품을 클릭한 뒤 옵션별 재고와 온라인 재고를 확인하세요.']
    ]
  },
  {
    slug: 'sale-stock',
    keyword: '올리브영 세일 재고',
    title: '올리브영 세일 재고｜할인 상품 품절 전 확인하는 법',
    description: '올리브영 세일 기간에 재고가 빠르게 줄어드는 상품을 검색하고 비교하는 방법을 안내합니다.',
    query: '클렌징폼',
    lead: '세일 재고는 가격보다 먼저 재고와 옵션을 확인해야 헛걸음을 줄일 수 있습니다.',
    points: ['세일 상품명으로 검색', '근처 매장과 온라인 재고 비교', '소량 재고는 빠르게 대체 상품 확인'],
    sections: [
      ['세일 기간 재고가 빨리 줄어드는 이유', '할인 폭이 큰 상품, 기획세트, SNS 인기 상품은 행사 초반부터 재고가 빠르게 줄 수 있습니다. 매장 방문 전 검색으로 후보를 정리하는 것이 좋습니다.'],
      ['온라인과 매장 가격 비교', '온라인 재고가 있어도 쿠폰, 배송, 옵션 조건은 결제 화면에서 달라질 수 있습니다. 올리브재고에서는 재고 후보를 찾고 최종 조건은 구매 화면에서 확인하는 흐름을 권장합니다.'],
      ['대체 상품 준비하기', '세일 상품이 품절이면 같은 카테고리의 인기상품이나 재고가 남아 있는 유사 상품을 함께 검색해 보세요.']
    ]
  },
  {
    slug: 'soldout-restock',
    keyword: '올리브영 품절 재입고',
    title: '올리브영 품절·재입고｜재고 소량 상품 추적 팁',
    description: '올리브영 품절 상품과 재입고 가능성이 있는 상품을 즐겨찾기와 재고 변화로 확인하는 방법입니다.',
    query: '앰플',
    lead: '품절 상품은 한 번 검색하고 끝내기보다 재고 변화와 대체 매장을 함께 봐야 합니다.',
    points: ['즐겨찾기에 관심 상품 저장', '재고 변동 이력 확인', '전국 재고로 대체 매장 탐색'],
    sections: [
      ['품절 상품을 다시 찾는 방법', '관심 상품을 즐겨찾기에 저장하면 다음 수집 시 재고 변화를 확인하기 좋습니다. 인기 색상이나 한정 구성은 재입고 후 다시 빠르게 품절될 수 있습니다.'],
      ['재고 소량 표시를 보는 법', '재고 소량은 실제 방문 전에 빠르게 변동될 수 있는 상태입니다. 가까운 매장 한 곳만 보지 말고 주변 매장과 온라인 재고를 함께 확인하세요.'],
      ['대체 구매 경로 확인', '매장 품절이 계속될 때는 온라인 재고 또는 다른 지역 매장 재고를 확인해 대체 구매 가능성을 판단할 수 있습니다.']
    ]
  },
  {
    slug: 'how-to-use',
    keyword: '올리브재고 사용법',
    title: '올리브재고 사용법｜검색부터 전국 재고 확인까지',
    description: '올리브재고에서 상품 검색, 인기상품 랭킹, 전국 매장 재고, 온라인 재고를 확인하는 순서를 안내합니다.',
    query: '토너패드',
    lead: '올리브재고는 상품 검색과 인기상품 랭킹을 같은 화면에서 확인하도록 만든 재고 확인 도구입니다.',
    points: ['상품명 입력 후 검색', '상품 카드 클릭으로 상세 확인', '전국 재고와 온라인 재고 비교'],
    sections: [
      ['첫 검색 시작하기', '검색창에 상품명이나 카테고리를 입력합니다. 선크림, 토너패드, 마스크팩처럼 넓은 키워드로 시작해도 검색 결과에서 상품명을 보고 좁힐 수 있습니다.'],
      ['상세 팝업 활용하기', '상품 카드를 클릭하면 옵션별 재고, 근처 매장 재고, 온라인 재고를 확인할 수 있습니다. 구매 버튼은 새 탭으로 열리므로 현재 검색 화면을 유지할 수 있습니다.'],
      ['인기템 탭 활용하기', '무엇을 살지 정하지 못했다면 인기템 탭에서 조회수와 판매 흐름이 높은 상품을 먼저 확인한 뒤 재고가 있는 상품을 고르면 됩니다.']
    ]
  },
  {
    slug: 'beauty-product-stock',
    keyword: '올리브영 화장품 재고',
    title: '올리브영 화장품 재고｜선크림·토너·메이크업 재고 확인',
    description: '올리브영 화장품 재고를 카테고리별로 검색하고 매장·온라인 재고를 비교하는 방법입니다.',
    query: '메이크업',
    lead: '화장품 재고는 색상, 용량, 기획 구성에 따라 달라지므로 옵션 확인이 특히 중요합니다.',
    points: ['카테고리 키워드로 넓게 검색', '옵션명과 색상 확인', '온라인·매장 재고 동시 비교'],
    sections: [
      ['화장품 검색 키워드 잡기', '선크림, 쿠션, 틴트, 세럼, 토너처럼 카테고리 키워드로 시작하면 관련 상품을 빠르게 둘러볼 수 있습니다. 브랜드명을 함께 입력하면 결과를 더 좁힐 수 있습니다.'],
      ['옵션별 재고 차이', '같은 상품이라도 색상이나 용량이 다르면 재고가 완전히 다를 수 있습니다. 검색 결과에서 바로 판단하지 말고 상세 팝업의 옵션 목록을 확인하세요.'],
      ['인기상품과 함께 비교', '구매 전 인기템 탭에서 같은 카테고리의 인기 흐름을 보면 대체 상품을 찾기 쉽습니다.']
    ]
  }
];

const visualPresets = {
  'oliveyoung-stock-check': [
    ['mediheal-gel-mask-stock-a000000239102-review-cover.jpg', '품절 전 확인하는 인기 마스크팩'],
    ['goodal-sunscreen-stock-a000000219553-review-cover.jpg', '세일 기간 빠르게 움직이는 선케어'],
    ['clio-tint-stock-a000000185265-review-cover.jpg', '옵션별 재고가 갈리는 립 제품'],
    ['anua-serum-stock-a000000255324-review-cover.jpg', '온라인·매장 재고를 같이 보는 세럼']
  ],
  'oliveyoung-stock-search': [
    ['mediheal-toner-pad-200-stock-a000000255385-review-cover.jpg', '상품명 검색으로 찾는 토너패드'],
    ['anua-serum-stock-a000000255324-review-cover.jpg', '브랜드명으로 좁히는 세럼'],
    ['banila-co-cleansing-balm-stock-a000000244783-review-cover.jpg', '카테고리 검색으로 보는 클렌징'],
    ['clio-hot-item-stock-a000000188988-review-cover.jpg', '색상 옵션 확인이 필요한 메이크업']
  ],
  'nearby-store-stock': [
    ['mediheal-mask-pack-stock-a000000217620-review-cover.jpg', '근처 매장부터 비교하는 마스크팩'],
    ['oliveyoung-hot-item-stock-a000000183329-review-cover.jpg', '방문 전 재고를 보는 인기상품'],
    ['oliveyoung-lip-balm-stock-a000000144067-review-cover.jpg', '가까운 매장 소량 재고 확인'],
    ['oliveyoung-hot-item-stock-a000000167662-review-cover.jpg', '오늘 필요한 상품 빠른 비교']
  ],
  'national-store-stock': [
    ['banila-co-cleansing-balm-stock-a000000244783-review-cover.jpg', '전국 매장 대체 재고 탐색'],
    ['foddle-cleansing-balm-stock-a000000230421-review-cover.jpg', '지역별로 다른 클렌징 재고'],
    ['oliveyoung-cleanser-stock-a000000214907-review-cover.jpg', '매장별 차이가 큰 클렌저'],
    ['oliveyoung-cleansing-balm-stock-a000000255622-review-cover.jpg', '옵션별 전국 재고 비교']
  ],
  'online-stock': [
    ['anua-serum-stock-a000000255324-review-cover.jpg', '온라인 수량을 먼저 보는 세럼'],
    ['mediheal-serum-stock-a000000255390-review-cover.jpg', '온라인 재고가 빠르게 줄어드는 앰플'],
    ['oliveyoung-ampoule-stock-a000000255068-review-cover.jpg', '온라인·오늘배송 동시 확인'],
    ['oliveyoung-ampoule-stock-a000000230854-review-cover.jpg', '매장 품절 시 대체 구매 확인']
  ],
  'today-dream-stock': [
    ['clio-tint-stock-a000000224939-review-cover.jpg', '오늘배송 전 옵션 확인'],
    ['clio-tint-stock-a000000185265-review-cover.jpg', '당일 수령 전 립 재고 체크'],
    ['tonymoly-tint-stock-a000000205485-review-cover.jpg', '색상별 온라인 재고 비교'],
    ['oliveyoung-lip-balm-stock-a000000144067-review-cover.jpg', '급하게 필요한 립밤 재고']
  ],
  'popular-products': [
    ['oliveyoung-hot-item-stock-a000000183329-review-cover.jpg', '조회가 몰리는 인기상품'],
    ['oliveyoung-hot-item-stock-a000000167662-review-cover.jpg', '랭킹에서 먼저 보는 상품'],
    ['oliveyoung-hot-item-stock-a000000255740-review-cover.jpg', '재고 흐름을 확인할 인기템'],
    ['oliveyoung-hot-item-stock-a000000250705-review-cover.jpg', '세일 기간 많이 찾는 상품']
  ],
  'ranking-sales': [
    ['clio-hot-item-stock-a000000188988-review-cover.jpg', '랭킹 흐름을 보는 메이크업'],
    ['banila-co-hot-item-stock-a000000247245-review-cover.jpg', '판매 흐름과 재고를 같이 확인'],
    ['oliveyoung-hot-item-stock-a000000221757-review-cover.jpg', '조회수 높은 뷰티소품'],
    ['oliveyoung-hot-item-stock-a000000248829-review-cover.jpg', '매출 흐름 참고용 인기상품']
  ],
  'sale-stock': [
    ['oliveyoung-cleanser-stock-a000000212703-review-cover.jpg', '세일 상품 품절 전 확인'],
    ['oliveyoung-cleanser-stock-a000000244488-review-cover.jpg', '할인 클렌저 재고 비교'],
    ['banila-co-cleansing-balm-stock-a000000244783-review-cover.jpg', '할인 폭 큰 클렌징 재고'],
    ['biore-hot-item-stock-a000000249451-review-cover.jpg', '행사 상품 빠른 재고 체크']
  ],
  'soldout-restock': [
    ['oliveyoung-ampoule-stock-a000000243535-review-cover.jpg', '품절 뒤 다시 보는 앰플'],
    ['oliveyoung-ampoule-stock-a000000202414-review-cover.jpg', '재입고 가능 상품 추적'],
    ['mediheal-serum-stock-a000000255390-review-cover.jpg', '소량 재고 변화 확인'],
    ['oliveyoung-hot-item-stock-a000000239099-review-cover.jpg', '품절 전 즐겨찾기 추천']
  ],
  'how-to-use': [
    ['mediheal-toner-pad-200-stock-a000000255385-review-cover.jpg', '상품명으로 검색 시작'],
    ['goodal-sunscreen-stock-a000000219556-review-cover.jpg', '카드 클릭 후 재고 확인'],
    ['clio-hot-item-stock-a000000232098-review-cover.jpg', '옵션별 재고 비교'],
    ['oliveyoung-hot-item-stock-a000000183329-review-cover.jpg', '인기템에서 대체 상품 찾기']
  ],
  'beauty-product-stock': [
    ['clio-hot-item-stock-a000000188988-review-cover.jpg', '메이크업 색상 재고 확인'],
    ['clio-tint-stock-a000000224939-review-cover.jpg', '립 옵션별 재고 비교'],
    ['goodal-sunscreen-stock-a000000219553-review-cover.jpg', '선케어 상품 빠른 확인'],
    ['anua-serum-stock-a000000255324-review-cover.jpg', '스킨케어 온라인 재고 확인']
  ]
};

const fallbackVisuals = [
  ['oliveyoung-hot-item-stock-a000000183329-review-cover.jpg', '올리브영 인기상품 재고 확인'],
  ['mediheal-gel-mask-stock-a000000239102-review-cover.jpg', '인기 마스크팩 재고 확인'],
  ['anua-serum-stock-a000000255324-review-cover.jpg', '세럼 온라인 재고 확인'],
  ['clio-tint-stock-a000000185265-review-cover.jpg', '립 제품 옵션 재고 확인']
];

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmlEscape(value) {
  return htmlEscape(value).replace(/'/g, '&apos;');
}

function pageUrl(page) {
  return `${SITE_URL}/guide/${page.slug}/`;
}

function imageName(page) {
  return `olivestock-${page.slug}.svg`;
}

function blogImageUrl(fileName) {
  return `/images/blog/${fileName}`;
}

function absoluteUrl(pathname) {
  if (!pathname) return SITE_URL + '/images/olivestock-og-image.svg';
  return pathname.startsWith('http') ? pathname : SITE_URL + pathname;
}

function guideVisuals(page) {
  const rows = visualPresets[page.slug] || fallbackVisuals;
  return rows.map(([fileName, label]) => ({
    src: blogImageUrl(fileName),
    abs: absoluteUrl(blogImageUrl(fileName)),
    label
  }));
}

function analyticsTag() {
  return `  <script async src="https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', '${GA_MEASUREMENT_ID}');
  </script>`;
}

function faviconTags() {
  return `  <link rel="shortcut icon" href="${SITE_URL}/favicon.ico">
  <link rel="icon" type="image/png" sizes="48x48" href="${SITE_URL}/favicon-48x48.png">
  <link rel="apple-touch-icon" sizes="180x180" href="${SITE_URL}/apple-touch-icon.png">
  <link rel="manifest" href="${SITE_URL}/site.webmanifest">
  <meta name="theme-color" content="#193d22">`;
}

function guideImage(page) {
  const title = htmlEscape(page.keyword);
  const subtitle = htmlEscape(page.points[0]);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${title}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f4ffe8"/>
      <stop offset="0.55" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#ecf7ff"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#193d22" flood-opacity="0.14"/>
    </filter>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="1000" cy="120" r="96" fill="#d7ff52" opacity="0.55"/>
  <circle cx="120" cy="520" r="120" fill="#c7e8ff" opacity="0.42"/>
  <rect x="90" y="85" width="1020" height="460" rx="36" fill="#fff" filter="url(#shadow)"/>
  <rect x="130" y="125" width="112" height="112" rx="30" fill="#193d22"/>
  <text x="186" y="199" text-anchor="middle" font-family="Arial, sans-serif" font-size="64" font-weight="900" fill="#d7ff52">O</text>
  <text x="275" y="155" font-family="Arial, sans-serif" font-size="30" font-weight="900" fill="#315b11">OLIVE STOCK GUIDE</text>
  <text x="130" y="315" font-family="Arial, sans-serif" font-size="64" font-weight="900" fill="#15251b">${title}</text>
  <text x="132" y="370" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="#475569">${subtitle}</text>
  <rect x="130" y="430" width="255" height="54" rx="27" fill="#193d22"/>
  <text x="258" y="466" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" font-weight="900" fill="#fff">올리브재고에서 확인</text>
  <rect x="760" y="155" width="250" height="270" rx="24" fill="#f7faf5" stroke="#dfead8"/>
  <rect x="795" y="190" width="180" height="20" rx="10" fill="#8cc63f"/>
  <rect x="795" y="230" width="130" height="20" rx="10" fill="#d4e7ca"/>
  <rect x="795" y="292" width="180" height="62" rx="16" fill="#fff" stroke="#dfead8"/>
  <text x="825" y="332" font-family="Arial, sans-serif" font-size="24" font-weight="900" fill="#193d22">재고 있음</text>
  <rect x="795" y="374" width="180" height="20" rx="10" fill="#c7e8ff"/>
</svg>`;
}

function pageTemplate(page, allPages) {
  const related = allPages.filter((p) => p.slug !== page.slug).slice(0, 4);
  const guideSvg = `/images/${imageName(page)}`;
  const visuals = guideVisuals(page);
  const primaryVisual = visuals[0] || {
    src: guideSvg,
    abs: absoluteUrl(guideSvg),
    label: page.keyword
  };
  const absoluteImg = primaryVisual.abs;
  const cta = `/?q=${encodeURIComponent(page.query)}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        headline: page.title,
        description: page.description,
        image: visuals.length ? visuals.map((visual) => visual.abs) : absoluteImg,
        author: { '@type': 'Organization', name: SITE_NAME },
        publisher: { '@type': 'Organization', name: SITE_NAME },
        datePublished: today,
        dateModified: today,
        mainEntityOfPage: pageUrl(page),
        inLanguage: 'ko-KR'
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: SITE_URL },
          { '@type': 'ListItem', position: 2, name: '검색 가이드', item: `${SITE_URL}/guide/` },
          { '@type': 'ListItem', position: 3, name: page.keyword, item: pageUrl(page) }
        ]
      }
    ]
  };
  const heroVisualHtml =
    '<div class="hero-visual" aria-label="' +
    htmlEscape(page.keyword) +
    ' 관련 상품 이미지">' +
    visuals
      .map(
        (visual, index) => `<figure class="visual-card v${index + 1}">
          <img src="${visual.src}" alt="${htmlEscape(visual.label)}" width="360" height="270" ${index === 0 ? 'loading="eager"' : 'loading="lazy"'} decoding="async">
          <figcaption>${htmlEscape(visual.label)}</figcaption>
        </figure>`
      )
      .join('\n        ') +
    '</div>';
  const visualStripHtml =
    '<section class="visual-strip" aria-labelledby="visual-strip-title">' +
    '<div><span>이미지로 먼저 보기</span><h2 id="visual-strip-title">' +
    htmlEscape(page.keyword) +
    '과 함께 보면 좋은 상품 이미지</h2></div>' +
    '<div class="visual-strip-grid">' +
    visuals
      .map(
        (visual) => `<figure>
          <img src="${visual.src}" alt="${htmlEscape(visual.label)}" width="360" height="270" loading="lazy" decoding="async">
          <figcaption>${htmlEscape(visual.label)}</figcaption>
        </figure>`
      )
      .join('\n        ') +
    '</div></section>';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${htmlEscape(page.title)} | ${SITE_NAME}</title>
  <meta name="description" content="${htmlEscape(page.description)}">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <link rel="canonical" href="${pageUrl(page)}">
${faviconTags()}
  <meta property="og:type" content="article">
  <meta property="og:locale" content="ko_KR">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:title" content="${htmlEscape(page.title)}">
  <meta property="og:description" content="${htmlEscape(page.description)}">
  <meta property="og:url" content="${pageUrl(page)}">
  <meta property="og:image" content="${absoluteImg}">
  <meta property="og:image:secure_url" content="${absoluteImg}">
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:image:alt" content="${htmlEscape(primaryVisual.label)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${absoluteImg}">
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
${analyticsTag()}
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f6f8f4;color:#172018;line-height:1.72}
    a{color:inherit}
    .wrap{max-width:980px;margin:0 auto;background:#fff;min-height:100vh;box-shadow:0 22px 70px rgba(15,23,42,.08)}
    header{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:18px 22px;border-bottom:1px solid #e5eadf;background:#fff;position:sticky;top:0;z-index:10}
    .brand{display:flex;align-items:center;gap:10px;text-decoration:none;font-weight:900;color:#172018}
    .mark{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:10px;background:#193d22;color:#d7ff52;font-weight:900}
    nav{display:flex;gap:14px;font-size:13px;color:#4b5563;font-weight:800}
    nav a{text-decoration:none}
    .hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,420px);gap:24px;align-items:center;padding:36px 22px;background:linear-gradient(135deg,#f4ffe8 0%,#fff 58%,#edf7ff 100%)}
    .kicker{display:inline-flex;margin-bottom:10px;padding:4px 10px;border-radius:999px;background:#e8f7da;color:#315b11;font-size:12px;font-weight:900}
    h1{font-size:36px;line-height:1.22;letter-spacing:0;margin-bottom:12px}
    .lead{font-size:17px;color:#475569;font-weight:700}
    .hero-visual{position:relative;display:grid;grid-template-columns:1fr 1fr;gap:10px;min-height:340px}
    .visual-card{position:relative;overflow:hidden;border-radius:18px;background:#fff;border:1px solid rgba(193,213,182,.8);box-shadow:0 16px 36px rgba(15,23,42,.1)}
    .visual-card img{display:block;width:100%;height:100%;object-fit:cover}
    .visual-card figcaption{position:absolute;left:10px;right:10px;bottom:10px;padding:7px 9px;border-radius:999px;background:rgba(14,44,25,.88);color:#fff;font-size:11px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .visual-card.v1{grid-row:span 2}
    .visual-card.v1 img{min-height:340px}
    .visual-card.v2 img,.visual-card.v3 img,.visual-card.v4 img{min-height:105px}
    .cta-row{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}
    .btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 18px;border-radius:10px;text-decoration:none;font-weight:900}
    .btn.primary{background:#193d22;color:#fff}
    .btn.secondary{background:#fff;color:#193d22;border:1px solid #b7d9a5}
    main{padding:28px 22px}
    .summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:28px}
    .summary div{padding:16px;border:1px solid #dfead8;border-radius:12px;background:#fbfdf8}
    .summary b{display:block;margin-bottom:6px;color:#193d22}
    .visual-strip{margin:4px auto 28px;max-width:860px;padding:20px;border:1px solid #dfead8;border-radius:18px;background:linear-gradient(135deg,#ffffff 0%,#f7fff0 100%)}
    .visual-strip>div:first-child span{display:inline-flex;margin-bottom:6px;padding:4px 9px;border-radius:999px;background:#e8f7da;color:#315b11;font-size:12px;font-weight:900}
    .visual-strip h2{font-size:22px;line-height:1.35;margin-bottom:14px}
    .visual-strip-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
    .visual-strip figure{overflow:hidden;border-radius:14px;background:#fff;border:1px solid #e1ead9}
    .visual-strip img{display:block;width:100%;aspect-ratio:1/1;object-fit:cover}
    .visual-strip figcaption{padding:8px 9px;color:#193d22;font-size:12px;font-weight:900;line-height:1.35}
    article{max-width:760px;margin:0 auto}
    article h2{font-size:24px;line-height:1.35;margin:28px 0 10px;color:#172018}
    article p{font-size:16px;color:#374151;margin-bottom:12px}
    .note{margin:22px 0;padding:16px;border:1px solid #dcead2;border-radius:12px;background:#fbfdf8;color:#315b11;font-weight:800}
    .related{margin-top:34px;padding-top:22px;border-top:1px solid #e5eadf}
    .related h2{font-size:22px;margin-bottom:12px}
    .related-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
    .related-grid a{padding:13px;border:1px solid #dfead8;border-radius:10px;text-decoration:none;font-weight:900;color:#193d22;background:#fff}
    .final-cta{margin:28px auto 0;max-width:760px;padding:22px;border-radius:18px;background:#123b24;color:#fff;box-shadow:0 18px 44px rgba(18,59,36,.18)}
    .final-cta h2{font-size:24px;line-height:1.35;margin-bottom:8px;color:#fff}
    .final-cta p{margin-bottom:16px;color:#d8f8df;font-weight:700}
    .final-cta .btn{background:#d7ff52;color:#193d22}
    footer{padding:24px 22px;background:#16251a;color:#d9ead3;text-align:center;font-size:13px}
    @media(max-width:720px){
      header{align-items:flex-start;flex-direction:column}
      nav{flex-wrap:wrap}
      .hero{grid-template-columns:1fr;padding:28px 16px}
      .hero-visual{min-height:auto}
      .visual-card.v1 img{min-height:230px}
      h1{font-size:29px}
      main{padding:22px 16px}
      .summary{grid-template-columns:1fr}
      .visual-strip{padding:16px}
      .visual-strip-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      .related-grid{grid-template-columns:1fr}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <a class="brand" href="/"><span class="mark">O</span><span>${SITE_NAME}</span></a>
      <nav>
        <a href="/">재고 검색</a>
        <a href="/guide/">검색 가이드</a>
        <a href="/site-map.html">사이트맵</a>
      </nav>
    </header>
    <section class="hero">
      <div>
        <span class="kicker">${htmlEscape(page.keyword)}</span>
        <h1>${htmlEscape(page.title)}</h1>
        <p class="lead">${htmlEscape(page.lead)}</p>
        <div class="cta-row">
          <a class="btn primary" href="${cta}">올리브재고에서 재고 검색하기</a>
          <a class="btn secondary" href="/guide/">다른 검색어 보기</a>
        </div>
      </div>
      ${heroVisualHtml}
    </section>
    <main>
      <section class="summary" aria-label="핵심 요약">
        ${page.points.map((point, index) => `<div><b>${index + 1}. ${htmlEscape(point)}</b><span>${htmlEscape(page.keyword)} 관련 검색에서 먼저 보면 좋은 기준입니다.</span></div>`).join('\n        ')}
      </section>
      ${visualStripHtml}
      <article>
        ${page.sections.map(([heading, body]) => `<h2>${htmlEscape(heading)}</h2>\n        <p>${htmlEscape(body)}</p>`).join('\n        ')}
        <div class="note">${SITE_NAME}에서는 상품명 검색 후 매장 재고, 온라인 재고, 인기상품 흐름을 함께 확인할 수 있습니다. 최종 가격과 구매 가능 조건은 연결된 구매 화면에서 다시 확인하세요.</div>
      </article>
      <section class="related" aria-labelledby="related-title">
        <h2 id="related-title">함께 보면 좋은 올리브영 재고 가이드</h2>
        <div class="related-grid">
          ${related.map((item) => `<a href="/guide/${item.slug}/">${htmlEscape(item.keyword)}</a>`).join('\n          ')}
        </div>
      </section>
      <section class="final-cta" aria-label="재고 검색 바로가기">
        <h2>${htmlEscape(page.query)} 재고를 지금 바로 확인해보세요</h2>
        <p>상품명을 입력하면 근처 매장 재고, 온라인 재고, 인기상품 흐름을 한 화면에서 비교할 수 있습니다.</p>
        <a class="btn" href="${cta}">올리브재고 접속 바로가기</a>
      </section>
    </main>
    <footer>${SITE_NAME} · 올리브영 재고확인과 인기상품 랭킹을 빠르게 비교하는 검색 도구</footer>
  </div>
</body>
</html>`;
}

function guideIndexTemplate() {
  const items = pages
    .map(
      (page) => {
        const visual = guideVisuals(page)[0] || { src: `/images/${imageName(page)}`, label: page.keyword };
        return `<a href="/guide/${page.slug}/">
        <img src="${visual.src}" alt="${htmlEscape(visual.label)}" width="360" height="270" loading="lazy" decoding="async">
        <strong>${htmlEscape(page.keyword)}</strong>
        <span>${htmlEscape(page.description)}</span>
      </a>`;
      }
    )
    .join('\n      ');
  const indexVisual = guideVisuals(pages[0])[0] || {
    abs: SITE_URL + '/images/olivestock-og-image.svg',
    label: '올리브영 재고 검색 가이드'
  };
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>올리브영 재고 검색 가이드 | ${SITE_NAME}</title>
  <meta name="description" content="올리브영 재고확인, 매장 재고, 온라인 재고, 인기상품 랭킹 검색어별 가이드를 모았습니다.">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <link rel="canonical" href="${SITE_URL}/guide/">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="ko_KR">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:title" content="올리브영 재고 검색어별 확인 가이드">
  <meta property="og:description" content="올리브영 재고확인, 매장 재고, 온라인 재고, 인기상품 랭킹 검색어별 가이드를 모았습니다.">
  <meta property="og:url" content="${SITE_URL}/guide/">
  <meta property="og:image" content="${indexVisual.abs}">
  <meta property="og:image:secure_url" content="${indexVisual.abs}">
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:image:alt" content="${htmlEscape(indexVisual.label)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${indexVisual.abs}">
${faviconTags()}
${analyticsTag()}
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f6f8f4;color:#172018;line-height:1.65}
    .wrap{max-width:980px;margin:0 auto;background:#fff;min-height:100vh;padding:28px 20px;box-shadow:0 22px 70px rgba(15,23,42,.08)}
    header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:26px}
    .brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:#172018;font-weight:900}
    .mark{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:10px;background:#193d22;color:#d7ff52}
    h1{font-size:34px;line-height:1.22;margin-bottom:10px}
    p{color:#475569;font-weight:700}
    .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:24px}
    .grid a{display:flex;flex-direction:column;gap:8px;min-height:132px;padding:12px;border:1px solid #dfead8;border-radius:14px;background:#fff;color:#172018;text-decoration:none;box-shadow:0 8px 20px rgba(15,23,42,.04)}
    .grid img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:10px;background:#f1f5ec}
    .grid strong{color:#193d22}
    .grid span{font-size:13px;color:#64748b}
    @media(max-width:720px){.grid{grid-template-columns:1fr}h1{font-size:28px}}
  </style>
</head>
<body>
  <main class="wrap">
    <header>
      <a class="brand" href="/"><span class="mark">O</span><span>${SITE_NAME}</span></a>
      <a href="/">재고 검색으로 돌아가기</a>
    </header>
    <h1>올리브영 재고 검색어별 확인 가이드</h1>
    <p>재고확인, 재고조회, 매장 재고, 온라인 재고, 인기상품 랭킹처럼 자주 찾는 검색 의도를 페이지별로 정리했습니다.</p>
    <section class="grid">
      ${items}
    </section>
  </main>
</body>
</html>`;
}

function siteMapTemplate() {
  const links = [
    ['홈', '/'],
    ['검색 가이드', '/guide/'],
    ...pages.map((page) => [page.keyword, `/guide/${page.slug}/`])
  ];
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>사이트맵 | ${SITE_NAME}</title>
  <meta name="description" content="올리브재고 사이트맵입니다. 올리브영 재고확인 가이드와 검색 페이지를 확인하세요.">
  <meta name="robots" content="index,follow">
  <link rel="canonical" href="${SITE_URL}/site-map.html">
${faviconTags()}
${analyticsTag()}
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f6f8f4;color:#172018}
    main{max-width:820px;margin:0 auto;padding:32px 18px;background:#fff;min-height:100vh}
    h1{font-size:30px}
    ul{margin-top:20px;display:grid;gap:10px}
    li{list-style:none}
    a{display:block;padding:12px 14px;border:1px solid #dfead8;border-radius:10px;color:#193d22;text-decoration:none;font-weight:800}
  </style>
</head>
<body>
  <main>
    <h1>${SITE_NAME} 사이트맵</h1>
    <ul>
      ${links.map(([label, href]) => `<li><a href="${href}">${htmlEscape(label)}</a></li>`).join('\n      ')}
    </ul>
  </main>
</body>
</html>`;
}

function sitemapXml() {
  const urls = [
    { loc: SITE_URL + '/', priority: '1.0', changefreq: 'daily' },
    { loc: SITE_URL + '/guide/', priority: '0.9', changefreq: 'weekly' },
    { loc: SITE_URL + '/site-map.html', priority: '0.5', changefreq: 'monthly' },
    ...pages.map((page) => ({
      loc: pageUrl(page),
      priority: '0.8',
      changefreq: 'weekly'
    }))
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (url) => `  <url>
    <loc>${xmlEscape(url.loc)}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${url.changefreq}</changefreq>
    <priority>${url.priority}</priority>
  </url>`
  )
  .join('\n')}
</urlset>
`;
}

function rssXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${SITE_NAME} 검색 가이드</title>
    <link>${SITE_URL}/guide/</link>
    <description>올리브영 재고확인과 인기상품 랭킹 관련 검색 가이드</description>
    <language>ko-KR</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${pages
  .map(
    (page) => `    <item>
      <title>${xmlEscape(page.title)}</title>
      <link>${pageUrl(page)}</link>
      <guid>${pageUrl(page)}</guid>
      <description>${xmlEscape(page.description)}</description>
      <pubDate>${new Date().toUTCString()}</pubDate>
    </item>`
  )
  .join('\n')}
  </channel>
</rss>
`;
}

async function writeTextIfChanged(filePath, content) {
  try {
    const current = await fs.readFile(filePath, 'utf8');
    if (current.replace(/\r\n/g, '\n') === String(content).replace(/\r\n/g, '\n')) {
      return;
    }
  } catch (_) {}
  await fs.writeFile(filePath, content, 'utf8');
}

async function main() {
  await fs.mkdir(guideDir, { recursive: true });
  await fs.mkdir(imageDir, { recursive: true });
  await writeTextIfChanged(path.join(imageDir, 'olivestock-og-image.svg'), guideImage(pages[0]));

  for (const page of pages) {
    const dir = path.join(guideDir, page.slug);
    await fs.mkdir(dir, { recursive: true });
    await writeTextIfChanged(path.join(dir, 'index.html'), pageTemplate(page, pages));
    await writeTextIfChanged(path.join(imageDir, imageName(page)), guideImage(page));
  }

  await writeTextIfChanged(path.join(guideDir, 'index.html'), guideIndexTemplate());
  if (WRITE_DISCOVERY_FILES) {
    await writeTextIfChanged(path.join(publicDir, 'site-map.html'), siteMapTemplate());
    await writeTextIfChanged(
      path.join(publicDir, 'robots.txt'),
      `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`
    );
    await writeTextIfChanged(path.join(publicDir, 'sitemap.xml'), sitemapXml());
    await writeTextIfChanged(path.join(publicDir, 'rss.xml'), rssXml());
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
