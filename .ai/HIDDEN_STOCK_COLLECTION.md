# 숨겨진 옵션 수집 운영 안내

2026-09-13 작성. 운영 배포·수집 활성화의 최종 결과는 [HANDOFF.md](HANDOFF.md)에서 확인한다. 이 파일은 `public/` 밖의 운영 문서로 웹사이트 정적 배포 대상이 아니며, 공개 저장소에는 포함될 수 있으므로 비밀값을 기록하지 않는다.

## 명령어 없이 바로 수집하기

1. [oy-stock 수집 Actions](https://github.com/kangbumhee/oy-stock/actions/workflows/hidden-stock-collect.yml)를 연다.
2. **Collect Hidden OliveYoung Options → Run workflow**에서 배포된 `main`을 선택한다. 처리 단계는 기본 `100`을 유지하고 **Run workflow**를 누른다.
3. 실행을 열어 **Summary**에서 처리/발견/실패 수, 남은 대기열과 다음 실행 시각을 확인한다. 최대8분 후 저장된 위치에서 멈추며 다음 실행이 이어받는다. 초록색 종료도 전체 수집 완료를 의미하지 않는다.

초기 설정이 끝나면 매시17분에 같은 작업이 시작되므로 PC나 브라우저를 계속 켜둘 필요가 없다. 예약은 기본 브랜치에서만 실행되고 GitHub 부하에 따라 지연·누락될 수 있다. 공개 저장소는60일간 활동이 없으면 예약이 비활성화될 수 있다. [GitHub 예약 실행 안내](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## 최초 활성화와 일시 중지

- 선행 조건: Cloud Run 및 Vercel 새 코드 배포, 비공개 Blob 연결, 내부 인증 상태 조회 성공.
- 저장소 **Settings → Secrets and variables → Actions → Secrets**에 `HIDDEN_STOCK_SERVICE_SECRET`을 설정한다. Vercel/Cloud Run과 같은 별도 서비스 인증값이어야 한다. 원문을 채팅·명령 인자·로그에 붙이지 않는다.
- **Variables**의 `HIDDEN_STOCK_COLLECTION_ENABLED`를 `true`로 설정하면 수동/예약 job이 모두 허용된다. 미설정 또는 `false`는 모두 건너뛴다. `.env`만 변경해서는 켜지지 않는다. 선택 `HIDDEN_STOCK_SERVICE_URL`은 배포된 HTTPS Cloud Run origin이다.
- 일시 중지는 위 Variable을 `false`로 바꾼다. 이미 실행 중인 작업까지 중단해야 할 때만 해당 실행에서 **Cancel workflow**를 사용한다. 저장된 진행정보는 지우지 않는다.
- 인증키 누락은 실행하지 않았다는 경고,401/403은 설정 점검이 필요한 실패다.429/503/통신 오류는 대기·백오프로 멈추며 완료로 처리하지 않는다.

워크플로는 `hidden-stock-collection` 동시성 그룹과 `cancel-in-progress:false`를 사용한다. 새 실행이 기존 실행을 강제 중단하지 않지만, 이미 대기 중인 실행은 더 최근 요청으로 교체될 수 있으므로 버튼을 반복해서 누를 필요가 없다. [GitHub 동시 실행 안내](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

## 무엇을 얼마나 갱신하나

- 공개 카탈로그를20개씩 열거하고 상품번호 중복을 제거한다. 기준 상품을 먼저 조사하고 관련 상품은 별도 큐에서 순차 처리한다.
- 숨김/부분 상품은 하루, 일반 상품은7일이 지나면 재조회 대상으로 삼는다. 카탈로그는 마지막 열거 완료24시간 후 다시 시작한다. 대기열·실패·업스트림 제한 때문에 실제 갱신은 늦어질 수 있다.
- 서버 요청 하나는 최대5단위/30초이며 숨김 검색·전체 매장 조회를 우선한다.150초 CAS lease와 비공개 체크포인트로 중복 수집을 막고 중단 후 이어간다. 워크플로 기본 한 번은100단계·8분 한도, 요청 간격1초다. 알려진 상품/대기열은 각각50,000개 상한이며 도달 시 완료가 아닌 한도 상태로 표시한다.
- **매시 실행은 모든 SKU를 매시간 새로 확인한다는 뜻이 아니다.** 이 작업은 옵션 발견 자료를 갱신하며 전국 매장의 수량은 사용자가 재고 조회를 누를 때 확인한다.
- 공식 자료에 한 번도 노출되지 않은 옵션까지 발견하거나 모든 실물 매장의 판매 가능성을 보장하지 않는다. 부분 결과·미확인 수량·조회 실패를 전체 품절로 표시하지 않는다.

LLM API를 호출하지 않으므로 수집 자체의 AI 토큰 비용은 없다. 공개 저장소에서 표준 `ubuntu-latest` 실행 시간은 GitHub Actions 무료 대상이지만 Cloud Run·Blob의 처리/저장/전송 사용량 비용은 별도다. 저장소 공개 여부나 runner를 바꾸면 비용 조건을 다시 확인한다. [GitHub Actions 요금 기준](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## 개발자용 상태 확인 (선택)

안전하게 설정된 `HIDDEN_STOCK_SERVICE_SECRET` 및 선택 `HIDDEN_STOCK_SERVICE_URL` 환경에서만 실행한다. 상태 조회는 수집을 시작하지 않는다.

```sh
node scripts/collect-hidden-stock.mjs --status
```

직접 수집이 필요한 운영자는 다음 한정 실행을 사용할 수 있다. 보통은 위 GitHub 버튼으로 충분하다.

```sh
node scripts/collect-hidden-stock.mjs --steps 100 --max-seconds 480 --delay-ms 1000
```

내부 경로는 서비스 Bearer 전용 `GET /api/hidden-stock?action=status`와 `POST /api/hidden-stock?action=collect`다. 공개 gateway는 이 action을 허용하지 않는다. CLI/Summary에는 안전한 숫자 진행률만 남기고 SKU·숨김 상품명·토큰을 출력하지 않는다. 기존 `backfill-hidden-stock.mjs`의 `--refresh`는 기존 scan만 다시 시작하며 상품 자료와 정기 수집 대기열/진행정보는 보존한다. 고급 복구용이므로 일반 운영은 `collect`를 사용하고 정기 수집과 겹쳐 실행하지 않는다.
