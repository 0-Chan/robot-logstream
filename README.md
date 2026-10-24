# GrandTour 로봇 데이터 스트리밍 대시보드

ETH Zurich RSL의 [GrandTour 데이터셋](https://huggingface.co/datasets/leggedrobotics/grand_tour_dataset) 시퀀스를 **WebSocket으로 재생**하는 대시보드입니다. 4족 보행 로봇 ANYmal D가 녹화한 LiDAR, 카메라, IMU, 관절, GNSS 데이터를 다룹니다.

```
data/raw/<seq>/          preprocess (Python)            data/prepared/<seq>/        server (TS, Hono)                web (React)
Zarr-in-tar · 이미지 tar ─▶ 디코딩·재청크·양자화·축소 ─▶ 프레임 파일 + 인덱스 ─▶ 재생 시계 · 구독 · 배압 ─WS─▶ 3D · 카메라 · 차트
yaml · ply                                          manifest.json · static/    정적 자산 ────────────HTTP─▶ 맵 · TF
```

원칙은 하나입니다. **무거운 처리는 모두 전처리에서 끝내고**, 서버는 "인덱스 조회 → 바이트 읽기 → 소켓 전송"만 합니다.

---

## 폴더 구조

```
grand_tour/
├── README.md
├── data/
│   ├── raw/2024-11-02-17-10-25/        원본 (HF에서 받은 그대로, 읽기 전용, 32 GB)
│   └── prepared/2024-11-02-17-10-25/   전처리 결과 (서버가 읽음, 약 12 GB)
└── dashboard/                          코드 (pnpm workspace)
    ├── preprocess/                     Python: 원본 → prepared 변환과 검증
    ├── packages/protocol/              TS: manifest 타입, WebSocket 메시지 encode/decode (서버·웹 공용)
    ├── apps/server/                    TS: Hono + @hono/node-server WebSocket 재생 서버
    └── apps/web/                       TS: Vite + React 대시보드
```

## 준비물

| 도구 | 확인한 버전 | 용도 |
|---|---|---|
| [uv](https://docs.astral.sh/uv/) | 0.11 | 전처리 (Python 3.12를 자동으로 설치) |
| Node.js | 22 이상 (v26에서 확인) | 서버, 웹 |
| pnpm | 11 | TS 워크스페이스 |
| 디스크 여유 공간 | 원본 32 GB + prepared 약 12 GB | |

---

## 1단계: 원본 데이터 받기

시퀀스 폴더를 `data/raw/` 아래에 둡니다.

```bash
# huggingface_hub CLI 예시 (이 저장소에서 직접 실행해 확인한 명령은 아님)
hf download leggedrobotics/grand_tour_dataset --repo-type dataset \
  --include "2024-11-02-17-10-25/*" --local-dir data/raw
```

원본 형식:

| 경로 | 형식 |
|---|---|
| `data/*.tar` | 토픽별 **Zarr v2** 그룹 (blosc/lz4 압축, 축 0으로만 청크 분할). tar 안에 `<topic>/<field>/.zarray` + 청크 |
| `images/*.tar` | 카메라 이미지 `<topic>/000000.jpeg` (컬러) 또는 `.png` (16-bit 깊이). 인덱스로 `data/<topic>.tar`의 `timestamp`와 매칭 |
| `metadata/*.yaml` | frame_id, `box_base` 기준 장착 위치, camera_info, `tf.yaml` (정적 TF 트리) |
| `point_cloud_maps/*.ply` | DLIO로 만든 전체 점군 지도 (x, y, z, intensity) |
| `splats/` | 구간별 Gaussian Splatting (이 대시보드에서는 사용하지 않음) |

## 2단계: 전처리 (Python)

```bash
cd dashboard/preprocess
uv run prep --src ../../data/raw/2024-11-02-17-10-25     # 출력 기본값: data/prepared/<seq>
uv run verify --src ../../data/raw/2024-11-02-17-10-25   # 원본과 무작위 샘플 비교
```

- 결과 예시: `47/47 topics passed`
- 옵션
  - `--topics a,b`: 일부 토픽만 처리
  - `--force`: 이미 끝난 토픽도 다시 생성
  - `--workers N`: 병렬 처리 수 (기본 4)
- **재시작 가능:** 토픽마다 마지막에 `meta.json`을 쓰고, 이 파일이 있는 토픽은 건너뜁니다.
- **소요 시간:** 이 머신(10코어, 16 GB)에서 가장 오래 걸린 토픽은 84초(깊이 카메라)였고, 나머지는 대부분 수 초~30초였습니다.
- 처리할 토픽과 방식은 `preprocess/topics.yaml`에서 정합니다.

### 출력 형식 (`data/prepared/<seq>/`)

모든 파일은 리틀 엔디언이고, 토픽마다 `topics/<topic>/timestamps.f64`(Unix 초, Float64)가 있습니다.

| kind | 토픽 수 | 용량 | 파일 | 프레임 내용 |
|---|---|---|---|---|
| `pointcloud` | 7 | 4.4 GB | `frames.bin` + `offsets.u64`(N+1) | `[u32 n][i16 xyz × n][u8 intensity × n]`. 위치 단위는 `positionScale` m(1 cm). 패딩 제거 |
| `image` | 10 | 4.3 GB | 위와 같음 | JPEG, 긴 변 960 px, q80 |
| `depth` | 7 | 3.3 GB | 위와 같음 | 16-bit PNG, 긴 변 640 px (nearest, 값 보존) |
| `series` | 23 | 0.14 GB | `values.f32` (N × C, row-major) | 실제 값 = 저장 값 + 열의 `offset`. 큰 값(ECEF, 위경도 등)은 float32 정밀도 때문에 offset을 빼서 저장 |

- `manifest.json`: 시퀀스 시간 범위와 토픽 목록(id, kind, count, Hz, frameId, 장착 transform, 열 이름과 offset, camera_info, 축소 비율)
- `static/tf.json`: 정적 TF 트리
- `static/map.bin`: 5 cm voxel로 줄인 지도, `[u32 n][f32 xyz × n][u8 intensity × n]`, 125만 점

## 3단계: 서버 실행 (TypeScript)

```bash
cd dashboard
pnpm install
pnpm --filter @grandtour/server dev        # http://localhost:8787, ws://localhost:8787/ws
```

| 환경변수 | 기본값 |
|---|---|
| `PREPARED_DIR` | `<repo>/data/prepared/2024-11-02-17-10-25` |
| `PORT` | `8787` |

HTTP 엔드포인트: `/health`, `/manifest.json`, `/static/tf.json`, `/static/map.bin`

브라우저 없이 스트리밍을 점검하려면:

```bash
pnpm --filter @grandtour/server probe                              # 1배속: 토픽별 수신 Hz, KB/s, seek 지연
pnpm --filter @grandtour/server probe -- --speed 4                 # 4배속
pnpm --filter @grandtour/server probe -- --seconds 10 --stall 3    # 3초 동안 수신을 멈춰 배압 확인
```

측정 결과 (로컬, 기본 구독 = hesai + hdr_front + 깊이 1대 + 시계열 2개):

| 항목 | 1배속 | 4배속 |
|---|---|---|
| hesai / hdr_front / 깊이 프레임 | 10 / 10 / 15 Hz | 40 / 40 / 48 Hz |
| 시계열 | 100 샘플/s (기본 maxHz) | 400 샘플/s |
| 대역폭 | 4.8 MB/s | 18 MB/s |
| seek 후 첫 프레임 | 12~20 ms | 18 ms |

배압 확인: 3초 동안 수신을 멈추자 서버가 프레임 330개를 건너뛰었습니다. 재개 직후 최신 프레임은 재생 시각보다 11 ms만 뒤처져, 지연이 쌓이지 않았습니다.

## 4단계: 웹 실행

```bash
pnpm --filter @grandtour/web dev           # http://localhost:5173
```

서버 주소를 바꾸려면 `VITE_SERVER_URL=http://host:8787`을 지정합니다.

UI는 **shadcn/ui**(Radix 기반, Nova 프리셋, 다크 테마 고정)와 **Tailwind CSS v4**로 만들었습니다. 컴포넌트는 `apps/web/src/components/ui/`에 있고, 추가할 때는 `apps/web`에서 `pnpm dlx shadcn@4.22.1 add <이름>`을 실행합니다. 차트 색은 테마 토큰 `--chart-1~8`(`src/styles.css`)에서 가져옵니다.

| 영역 | 내용 |
|---|---|
| 하단 재생 바 | 재생/일시정지, 속도(×0.25~×4), 타임라인 Slider seek, 연결 상태와 수신 MB/s·fps |
| 3D 뷰 | 선택한 LiDAR 스캔(intensity 색), DLIO 맵 좌표계 또는 센서 박스 좌표계, 정적 지도, 로봇 박스, 궤적 |
| 카메라 2칸 | 컬러 또는 깊이(turbo 색, 0.3~8 m). 오른쪽 위 `Δ`는 재생 시각과 표시 중인 프레임의 시간 차 |
| 차트 2개 | 아무 시계열 토픽과 열(검색 가능한 멀티 셀렉트, 최대 8개). 관절·발 접촉·IMU·배터리 프리셋, 최근 10초 표시 |

서버 연결이 끊기면 알림(토스트)이 뜨고 2초마다 다시 연결합니다. 화면에 보이는 토픽만 구독합니다. 패널 선택을 바꾸면 `subscribe` 메시지가 다시 전송됩니다.

---

## WebSocket 프로토콜 요약

자세한 내용은 `dashboard/packages/protocol/src/messages.ts`에 있습니다.

**제어 메시지 (JSON 텍스트)**
- 서버 → 클라이언트: `hello{manifest}`, 100 ms마다 `clock{t, playing, speed, epoch}`, `error`
- 클라이언트 → 서버: `subscribe{topics:[{name, maxHz?}]}`(교체 방식), `play{speed?}`, `pause`, `speed{speed}`, `seek{t}`

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
- seek: `epoch`를 올리고 시계열 5초치를 백필합니다. 클라이언트는 이전 epoch의 메시지를 버립니다.
- 웹소켓은 `@hono/node-server` 내장 `upgradeWebSocket`과 `ws`의 `WebSocketServer`를 씁니다. 배압 판단에 필요한 `bufferedAmount`는 `ws.raw`에서 읽습니다.

## 새 토픽이나 새 시퀀스 추가

1. **새 시퀀스:** `data/raw/<새 시퀀스>`에 받은 뒤 `uv run prep --src ../../data/raw/<새 시퀀스>`, 그리고 `PREPARED_DIR=.../data/prepared/<새 시퀀스> pnpm --filter @grandtour/server dev`
2. **토픽 추가나 변경:** `preprocess/topics.yaml`에 토픽을 kind별로 추가합니다. 시계열은 `include`/`exclude` 정규식으로 필드를 고릅니다. 그다음 `uv run prep --src ... --topics <토픽> --force`를 실행합니다.
   - topic id는 `topics.yaml` 순서로 정해집니다. 순서를 바꾸면 서버를 재시작하세요.
3. **차트 프리셋:** `apps/web/src/ui/Sidebar.tsx`의 `CHART_PRESETS`

## 데이터에서 확인한 주의점

- **Quaternion 순서:** Zarr 배열의 quaternion은 모든 토픽이 **(x, y, z, w)**입니다. 월드 각속도가 yaw축에 몰리는지로 검증했습니다. YAML 메타데이터만 `{w, x, y, z}` 키를 씁니다. 전처리 결과(`tf.json`, manifest)는 모두 xyzw로 통일했습니다.
- **DLIO 포즈의 기준 프레임:** `dlio_map_odometry`는 **`hesai_lidar` 프레임**의 맵 좌표계 포즈입니다. 이 가정으로 옮긴 스캔은 정적 지도와 96~100% 겹쳤고, `box_base`로 가정하면 11~37%만 겹쳤습니다. LiDAR 점군은 raw와 undistorted 모두 센서 좌표계입니다.
- **timestamp 역전:** `dlio_tf`에는 timestamp가 약 60 ms 거꾸로 가는 곳이 8군데 있습니다. 전처리에서 시계열은 timestamp로 안정 정렬하고 `sortedByTimestamp: true`를 기록합니다.
- **발 접촉:** `*_FOOT_contact`는 모든 샘플이 1입니다. 실제 접촉은 `*_FOOT_state`(0/1/2)나 `wrench_force`로 보세요. 차트 프리셋 "발 접촉 상태"는 `_state`를 씁니다.
- **깊이 단위:** 16-bit 깊이 값은 **mm로 추정**합니다. 데이터셋 문서로 확인하지 않았습니다.
- **비어 있는 필드:** IMU 중 자세를 추정하지 않는 센서(STIM320 등)의 `orien`은 모두 0이라 자동으로 제외됩니다(`droppedFields`).
- **카메라 내부 파라미터:** manifest의 `cameraInfo`는 원본 해상도 기준입니다. 축소된 이미지에 쓰려면 `K`의 fx, fy, cx, cy에 `scale`을 곱하세요. HDR과 Alphasense는 어안(equidistant) 모델입니다.

## 테스트

```bash
cd dashboard && pnpm -r test && pnpm -r typecheck   # protocol round-trip, 이진 탐색, 다운샘플링
cd preprocess && uv run verify --src ../../data/raw/2024-11-02-17-10-25
```
