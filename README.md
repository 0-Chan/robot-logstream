# Robot Logstream

[![CI](https://github.com/0-Chan/robot-logstream/actions/workflows/ci.yml/badge.svg)](https://github.com/0-Chan/robot-logstream/actions/workflows/ci.yml)

4족 보행 로봇의 센서 기록을 웹에서 시간 동기화해 재생하는 대시보드입니다.

**Live Demo:** https://robot-logstream.0-chan.kim

![Robot Logstream 재생 화면](docs/screenshot.jpg)

3D 점군 지도, RGB 카메라와 깊이 카메라, 관절과 IMU 차트가 하나의 재생 시각에 맞춰 함께 움직입니다.

## 소개

ETH Zurich RSL의 [GrandTour 데이터셋](https://huggingface.co/datasets/leggedrobotics/grand_tour_dataset) 시퀀스를 **WebSocket으로 재생**합니다. 4족 보행 로봇 ANYmal D가 녹화한 LiDAR, 카메라, IMU, 관절, GNSS 데이터를 다룹니다.

- **WebSocket 실시간 스트리밍:** 서버가 연결마다 재생 시계를 두고, 화면에 보이는 토픽만 그 시각에 맞춰 보냅니다. seek와 배속에도 모든 패널이 같은 시각을 유지하고, 클라이언트가 느리면 오래된 프레임을 건너뜁니다.
- **정확한 표시:** 재생 시각보다 미래의 데이터나 이전 위치의 데이터는 그리지 않습니다. 지연과 연결 끊김은 상태 점과 실측 fps로 보여 줍니다.
- **간이 CAD 위치 추정:** 점군 지도에서 벽과 바닥만 뽑은 간이 CAD로 로봇 위치를 다시 계산하고, 그 오차를 대시보드에서 비교합니다.
- **자동 배포:** AWS Lightsail에서 운영하며, main에 push하면 CI를 거쳐 몇 분 안에 서버에 반영됩니다.

```
data/raw/<seq>/          preprocess (Python)            data/prepared/<seq>/        server (TS, Hono)                web (React)
Zarr-in-tar · 이미지 tar ─▶ 디코딩·재청크·양자화·축소 ─▶ 프레임 파일 + 인덱스 ─▶ 재생 시계 · 구독 · 배압 ─WS─▶ 3D · 카메라 · 차트
yaml · ply                                          manifest.json · static/    정적 자산 ────────────HTTP─▶ 맵 · TF
```

원칙은 하나입니다. **무거운 처리는 모두 전처리에서 끝내고**, 서버는 "인덱스 조회 → 바이트 읽기 → 소켓 전송"만 합니다.

## 설치

| 도구 | 확인한 버전 | 용도 |
|---|---|---|
| [uv](https://docs.astral.sh/uv/) | 0.11 | 전처리 (Python 3.12를 자동으로 설치) |
| Node.js | 22 이상 (CI와 Docker는 24) | 서버, 웹 |
| pnpm | 11 | TS 워크스페이스 |
| 디스크 여유 공간 | 원본 32 GB + prepared 약 12 GB | |

데이터셋은 저장소에 없습니다. 원본을 받아 전처리한 뒤 서버와 웹을 띄웁니다. 단계별 명령, 옵션, 출력 형식은 **[docs/local-setup.md](docs/local-setup.md)** 에 있습니다.

1. 원본 시퀀스를 Hugging Face에서 `data/raw/`로 받기
2. `uv run prep`으로 `data/prepared/`를 만들고 `uv run verify`로 검증
3. 서버 실행
4. 웹 실행

## 사용법

전처리가 끝났다면 의존성을 설치하고, 서버와 웹을 각각 다른 터미널에서 실행합니다.

```bash
cd dashboard && pnpm install
pnpm --filter @grandtour/server dev        # http://localhost:8787, ws://localhost:8787/ws
pnpm --filter @grandtour/web dev           # http://localhost:5173
```

| 영역 | 내용 |
|---|---|
| 하단 재생 바 | 재생/일시정지, 속도(×0.25~×4), 타임라인 Slider seek, 연결 상태와 수신 MB/s·fps |
| 3D 뷰 | 선택한 LiDAR 스캔(intensity 색), DLIO 맵 좌표계 또는 센서 박스 좌표계, 정적 지도, 로봇 박스, 궤적 |
| 카메라 2칸 | 컬러 또는 깊이(turbo 색, 0.3~8 m). 오른쪽 위 배지는 상태 점(초록 최신, 노랑 이전 샘플, 회색 샘플 없음, 빨강 연결 끊김)과 최근 1초 동안 그린 프레임 수(실측 fps) |
| 차트 2개 | 아무 시계열 토픽과 열(검색 가능한 멀티 셀렉트, 최대 8개). 관절·발 접촉·IMU·배터리 프리셋, 최근 10초 표시 |

서버 연결이 끊기면 알림(토스트)이 뜨고 2초마다 다시 연결합니다. 화면에 보이는 토픽만 구독합니다. 패널 선택을 바꾸면 `subscribe` 메시지가 다시 전송됩니다.

## 폴더 구조

```
grand_tour/
├── README.md
├── LICENSE
├── docs/                               로컬 설치와 실행 문서, 스크린샷
├── .github/workflows/ci.yml            검사, 이미지 push, 배포 확인
├── infra/lightsail/                    Terraform: Lightsail 인스턴스
├── deploy/                             서버용 compose, Caddyfile, 갱신 타이머
├── data/                               (저장소에 없음)
│   ├── raw/2024-11-02-17-10-25/        원본 (HF에서 받은 그대로, 읽기 전용, 32 GB)
│   └── prepared/2024-11-02-17-10-25/   전처리 결과 (서버가 읽음, 약 12 GB)
└── dashboard/                          코드 (pnpm workspace)
    ├── preprocess/                     Python: 원본 → prepared 변환과 검증
    ├── packages/protocol/              TS: manifest 타입, WebSocket 메시지 encode/decode (서버·웹 공용)
    ├── apps/server/                    TS: Hono + @hono/node-server WebSocket 재생 서버
    └── apps/web/                       TS: Vite + React 대시보드
```

---

## WebSocket 프로토콜 요약 (v2)

자세한 내용은 `dashboard/packages/protocol/src/messages.ts`에 있습니다.

**제어 메시지 (JSON 텍스트)**
- 서버 → 클라이언트: `hello{sessionId, manifest}`, 100 ms마다 `clock{t, playing, speed, epoch}`, `error`
- 클라이언트 → 서버: `subscribe{topics:[{name, maxHz?}]}`(교체 방식), `play{speed?}`, `pause`, `speed{speed}`, `seek{t, epoch}`
- **epoch는 클라이언트가 정합니다.** seek마다 이전보다 큰 값을 보내고, 서버는 그 뒤 만드는 데이터에 그 값을 찍습니다. 같거나 작은 epoch의 seek는 거부합니다.

**데이터 메시지 (바이너리, 16바이트 헤더)**
```
[u8 version][u8 msgType][u16 topicId][u32 epoch][f64 timestamp] | payload
FRAME (1)        : frames.bin의 한 프레임 그대로 (점군 / JPEG / PNG)
SERIES_BATCH (2) : [u32 count][u32 cols][f64 ts × count][f32 values × count × cols]
```

**서버 동작 (`apps/server/src/session.ts`)**
- 연결마다 독립된 재생 시계를 두고, 20 ms tick마다 처리합니다.
- 시계열: 지난 tick 이후 샘플을 `maxHz`로 줄여 보냅니다. 버리지 않습니다.
- 프레임: 재생 시각의 최신 프레임이 바뀌었을 때만 보냅니다. 소켓에 2 MB 넘게 쌓여 있으면 그 tick은 건너뜁니다(최신 우선).
- seek: 클라이언트가 보낸 epoch로 바꾸고 시계열 5초치를 백필합니다. 읽는 도중 seek가 들어온 프레임은 보내지 않습니다.
- 기록 끝에서 `play`를 받아도 스스로 처음으로 돌아가지 않습니다(새 epoch가 필요하므로 클라이언트가 seek를 먼저 보냄).
- 웹소켓은 `@hono/node-server` 내장 `upgradeWebSocket`과 `ws`의 `WebSocketServer`를 씁니다. 배압 판단에 필요한 `bufferedAmount`는 `ws.raw`에서 읽습니다.

## 화면에 잘못된 데이터를 표시하지 않기 위한 규칙

고빈도 센서 처리(worker + `data/live.ts`)와 React 상태(zustand)를 분리합니다. 센서 메시지가 React 렌더링을 일으키지 않고, 렌더러는 `requestAnimationFrame`에서 데이터를 읽기만 합니다.

| 단계 | 규칙 | 코드 |
|---|---|---|
| 수신 (worker) | 현재 소켓 + 현재 epoch + 토픽별로 더 새로운 시각인 메시지만 통과. 이미지·깊이는 **디코딩이 끝난 뒤 한 번 더 검사** | `apps/web/src/net/gate.ts` |
| seek | worker가 epoch를 올리는 즉시 메인 스레드가 이전 위치의 프레임·점군·시계열을 모두 버림 → "이동 중…" | `net/worker.ts`, `data/live.ts` |
| 표시 | 모든 패널이 같은 함수로 판정: `ok` / `stale`(센서 주기 3배 또는 0.3초 초과, 흐리게) / `future`(재생 시각 뒤, 절대 표시 안 함) / `none`(2초 초과 또는 없음) / `disconnected` | `data/select.ts` |
| 연결 끊김 | 재생 시각을 즉시 멈추고, 마지막 화면에 "연결 끊김" 표시. 재생 조작 비활성. 재연결하면 같은 시각·같은 재생 상태로 이어서 재생 | `data/clock.ts`, `net/client.ts` |
| 3D 정렬 | 점군은 **스캔 시각의 포즈**(보간)로 배치. 포즈를 알 수 없으면 그리지 않음 | `ui/Viewer3D.tsx` |

**검증 방법**
- 단위 테스트: `pnpm -r test` (게이트, 선택 규칙, 재생 시계, 서버 세션의 epoch 처리)
- 서버 seek 폭주: `pnpm --filter @grandtour/server probe -- --storm 20 --seconds 30` → `0 violations`
- 브라우저 표시 감사: 개발 콘솔에서 `__liveAudit` → 프레임을 그릴 때마다 epoch와 시각을 검사한 결과. `violations`는 항상 0이어야 합니다.
- 느린 디코딩 재현(개발 모드): `http://localhost:5173/?decodeDelay=400`

## 간이 CAD 지도와 CAD 기반 위치 추정 (오프라인 검증)

GrandTour 데이터셋에는 현장 CAD가 없습니다. 그래서 DLIO 점군 지도에서 **큰 평면(벽, 바닥, 천장)만 뽑아 간이 CAD를 만들고**, 녹화된 LiDAR 스캔을 그 CAD에 맞춰 로봇 위치를 다시 계산합니다. 로봇에 탑재해 실시간으로 도는 위치 추정이 아니라, **"설계도 수준의 단순한 지도로 위치를 유지할 수 있는가"를 녹화 데이터로 확인하는 파이프라인**입니다.

```bash
cd dashboard/preprocess
P=../../data/prepared/2024-11-02-17-10-25
uv run cad-extract --prepared $P   # 지도 → cad/site.yaml (벽·슬래브 목록, 손으로 고쳐도 됨)
uv run cad-build   --prepared $P   # site.yaml → cad/site.step (mm, CAD 프로그램용) + static/cad.glb (m, 웹용)
uv run localize    --prepared $P   # 스캔 × CAD → topics/cad_localization (+ summary.json), manifest 갱신
```

1. **cad-extract:** RANSAC으로 평면을 반복해 찾습니다. 각 평면의 점을 0.25 m 격자에 찍고 직사각형 몇 개로 덮습니다. 그래서 문이 뚫린 벽은 여러 조각이 됩니다. 경사면(계단, 램프)은 제외합니다.
   - `site.yaml` 규칙: 벽의 **면**은 선분 a→b입니다. 두께는 위에서 볼 때 a→b의 **오른쪽**으로 붙고, 로봇이 보는 쪽은 왼쪽입니다.
   - 슬래브는 다각형 높이 z가 면입니다. `side: down`이면 바닥, `side: up`이면 천장입니다.
2. **cad-build:** CadQuery로 솔리드를 만들어 STEP(mm)으로 저장합니다. 같은 솔리드를 삼각형으로 바꿔 GLB(m, Z-up, 노드 이름 `wall_NNN`/`slab_NNN`)로도 저장합니다.
   - 지도 점이 CAD 표면에서 얼마나 가까운지를 `static/cad.json`의 `mapFit`에 기록합니다.
3. **localize:** 스캔마다 다음을 반복합니다.
   - **예측:** 이전 위치를 다리 오도메트리(`anymal_state_odometry`)만큼 옮깁니다.
   - **보정:** CAD 면까지의 point-to-plane ICP를 오도메트리 예측을 사전 정보(prior)로 둔 최적화로 풉니다. 그래서 CAD가 잡아 주지 못하는 방향(예: 가로 벽이 없는 긴 보행로의 길이 방향)은 오도메트리를 따르고 미끄러지지 않습니다.
   - DLIO는 **첫 위치를 정할 때와 채점할 때만** 씁니다.
   - 출력 열은 `pose_*`(DLIO와 같은 이름), `fitness`, `rmse`, `lost`, `constrainedDims`(CAD가 오도메트리보다 강하게 잡아 준 방향 수, 0~6), `err_pos`, `err_yaw`(DLIO 대비), `odom_err_pos`(오도메트리만 썼을 때의 오차)입니다.

웹에서는 사이드바 **지도 → 간이 CAD / 겹쳐 보기**, **CAD 위치 추정 마커**(주황, 실패 구간은 빨강)를 켜고, 차트 프리셋 **CAD 위치 추정 오차**, **CAD 정합 품질**을 고르면 됩니다. CAD는 로봇 높이 + 1.5 m 위를 잘라서 표시합니다.

**이 시퀀스 결과(2024-11-02-17-10-25, hesai 스캔 3,865개):**

| 항목 | 값 |
|---|---|
| 간이 CAD | 벽 43개, 슬래브 200개. 지도 점의 46%가 CAD 표면 10 cm 이내 |
| CAD 위치 추정 오차(DLIO 대비) | 평균 0.32 m, p95 0.78 m, 최대 1.47 m, 방향각 p95 1.5° |
| 오도메트리만 쓴 경우 | 최대 1.44 m |
| 시작 위치를 0.5 m, 10° 틀리게 준 경우 | 약 22초 뒤 벽이 보이는 구간에서 회복(평균 0.30 m) |
| 스캔 점 50%만 사용 | 평균 0.34 m, p95 0.91 m |

- 오차가 큰 구간은 벽이 없는 눈 덮인 광장(y ≈ −20 ~ −28 m)입니다. 바닥밖에 없어 수평 위치를 CAD로 잡을 수 없습니다.
- 작은 조각을 지운 CAD(`--min-area 3`)는 화면은 깔끔하지만 오차가 커졌습니다(평균 0.40 m, p95 1.0 m).

**한계:**
- CAD를 DLIO 지도에서 만들었기 때문에, DLIO와의 비교는 독립적인 검증이 아닙니다.
- `lost` 판정 기준(fitness, rmse, 보정량)은 이 시퀀스에서 한 번도 걸리지 않았습니다. 실제로 실패를 잡아내는지는 아직 확인하지 못했습니다.
- 실제 현장 CAD를 쓰려면 STEP을 GLB로 바꾸고, `dlio_map`(또는 로봇 지도)과 CAD 좌표 사이의 변환을 먼저 구해야 합니다.

## 배포 (AWS Lightsail)

서울 리전 Lightsail 인스턴스 한 대에 Docker로 **Node 서버 + Caddy**를 띄웁니다. Caddy가 HTTPS 인증서 발급, 프론트 정적 파일 제공, `/ws` 프록시를 맡습니다. **인증 없이 공개**되어, 주소를 아는 사람은 누구나 접속할 수 있습니다. 페이지와 서버가 같은 도메인이라 CORS 설정이 필요 없습니다.

```
infra/lightsail/   Terraform: 인스턴스(기본 small_3_0: 2 GB, 60 GB, 3 TB), 고정 IP, 방화벽(22/80/443), SSH 키
deploy/            compose.yaml, Caddyfile, .env.example, deploy.sh, updater/(1분 주기 이미지 갱신 타이머)
.github/workflows/ci.yml  검사 → GHCR 이미지 push → 서버 반영 확인
dashboard/Dockerfile  --target server (Node) / --target web (Caddy + 빌드된 프론트)
```

1. **인프라 만들기** (AWS 자격 증명 필요, 월 약 USD 12 과금 시작)
   ```bash
   aws login
   cd infra/lightsail
   cp terraform.tfvars.example terraform.tfvars   # SSH 공개키 경로, SSH 허용 IP
   terraform init && terraform plan && terraform apply
   terraform output                               # public_ip, site_address, deploy 명령
   ```
   - 첫 부팅 때 `user-data.sh`가 Docker, swap 2 GB, `/srv/robot-logstream`을 준비합니다. 1~2분 기다린 뒤 다음 단계로 넘어가세요.
2. **서버 준비** (저장소 루트에서, 처음 한 번)
   ```bash
   deploy/deploy.sh <public_ip>
   ```
   - `data/prepared/<시퀀스>`를 rsync로 올립니다. 첫 업로드는 약 11 GB입니다.
   - 첫 실행이라면 사이트 주소(기본 `<ip>.sslip.io`)와 알림 채널을 묻고 서버의 `.env`에 저장합니다.
   - compose.yaml, Caddyfile, 갱신 타이머를 설치하고 GHCR에서 이미지를 받아 시작합니다.
   - 데이터, compose.yaml, Caddyfile이 바뀌었을 때만 다시 실행합니다(데이터가 그대로면 `SKIP_DATA=1`).
3. **코드 배포는 자동입니다.** main에 push하면:
   - CI가 검사를 통과한 뒤 `ghcr.io/0-chan/robot-logstream-{server,web}`에 `<커밋 sha>`와 `latest` 태그로 이미지를 올립니다.
   - 서버의 `robot-logstream-update.timer`가 1분마다 새 이미지를 확인하고, 바뀐 컨테이너만 교체합니다. 교체 순간 접속이 몇 초 끊깁니다.
   - CI의 deploy job이 `/health`의 `version`이 그 커밋 sha가 될 때까지 기다려 성공 여부를 표시합니다. 대상 주소는 repo variable `DEPLOY_URL`이고, 비어 있으면(서버를 내렸을 때) 건너뜁니다.
   - GitHub에서 서버로 들어가는 접속은 없습니다. SSH는 계속 내 IP에서만 열려 있습니다.
   - **되돌리기:** 서버 `/srv/robot-logstream/.env`에 `IMAGE_TAG=<이전 sha>`를 넣으면 1분 안에 그 버전으로 바뀌고 고정됩니다. 비우면 다시 main을 따라갑니다.
   - **로그:** `journalctl -u robot-logstream-update -n 50`
   - 처음 한 번: GHCR 패키지 두 개를 Public으로 바꿔야 서버가 로그인 없이 받을 수 있습니다(GitHub → Packages → Package settings).
4. **도메인이 있다면** (지금은 `robot-logstream.0-chan.kim`) A 레코드를 고정 IP로 연결하고, 서버의 `/srv/robot-logstream/.env`에서 `SITE_ADDRESS`를 바꾼 뒤 `docker compose up -d`를 실행합니다.
5. **삭제:** `terraform destroy`. 그다음 repo variable `DEPLOY_URL`을 비웁니다. 고정 IP도 함께 해제됩니다. 인스턴스에서 떼어 둔 고정 IP는 과금됩니다.

**로컬에서 같은 구성으로 시험하기:** `deploy/.env.example`을 `deploy/.env`로 복사하고 다음을 설정합니다.
- `SITE_ADDRESS=:80`, `DATA_DIR=../data`, `HTTP_PORT=8080`
- GHCR 이미지 대신 직접 빌드한 이미지를 쓰려면 `IMAGE_TAG=dev`

그다음 `dashboard`에서 `docker buildx build --target server -t ghcr.io/0-chan/robot-logstream-server:dev --load .`와 같은 명령을 web 타깃에도 실행합니다. 마지막으로 `deploy`에서 `docker compose up`을 실행합니다.

**주의**
- 공개 사이트라 누구나 재생할 수 있습니다. 시청 1시간에 약 18 GB를 보내므로, 포함 송신량(3 TB, 시청 약 165시간)을 넘으면 GB당 USD 0.13가 과금됩니다. 접근을 막아야 하면 `Caddyfile`에 `basic_auth`를 넣거나 Cloudflare Access를 앞에 두세요.

### 송신량 알림 (재생은 막지 않음)

공개 사이트라서 송신량이 포함량을 넘기 전에 알림을 받도록 했습니다. 재생은 어떤 경우에도 막지 않습니다.

| 경로 | 무엇을 보나 | 언제 알리나 | 받는 곳 |
|---|---|---|---|
| **서버 알림**(1차) | 서버가 직접 센 이번 달 송신량(WebSocket + `/static`) | 포함량의 50·80·95·100%, 이후 10%p마다. 최근 1시간이 `SPIKE_GB_PER_HOUR`를 넘으면 '급증'(6시간에 한 번) | 서버 로그(항상), Slack, Discord, ntfy(휴대폰 푸시), 범용 웹훅, 이메일(SMTP) |
| **AWS Budgets**(2차 안전망) | Lightsail 청구 금액 | 예산의 80%·100%, 예상 금액 100% 초과 | 이메일(`alert_emails`), 선택적으로 SNS |

- **채널 설정:** 서버의 `/srv/robot-logstream/.env`(설명은 `deploy/.env.example`). `deploy.sh`가 첫 배포 때 각 URL을 묻습니다. 빈칸으로 두면 그 채널은 쓰지 않습니다.
  - **이메일:** `SMTP_URL`(예: Gmail 앱 비밀번호 `smtps://you%40gmail.com:app-password@smtp.gmail.com:465`)과 `ALERT_EMAIL_TO`를 넣습니다. 비밀번호에 `$`가 있으면 compose가 변수로 해석하므로 `$$`로 적으세요.
  - **휴대폰 푸시:** ntfy 앱에서 추측하기 어려운 토픽을 구독하고, 그 주소를 `NTFY_TOPIC_URL`에 넣습니다.
- **설정 확인:** `NOTIFY_TEST=1`이면 서버가 시작할 때 모든 채널로 시험 알림을 보냅니다. 첫 배포에서는 켜져 있으니, 확인한 뒤 비우고 `docker compose up -d`를 다시 실행하세요.
- **현재 사용량:** `curl https://<주소>/health`의 `transfer` 항목(이번 달 GB, %, 최근 1시간, 월말 예상, 초과 예상 비용)
- 이번 달 집계는 `state/transfer.json`에 저장되어 재시작해도 이어지고, 같은 알림을 다시 보내지 않습니다.
- 서버가 세지 못하는 몫(Caddy가 직접 주는 화면 파일, TLS 오버헤드)이 있어서 실제 송신량은 조금 더 많습니다. 80% 알림을 실질적인 경고로 보세요.
- 인스턴스 플랜(`bundle_id`)을 바꾸면 `TRANSFER_ALLOWANCE_GB`도 새 포함량으로 바꾸세요.
- AWS 비용 데이터는 몇 시간에서 하루 늦게 반영되므로 Budgets는 안전망입니다. `terraform.tfvars`에 `alert_emails = ["you@example.com"]`을 넣으면 만들어집니다.
- 웹 빌드에서 `VITE_SERVER_URL`을 빈 값으로 두면 같은 출처를, 설정하지 않으면 `http://localhost:8787`(개발)을 씁니다.

## 데이터에서 확인한 주의점

- **Quaternion 순서:** Zarr 배열의 quaternion은 모든 토픽이 **(x, y, z, w)**입니다. 월드 각속도가 yaw축에 몰리는지로 검증했습니다. YAML 메타데이터만 `{w, x, y, z}` 키를 씁니다. 전처리 결과(`tf.json`, manifest)는 모두 xyzw로 통일했습니다.
- **DLIO 포즈의 기준 프레임:** `dlio_map_odometry`는 **`hesai_lidar` 프레임**의 맵 좌표계 포즈입니다. 이 가정으로 옮긴 스캔은 정적 지도와 96~100% 겹쳤고, `box_base`로 가정하면 11~37%만 겹쳤습니다. LiDAR 점군은 raw와 undistorted 모두 센서 좌표계입니다.
- **timestamp 역전:** `dlio_tf`에는 timestamp가 약 60 ms 거꾸로 가는 곳이 8군데 있습니다. 전처리에서 시계열은 timestamp로 안정 정렬하고 `sortedByTimestamp: true`를 기록합니다.
- **발 접촉:** `*_FOOT_contact`는 모든 샘플이 1입니다. 실제 접촉은 `*_FOOT_state`(0/1/2)나 `wrench_force`로 보세요. 차트 프리셋 "발 접촉 상태"는 `_state`를 씁니다.
- **깊이 단위:** 16-bit 깊이 값은 **mm로 추정**합니다. 데이터셋 문서로 확인하지 않았습니다.
- **비어 있는 필드:** IMU 중 자세를 추정하지 않는 센서(STIM320 등)의 `orien`은 모두 0이라 자동으로 제외됩니다(`droppedFields`).
- **카메라 내부 파라미터:** manifest의 `cameraInfo`는 원본 해상도 기준입니다. 축소된 이미지에 쓰려면 `K`의 fx, fy, cx, cy에 `scale`을 곱하세요. HDR과 Alphasense는 어안(equidistant) 모델입니다.

## 개발

Pull Request를 열면 CI가 typecheck, 테스트, 웹 빌드, pytest를 실행합니다. 로컬에서는 아래 명령으로 같은 검사를 돌릴 수 있습니다.

### 테스트

```bash
cd dashboard && pnpm -r test && pnpm -r typecheck   # protocol round-trip, 이진 탐색, 다운샘플링
cd preprocess && uv run pytest -q   # 간이 CAD 치수, 사각형 분할, 합성 방에서 포즈 복원
uv run verify --src ../../data/raw/2024-11-02-17-10-25
```

### 새 토픽이나 새 시퀀스 추가

1. **새 시퀀스:** `data/raw/<새 시퀀스>`에 받은 뒤 `uv run prep --src ../../data/raw/<새 시퀀스>`, 그리고 `PREPARED_DIR=.../data/prepared/<새 시퀀스> pnpm --filter @grandtour/server dev`
2. **토픽 추가나 변경:** `preprocess/topics.yaml`에 토픽을 kind별로 추가합니다. 시계열은 `include`/`exclude` 정규식으로 필드를 고릅니다. 그다음 `uv run prep --src ... --topics <토픽> --force`를 실행합니다.
   - topic id는 `topics.yaml` 순서로 정해집니다. 순서를 바꾸면 서버를 재시작하세요.
3. **차트 프리셋:** `apps/web/src/ui/Sidebar.tsx`의 `CHART_PRESETS`

## 문의

버그나 질문은 [GitHub Issues](https://github.com/0-Chan/robot-logstream/issues)에 남겨 주세요.

## 만든 사람과 감사

- 만든 사람: [0-Chan](https://github.com/0-Chan)
- 데이터: ETH Zurich Robotic Systems Lab의 [GrandTour 데이터셋](https://huggingface.co/datasets/leggedrobotics/grand_tour_dataset)

## 라이선스

코드는 [MIT License](LICENSE)를 따릅니다. GrandTour 데이터셋은 저장소에 포함되지 않으며, 데이터셋 자체의 라이선스(Hugging Face 표기 기준 MIT)를 따릅니다.
