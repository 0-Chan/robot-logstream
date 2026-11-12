# 로컬 설치와 실행

원본 데이터를 받아 전처리하고 서버와 웹을 로컬에서 띄우는 순서입니다. 프로젝트 소개와 나머지 내용은 [README](../README.md)에 있습니다.

## 준비물

| 도구 | 확인한 버전 | 용도 |
|---|---|---|
| [uv](https://docs.astral.sh/uv/) | 0.11 | 전처리 (Python 3.12를 자동으로 설치) |
| Node.js | 22 이상 (CI와 Docker는 24) | 서버, 웹 |
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
- **재시작 가능:** 토픽마다 마지막에 `meta.json`을 쓰고 이 파일이 있는 토픽은 건너뜁니다.
- **소요 시간:** 이 머신(10코어, 16 GB)에서 가장 오래 걸린 토픽은 84초(깊이 카메라)였고 나머지는 대부분 수 초~30초였습니다.
- 처리할 토픽과 방식은 `preprocess/topics.yaml`에서 정합니다.

### 출력 형식 (`data/prepared/<seq>/`)

모든 파일은 리틀 엔디언이고 토픽마다 `topics/<topic>/timestamps.f64`(Unix 초, Float64)가 있습니다.

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

배압 확인: 3초 동안 수신을 멈추자 서버가 프레임 330개를 건너뛰었습니다. 재개 직후 최신 프레임은 재생 시각보다 11 ms만 뒤처져 지연이 쌓이지 않았습니다.

## 4단계: 웹 실행

```bash
pnpm --filter @grandtour/web dev           # http://localhost:5173
```

서버 주소를 바꾸려면 `VITE_SERVER_URL=http://host:8787`을 지정합니다.

UI는 **shadcn/ui**(Radix 기반, Nova 프리셋, 다크 테마 고정)와 **Tailwind CSS v4**로 만들었습니다. 컴포넌트는 `apps/web/src/components/ui/`에 있고 추가할 때는 `apps/web`에서 `pnpm dlx shadcn@4.22.1 add <이름>`을 실행합니다. 차트 색은 테마 토큰 `--chart-1~8`(`src/styles.css`)에서 가져옵니다.

화면 구성과 사용법은 README의 [사용법](../README.md#사용법)을 보세요.
