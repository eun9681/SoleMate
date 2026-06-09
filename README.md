# FootFit · 발 사이즈 자동 측정 앱

A4 용지 위에 맨발을 올리고 위에서 찍은 사진 한 장으로
**발 길이 / 발볼 너비 / 발볼 둘레 / 아치 타입 / KS 신발 사이즈**를 자동 계산하는 PWA입니다.

원본 React/TypeScript 소스코드(`foot-measure-source.zip`)의 디자인과 측정 공식을
바닐라 HTML/CSS/JS로 재구성하여, **빌드 도구나 npm 설치 없이 그대로 동작**합니다.
안드로이드에서는 Chrome으로 열어 "홈 화면에 추가"하면 네이티브 앱처럼 사용할 수 있고,
PWABuilder로 변환하면 실제 `.apk`(또는 Play Store용 `.aab`)도 만들 수 있습니다.

---

## 1. 파일 구성

```
foot-app/
├── index.html        # 메인 페이지 (홈/촬영/결과 4단계 화면)
├── style.css         # 라이트·다크 테마, 한국어 폰트 스택
├── app.js            # OpenCV.js 기반 A4 검출 + 측정 알고리즘
├── manifest.json     # PWA 매니페스트 (이름·아이콘·테마)
├── sw.js             # 오프라인 캐시용 서비스 워커
└── icons/            # 192·512 px 일반/마스커블 아이콘
```

## 2. 측정 알고리즘 (요약)

1. 사진을 OpenCV.js로 디코드한다.
2. 회색조 변환 → Otsu 임계화 + 모폴로지 / Canny 엣지 검출로 **가장 큰 4각형 윤곽**(=A4 용지)을 찾는다.
3. 검출한 4점을 정렬해 `getPerspectiveTransform`으로 **990×1400 px 직사각형**으로 원근 보정한다.
   - 990 px = 210 mm, 1400 px = 297 mm → **1 mm ≈ 4.71 px**
4. 보정된 이미지에서 발(어두운 영역)을 Otsu로 분리하고 가장 큰 연결 컴포넌트를 추출한다.
5. 가로 슬라이스마다 너비를 측정하여:
   - **발 길이** = 바운딩박스 긴 변
   - **발볼 너비** = 길이의 55–85 % 구간에서 최대 너비
   - **중족부 너비** = 길이의 35–55 % 구간 중앙값
   - **아치 지수** = 중족부 너비 / 발볼 너비
   - **발볼 둘레** ≈ 발볼 너비 × 2.05 (인체측정 경험치)
6. **KS M 6681 공식**으로 추천 신발 사이즈 계산:
   `(발볼둘레 + 발길이 + 15) ÷ 2`, 5 mm 단위로 반올림
7. **볼 등급(A–E)** = 발볼 너비 / 발 길이 비율
   - A < 0.36, B < 0.38, C < 0.40, D < 0.42, E ≥ 0.42
8. **아치 분류**
   - <0.21 요족(High Arch), 0.21–0.26 정상, >0.26 평발

## 3. 로컬에서 바로 실행

```bash
cd foot-app
# 아무 정적 서버나 OK:
python3 -m http.server 8000
#  또는
npx serve .
```
브라우저에서 `http://localhost:8000` 을 열면 끝.

> 카메라/PWA 설치 기능은 **HTTPS 또는 localhost**에서만 동작합니다. (브라우저 보안 정책)

## 4. 안드로이드에서 "앱처럼" 설치하기 (가장 빠른 방법)

1. 이 폴더를 무료 정적 호스팅에 올립니다.
   - **GitHub Pages** (`Settings → Pages → Deploy from branch`)
   - 또는 **Netlify Drop**(`netlify.com/drop`)에 폴더 드래그
   - 또는 **Vercel** (`vercel deploy`)
2. 안드로이드 폰의 **Chrome**에서 해당 URL을 엽니다.
3. 우측 상단 ⋮ 메뉴 → **"앱 설치"** 또는 **"홈 화면에 추가"** 탭.
4. 홈 화면에 FootFit 아이콘이 생기고, 탭하면 주소창 없이 풀스크린으로 실행됩니다.
5. 한 번 실행 후에는 **오프라인에서도** 동작합니다 (서비스 워커가 캐싱).

## 5. 진짜 `.apk` 파일을 만들고 싶을 때 (PWABuilder, 권장)

PWABuilder는 Microsoft가 만든 공식 도구로, 웹에서 클릭 몇 번이면 안드로이드 패키지가 떨어집니다.

1. 위의 4-1처럼 정적 호스팅에 배포해서 **HTTPS URL**을 확보합니다.
2. https://www.pwabuilder.com 접속 → URL 입력 → **Start**
3. PWA 점수 확인 후 **Package For Stores → Android** 선택
4. **"Test Package" / "Production Package"** 다운로드
   - 결과물: `app-release-signed.apk` (사이드로딩용) + `app-release-bundle.aab` (플레이스토어용)
5. APK 파일을 안드로이드 폰에 옮겨 설치 (출처를 알 수 없는 앱 허용 필요).

## 6. (선택) Capacitor로 직접 안드로이드 프로젝트 만들기

Android Studio가 설치된 환경에서:

```bash
npm init -y
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init FootFit kr.footfit.app --web-dir=.
npx cap add android
npx cap copy android
npx cap open android   # Android Studio가 열립니다 → Build → Build APK
```

`capacitor.config.json` 예시:
```json
{
  "appId": "kr.footfit.app",
  "appName": "FootFit",
  "webDir": ".",
  "server": { "androidScheme": "https" }
}
```

## 7. 정확도 팁

- 밝은 조명, 그림자 적은 곳에서 촬영하세요.
- A4 용지와 바닥의 **색 대비가 클수록** 검출이 잘 됩니다 (어두운 원목/카펫 ◎, 흰 타일 △).
- 휴대폰을 발과 **수직(위에서 아래로)** 으로 들고 찍어주세요.
- A4 네 모서리가 모두 사진에 보이도록 합니다.
- 양말이 아닌 **맨발**을 권장합니다.

## 8. 개인정보

모든 이미지 처리는 **기기 내부**(브라우저)에서만 이루어집니다.
서버로 사진이 전송되지 않으므로 개인 정보 유출 걱정이 없습니다.

## 9. 라이선스 / 출처

- 측정 공식: 한국산업표준 **KS M 6681**(신발 치수)
- 이미지 처리: [OpenCV.js 4.10](https://docs.opencv.org/4.10.0/opencv.js) (CDN, BSD 3-Clause)
- UI 디자인 모티브: 사용자가 업로드한 React/TypeScript 소스 (`foot-measure-source.zip`)
