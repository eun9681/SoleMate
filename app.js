/* === Solemate · 신발 사이즈 측정 앱 === */

const A4_W_MM = 210, A4_H_MM = 297;
const RECT_W = 990, RECT_H = 1400;
const PX_PER_MM = RECT_H / A4_H_MM;
const BALL_GIRTH_FACTOR = 2.5;
const A4_ASPECT = A4_W_MM / A4_H_MM;
const ADMIN_ID = "admin", ADMIN_PW = "admin1234";
const LENGTH_BIAS_MM = -20;
const SURVEY_SIZE_TOLERANCE_MM = 5;
const FOOT_TYPE_LABEL = { flat: "평발", normal: "정상 아치", high: "요족" };
const WIDTH_TYPE_INFO = {
  narrow: {
    label: "NARROW",
    detail: "좁은 발볼",
    desc: "발볼이 좁고 앞쪽 공간이 남기 쉬운 형태입니다.",
  },
  medium: {
    label: "MEDIUM",
    detail: "Medium",
    desc: "길이 대비 너비가 평균적인 형태입니다.",
  },
  wide: {
    label: "WIDE",
    detail: "Wide",
    desc: "전체적으로 발볼이 넓고 안정적인 여유가 필요한 형태입니다.",
  },
  extraWide: {
    label: "EXTRA WIDE",
    detail: "Extra Wide",
    desc: "발볼이 아주 넓어 초광폭 신발이 편한 형태입니다.",
  },
};
const BRAND_OFFSETS = { nike: 5, adidas: 5, newbalance: 10, converse: 5 };

const STORE = {
  usersCache: [],
  currentUserCache: null,
  loadUsers() { return STORE.usersCache; },
  saveUsers(u) { STORE.usersCache = u; },
  loadSession() { try { return JSON.parse(localStorage.getItem("solemate.session") || "null"); } catch { return null; } },
  saveSession(s) { s ? localStorage.setItem("solemate.session", JSON.stringify(s)) : localStorage.removeItem("solemate.session"); },
  currentUser() { return STORE.currentUserCache; },
  setCurrentUser(u) { STORE.currentUserCache = u; },
  async updateCurrentUser(patch) {
    const u = STORE.currentUser();
    if (!u || !u.uid) return;
    const next = { ...u, ...patch };
    STORE.currentUserCache = next;
    try {
      const fb = await getFirebase();
      await fb.updateDoc(fb.doc(fb.db, "users", u.uid), patch);
    } catch (error) {
      console.error(error);
      toast("Firebase 저장에 실패했어요. 네트워크를 확인해 주세요.");
    }
  },
};

const state = {
  cvReady: false,
  frontFile: null,
  frontDataUrl: null,
  sideFile: null,
  sideDataUrl: null,
  lastResult: null,
  pendingCode: null,
  currentProductIndex: null,
  recommendCategory: "all",
  recommendBrand: "",
  recommendSearch: "",
  camera: { stream: null, side: null },
};
const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showScreen(name) {
  const current = document.querySelector(".screen.active")?.dataset.screen;
  if (name === "capture-front" && current !== "capture-side") resetCaptureSession();
  $$(".screen").forEach(s => s.classList.remove("active"));
  const t = document.querySelector(`.screen[data-screen="${name}"]`);
  if (t) t.classList.add("active");
  window.scrollTo({ top: 0, behavior: "instant" });
  handleCameraScreen(name);
}
function toast(msg, ms = 2800) {
  const el = $("toast"); el.textContent = msg; el.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

/**
 * 로그인 후/부팅 시 라우팅:
 *  - 사전설문이 없으면 → 설문 인트로
 *  - 측정 기록이 1개라도 있으면 → 가장 최근 결과 화면 (다시 측정 / 저장 / 신발 보러가기 버튼이 보임)
 *  - 그 외에는 → 분석 인트로
 */
function routeAfterLogin(u) {
  if (!u.survey) { showScreen("survey-intro"); return; }
  const results = u.results || [];
  if (results.length > 0) {
    const last = results[results.length - 1];
    state.lastResult = last;
    renderResult(last, null);
    showScreen("result");
  } else {
    showScreen("analysis-intro");
  }
}

// ===== Auth =====
async function getFirebase() {
  for (let i = 0; i < 60; i++) {
    if (window.SolemateFirebaseReady) return window.SolemateFirebaseReady;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Firebase가 아직 초기화되지 않았어요.");
}

function normalizeFirebaseUser(firebaseUser, data = {}) {
  return {
    uid: firebaseUser.uid,
    id: data.id || firebaseUser.displayName || firebaseUser.email?.split("@")[0] || firebaseUser.uid,
    email: data.email || firebaseUser.email || "",
    createdAt: data.createdAt || firebaseUser.metadata?.creationTime || new Date().toISOString(),
    survey: data.survey || null,
    results: data.results || [],
    likedShoes: data.likedShoes || [],
  };
}

async function loadFirebaseUser(firebaseUser) {
  const fb = await getFirebase();
  const snap = await fb.getDoc(fb.doc(fb.db, "users", firebaseUser.uid));
  const user = normalizeFirebaseUser(firebaseUser, snap.exists() ? snap.data() : {});
  if (!snap.exists()) {
    await fb.setDoc(fb.doc(fb.db, "users", firebaseUser.uid), user, { merge: true });
  }
  STORE.setCurrentUser(user);
  return user;
}

function firebaseAuthMessage(error) {
  const code = error?.code || "";
  if (code.includes("email-already-in-use")) return "이미 가입된 이메일이에요";
  if (code.includes("invalid-email")) return "이메일 형식을 확인해 주세요";
  if (code.includes("weak-password")) return "비밀번호는 6자 이상이어야 해요";
  if (code.includes("user-not-found") || code.includes("wrong-password") || code.includes("invalid-credential")) {
    return "아이디/이메일 또는 비밀번호가 맞지 않아요";
  }
  if (code.includes("network-request-failed")) return "네트워크 연결을 확인해 주세요";
  return "Firebase 인증 중 문제가 생겼어요";
}

async function resolveLoginEmail(idOrEmail) {
  if (idOrEmail.includes("@")) return idOrEmail;
  const fb = await getFirebase();
  const snap = await fb.getDoc(fb.doc(fb.db, "usernames", idOrEmail));
  return snap.exists() ? snap.data().email : "";
}

async function tryLogin(id, pw) {
  if (!id || !pw) { toast("아이디와 비밀번호를 입력해 주세요"); return false; }
  if (id === ADMIN_ID && pw === ADMIN_PW) {
    STORE.saveSession({ userId: "admin", isAdmin: true });
    showScreen("admin"); renderAdmin(); return true;
  }
  try {
    const fb = await getFirebase();
    const email = await resolveLoginEmail(id);
    if (!email) { toast("아이디 또는 이메일을 찾을 수 없어요"); return false; }
    const credential = await fb.signInWithEmailAndPassword(fb.auth, email, pw);
    const u = await loadFirebaseUser(credential.user);
    STORE.saveSession(null);
    routeAfterLogin(u);
    return true;
  } catch (error) {
    console.error(error);
    toast(firebaseAuthMessage(error));
    return false;
  }
}
async function trySignup() {
  const id = $("su-id").value.trim();
  const pw = $("su-pw").value, pw2 = $("su-pw2").value;
  const email = $("su-email").value.trim();
  const code = $("su-code").value.trim();
  const consent = $("su-consent").checked;
  if (!id) return toast("아이디를 입력해 주세요");
  if (id.length < 3) return toast("아이디는 3자 이상이어야 해요");
  if (!pw) return toast("비밀번호를 입력해 주세요");
  if (pw.length < 6) return toast("Firebase 비밀번호는 6자 이상이어야 해요");
  if (pw !== pw2) return toast("비밀번호 확인이 일치하지 않아요");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast("이메일 형식을 확인해 주세요");
  if (!consent) return toast("개인정보 수집 동의가 필요해요");
  if (state.pendingCode && code && code !== state.pendingCode) return toast("인증 코드가 맞지 않아요");
  try {
    const fb = await getFirebase();
    const usernameRef = fb.doc(fb.db, "usernames", id);
    const usernameSnap = await fb.getDoc(usernameRef);
    if (usernameSnap.exists() || id === ADMIN_ID) return toast("이미 존재하는 아이디예요");
    const credential = await fb.createUserWithEmailAndPassword(fb.auth, email, pw);
    await fb.updateProfile(credential.user, { displayName: id });
    const user = {
      uid: credential.user.uid,
      id,
      email,
      createdAt: new Date().toISOString(),
      survey: null,
      results: [],
      likedShoes: [],
    };
    await fb.setDoc(fb.doc(fb.db, "users", credential.user.uid), {
      ...user,
      createdAtServer: fb.serverTimestamp(),
    });
    await fb.setDoc(usernameRef, {
      uid: credential.user.uid,
      email,
      createdAt: fb.serverTimestamp(),
    });
    STORE.setCurrentUser(user);
    STORE.saveSession(null);
    toast("가입 완료!");
    setTimeout(() => showScreen("survey-intro"), 600);
  } catch (error) {
    console.error(error);
    toast(firebaseAuthMessage(error));
  }
}
async function checkIdDuplicate() {
  const id = $("su-id").value.trim();
  const msg = $("su-id-msg");
  if (!id) { msg.textContent = "아이디를 입력해 주세요"; msg.className = "field-msg err"; return; }
  try {
    const fb = await getFirebase();
    const snap = await fb.getDoc(fb.doc(fb.db, "usernames", id));
    if (id === ADMIN_ID || snap.exists()) {
      msg.textContent = "이미 사용 중인 아이디예요"; msg.className = "field-msg err";
    } else {
      msg.textContent = "사용 가능한 아이디예요"; msg.className = "field-msg ok";
    }
  } catch (error) {
    console.error(error);
    msg.textContent = "중복 확인에 실패했어요"; msg.className = "field-msg err";
  }
}
function sendVerifyCode() {
  const email = $("su-email").value.trim();
  if (!email) return toast("이메일을 입력해 주세요");
  const code = String(Math.floor(100000 + Math.random() * 900000));
  state.pendingCode = code;
  $("su-code-msg").textContent = "인증 코드: " + code + " (데모용)";
  $("su-code-msg").className = "field-msg ok";
  toast("인증 코드를 발송했어요 (데모)");
}
async function logout() {
  const session = STORE.loadSession();
  STORE.saveSession(null);
  STORE.setCurrentUser(null);
  if (!session?.isAdmin) {
    try {
      const fb = await getFirebase();
      await fb.signOut(fb.auth);
    } catch (error) {
      console.error(error);
    }
  }
  toast("로그아웃 되었어요");
  showScreen("start");
}

// ===== Survey =====
function getCheckedIssues() { return $$(".sv-issue:checked").map(el => el.value); }
function saveSurveyAndNext() {
  const survey = {
    birth: $("sv-birth").value.trim(),
    gender: $("sv-gender").value,
    heightCm: Number($("sv-height").value) || null,
    weightKg: Number($("sv-weight").value) || null,
    usualShoeSizeMm: Number($("sv-shoe").value) || null,
    cushion: Number($("sv-cushion").value),
    ballroom: Number($("sv-ballroom").value),
    weightPref: Number($("sv-weightpref").value),
    issues: getCheckedIssues(),
    sensitive: $("sv-sensitive").value,
    sensitiveNote: $("sv-sensitive-note").value.trim(),
    completedAt: new Date().toISOString(),
  };
  STORE.updateCurrentUser({ survey });
  toast("설문 저장 완료!");
  setTimeout(() => showScreen("analysis-intro"), 600);
}
function prefillSurvey() {
  const u = STORE.currentUser(); if (!u || !u.survey) return;
  const s = u.survey;
  if ($("sv-birth")) $("sv-birth").value = s.birth || "";
  if ($("sv-gender")) $("sv-gender").value = s.gender || "";
  if ($("sv-height")) $("sv-height").value = s.heightCm || "";
  if ($("sv-weight")) $("sv-weight").value = s.weightKg || "";
  if ($("sv-shoe")) $("sv-shoe").value = s.usualShoeSizeMm || "";
  if ($("sv-cushion")) $("sv-cushion").value = s.cushion ?? 50;
  if ($("sv-ballroom")) $("sv-ballroom").value = s.ballroom ?? 50;
  if ($("sv-weightpref")) $("sv-weightpref").value = s.weightPref ?? 50;
  if ($("sv-sensitive")) $("sv-sensitive").value = s.sensitive || "";
  if ($("sv-sensitive-note")) $("sv-sensitive-note").value = s.sensitiveNote || "";
  (s.issues || []).forEach(v => {
    const el = document.querySelector(`.sv-issue[value="${v}"]`);
    if (el) el.checked = true;
  });
}

// ===== OpenCV loader =====
const OPENCV_URLS = [
  "https://docs.opencv.org/4.10.0/opencv.js",
  "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js",
  "https://docs.opencv.org/4.5.0/opencv.js",
];
function tryLoadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.async = true; s.src = url;
    s.onload = () => resolve();
    s.onerror = () => { s.remove(); reject(new Error(url)); };
    document.head.appendChild(s);
  });
}
function waitForCVReady() {
  return new Promise((resolve) => {
    if (window.cv && window.cv.Mat) { state.cvReady = true; return resolve(); }
    if (window.cv && typeof window.cv.then === "function") {
      window.cv.then(m => { window.cv = m || window.cv; state.cvReady = true; resolve(); });
      return;
    }
    window.cv = window.cv || {};
    window.cv.onRuntimeInitialized = () => { state.cvReady = true; resolve(); };
  });
}
async function loadOpenCV() {
  if (window.cv && window.cv.Mat) { state.cvReady = true; return; }
  for (const url of OPENCV_URLS) {
    try { await tryLoadScript(url); await waitForCVReady(); return; } catch (e) {}
  }
  throw new Error("OpenCV.js를 불러올 수 없어요. 인터넷 연결을 확인해 주세요.");
}

// ===== Image processing =====
async function decodeImage(file) {
  if (typeof createImageBitmap === "function") { try { return await createImageBitmap(file); } catch (_) {} }
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img); img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}
function orderQuad(pts) {
  const sum = pts.map(p => p.x + p.y), diff = pts.map(p => p.x - p.y);
  return [
    pts[sum.indexOf(Math.min.apply(null, sum))],
    pts[diff.indexOf(Math.max.apply(null, diff))],
    pts[sum.indexOf(Math.max.apply(null, sum))],
    pts[diff.indexOf(Math.min.apply(null, diff))],
  ];
}
function rotatedRectCorners(rect) {
  const cx = rect.center.x, cy = rect.center.y;
  const w = rect.size.width / 2, h = rect.size.height / 2;
  const a = rect.angle * Math.PI / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  return [
    { x: cx + (-w) * ca - (-h) * sa, y: cy + (-w) * sa + (-h) * ca },
    { x: cx + ( w) * ca - (-h) * sa, y: cy + ( w) * sa + (-h) * ca },
    { x: cx + ( w) * ca - ( h) * sa, y: cy + ( w) * sa + ( h) * ca },
    { x: cx + (-w) * ca - ( h) * sa, y: cy + (-w) * sa + ( h) * ca },
  ];
}
function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; a += q[i].x * q[j].y - q[j].x * q[i].y; }
  return Math.abs(a) / 2;
}
function quadFromContour(cv, c) {
  const hull = new cv.Mat();
  cv.convexHull(c, hull, false, true);
  const peri = cv.arcLength(hull, true);
  for (const eps of [0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.07, 0.10, 0.15]) {
    const a = new cv.Mat();
    cv.approxPolyDP(hull, a, eps * peri, true);
    if (a.rows === 4) {
      const pts = [];
      for (let k = 0; k < 4; k++) pts.push({ x: a.data32S[k * 2], y: a.data32S[k * 2 + 1] });
      a.delete(); hull.delete(); return pts;
    }
    a.delete();
  }
  const rect = cv.minAreaRect(hull);
  const corners = rotatedRectCorners(rect);
  hull.delete();
  return corners;
}
function scoreQuad(cv, gray, quad, imgArea) {
  const area = quadArea(quad);
  if (area < imgArea * 0.05 || area > imgArea * 0.92) return 0;
  const w = (Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y) + Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y)) / 2;
  const h = (Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y) + Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y)) / 2;
  const ratio = Math.min(w, h) / Math.max(w, h);
  const re = Math.abs(ratio - A4_ASPECT);
  if (re > 0.30) return 0;
  let sum = 0, bright = 0, n = 0;
  for (let iy = 0; iy < 11; iy++) for (let ix = 0; ix < 11; ix++) {
    const u = (ix + 1) / 12, v = (iy + 1) / 12;
    const tp = { x: quad[0].x + (quad[1].x - quad[0].x) * u, y: quad[0].y + (quad[1].y - quad[0].y) * u };
    const bp = { x: quad[3].x + (quad[2].x - quad[3].x) * u, y: quad[3].y + (quad[2].y - quad[3].y) * u };
    const xi = Math.round(tp.x + (bp.x - tp.x) * v);
    const yi = Math.round(tp.y + (bp.y - tp.y) * v);
    if (xi >= 0 && yi >= 0 && xi < gray.cols && yi < gray.rows) {
      const g = gray.ucharPtr(yi, xi)[0];
      sum += g; n++; if (g > 170) bright++;
    }
  }
  if (n === 0 || sum / n < 110 || bright / n < 0.15) return 0;
  return 0.3 * Math.min(1, area / (imgArea * 0.5)) + 0.5 * (bright / n) + 0.2 * (1 - re / 0.30);
}
function detectPaperQuad(cv, src) {
  const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const blurred = new cv.Mat(); cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
  let best = null, bestScore = 0, fb = null, fbArea = 0;
  const imgArea = src.rows * src.cols;
  for (let st = 0; st < 4; st++) {
    const proc = new cv.Mat();
    if (st === 0) {
      cv.threshold(blurred, proc, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
      cv.morphologyEx(proc, proc, cv.MORPH_CLOSE, k); k.delete();
    } else if (st === 1) {
      cv.threshold(blurred, proc, 180, 255, cv.THRESH_BINARY);
      const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
      cv.morphologyEx(proc, proc, cv.MORPH_CLOSE, k); k.delete();
    } else if (st === 2) {
      cv.threshold(blurred, proc, 150, 255, cv.THRESH_BINARY);
      const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
      cv.morphologyEx(proc, proc, cv.MORPH_CLOSE, k); k.delete();
    } else {
      cv.Canny(blurred, proc, 50, 160);
      const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
      cv.dilate(proc, proc, k); k.delete();
    }
    const contours = new cv.MatVector(); const hier = new cv.Mat();
    cv.findContours(proc, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const a = cv.contourArea(c);
      if (a < imgArea * 0.05 || a > imgArea * 0.97) { c.delete(); continue; }
      const pts = quadFromContour(cv, c);
      if (pts) {
        const ord = orderQuad(pts);
        const sc = scoreQuad(cv, blurred, ord, imgArea);
        if (sc > bestScore) { bestScore = sc; best = ord; }
        if (a > fbArea && a < imgArea * 0.85) { fbArea = a; fb = ord; }
      }
      c.delete();
    }
    contours.delete(); hier.delete(); proc.delete();
  }
  gray.delete(); blurred.delete();
  return best || fb;
}
function warpToA4(cv, src, quad) {
  const w = (Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y) + Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y)) / 2;
  const h = (Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y) + Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y)) / 2;
  const ord = h >= w ? quad : [quad[3], quad[0], quad[1], quad[2]];
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [ord[0].x, ord[0].y, ord[1].x, ord[1].y, ord[2].x, ord[2].y, ord[3].x, ord[3].y]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, RECT_W, 0, RECT_W, RECT_H, 0, RECT_H]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(RECT_W, RECT_H), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
  srcTri.delete(); dstTri.delete(); M.delete();
  return dst;
}
function measureFootInRect(cv, rectMat) {
  const gray = new cv.Mat(); cv.cvtColor(rectMat, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
  const inv = new cv.Mat(); cv.bitwise_not(gray, inv);
  const bin = new cv.Mat(); cv.threshold(inv, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  const mx = Math.round(bin.cols * 0.05), my = Math.round(bin.rows * 0.05);
  for (let y = 0; y < bin.rows; y++) for (let x = 0; x < bin.cols; x++) {
    if (x < mx || y < my || x > bin.cols - mx || y > bin.rows - my) bin.ucharPtr(y, x)[0] = 0;
  }
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
  cv.morphologyEx(bin, bin, cv.MORPH_OPEN, k); cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k); k.delete();
  const labels = new cv.Mat(), stats = new cv.Mat(), cent = new cv.Mat();
  const nL = cv.connectedComponentsWithStats(bin, labels, stats, cent, 8, cv.CV_32S);
  let bestL = -1, bestS = 0;
  for (let i = 1; i < nL; i++) {
    const a = stats.intPtr(i, cv.CC_STAT_AREA)[0]; if (a < 3000) continue;
    const cx = cent.doublePtr(i, 0)[0], cy = cent.doublePtr(i, 1)[0];
    if (cx < bin.cols * 0.08 || cx > bin.cols * 0.92) continue;
    if (cy < bin.rows * 0.08 || cy > bin.rows * 0.92) continue;
    const d = Math.hypot(cx - bin.cols / 2, cy - bin.rows / 2) / Math.hypot(bin.cols / 2, bin.rows / 2);
    const s = a * (1 - d * 0.5);
    if (s > bestS) { bestS = s; bestL = i; }
  }
  if (bestL < 0) {
    for (let i = 1; i < nL; i++) { const a = stats.intPtr(i, cv.CC_STAT_AREA)[0]; if (a > bestS) { bestS = a; bestL = i; } }
  }
  if (bestL < 0 || bestS < 3000) {
    gray.delete(); inv.delete(); bin.delete(); labels.delete(); stats.delete(); cent.delete();
    throw new Error("발 윤곽을 찾지 못했어요.");
  }
  const mask = new cv.Mat.zeros(bin.rows, bin.cols, cv.CV_8U);
  for (let y = 0; y < labels.rows; y++) for (let x = 0; x < labels.cols; x++) {
    if (labels.intPtr(y, x)[0] === bestL) mask.ucharPtr(y, x)[0] = 255;
  }
  const left = stats.intPtr(bestL, cv.CC_STAT_LEFT)[0];
  const top = stats.intPtr(bestL, cv.CC_STAT_TOP)[0];
  const bw = stats.intPtr(bestL, cv.CC_STAT_WIDTH)[0];
  const bh = stats.intPtr(bestL, cv.CC_STAT_HEIGHT)[0];
  const lengthPx = Math.max(bw, bh);
  const lengthMm = lengthPx / PX_PER_MM;
  const vert = bh >= bw;
  const slices = [];
  if (vert) {
    for (let y = top; y < top + bh; y++) {
      let mn = Infinity, mxx = -Infinity;
      for (let x = left; x < left + bw; x++) if (mask.ucharPtr(y, x)[0]) { if (x < mn) mn = x; if (x > mxx) mxx = x; }
      if (mxx > -Infinity) slices.push({ pos: (y - top) / bh, w: mxx - mn + 1 });
    }
  } else {
    for (let x = left; x < left + bw; x++) {
      let mn = Infinity, mxx = -Infinity;
      for (let y = top; y < top + bh; y++) if (mask.ucharPtr(y, x)[0]) { if (y < mn) mn = y; if (y > mxx) mxx = y; }
      if (mxx > -Infinity) slices.push({ pos: (x - left) / bw, w: mxx - mn + 1 });
    }
  }
  if (slices.length < 20) {
    gray.delete(); inv.delete(); bin.delete(); mask.delete(); labels.delete(); stats.delete(); cent.delete();
    throw new Error("발 영역이 너무 작아요.");
  }
  const head = Math.max(1, Math.floor(slices.length * 0.08));
  const hw = slices.slice(0, head).reduce((a, b) => a + b.w, 0) / head;
  const tw = slices.slice(-head).reduce((a, b) => a + b.w, 0) / head;
  const ord = (hw >= tw) ? slices : slices.slice().reverse();
  ord.forEach((s, i) => { s.pos = i / (ord.length - 1); });
  let ballW = 0;
  for (const s of ord) if (s.pos >= 0.55 && s.pos <= 0.85 && s.w > ballW) ballW = s.w;
  const mid = ord.filter(s => s.pos >= 0.35 && s.pos <= 0.55);
  mid.sort((a, b) => a.w - b.w);
  const midW = mid.length ? mid[Math.floor(mid.length / 2)].w : 0;
  const ballMm = ballW / PX_PER_MM;
  const midMm = midW / PX_PER_MM;
  const archIdx = midMm > 0 && ballMm > 0 ? midMm / ballMm : 0;
  let archType = "normal";
  if (archIdx < 0.21) archType = "high"; else if (archIdx > 0.26) archType = "flat";
  const overlay = rectMat.clone();
  const contours = new cv.MatVector(); const hier = new cv.Mat();
  cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  cv.drawContours(overlay, contours, -1, new cv.Scalar(156, 175, 96, 255), 5);
  contours.delete(); hier.delete();
  gray.delete(); inv.delete(); bin.delete(); mask.delete(); labels.delete(); stats.delete(); cent.delete();
  return {
    overlay,
    lengthMm: Math.round(lengthMm * 10) / 10,
    ballWidthMm: Math.round(ballMm * 10) / 10,
    archIndex: Math.round(archIdx * 1000) / 1000,
    archType,
  };
}
async function runPipeline(file, onProgress) {
  onProgress(0.1, "사진 디코딩 중…");
  const bitmap = await decodeImage(file);
  const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
  const cw = Math.round(bitmap.width * scale), ch = Math.round(bitmap.height * scale);
  const off = document.createElement("canvas");
  off.width = cw; off.height = ch;
  off.getContext("2d").drawImage(bitmap, 0, 0, cw, ch);
  onProgress(0.25, "OpenCV 초기화…");
  await loadOpenCV();
  const cv = window.cv;
  onProgress(0.4, "A4 용지 검출…");
  const src = cv.imread(off);
  const quad = detectPaperQuad(cv, src);
  if (!quad) { src.delete(); throw new Error("A4 용지를 못 찾았어요."); }
  onProgress(0.6, "원근 보정…");
  const rectMat = warpToA4(cv, src, quad);
  src.delete();
  onProgress(0.8, "발 영역 분석…");
  const m = measureFootInRect(cv, rectMat);
  rectMat.delete();
  onProgress(0.95, "결과 시각화…");
  const tmp = document.createElement("canvas");
  tmp.width = RECT_W; tmp.height = RECT_H;
  cv.imshow(tmp, m.overlay); m.overlay.delete();
  onProgress(1.0, "완료!");
  return { ...m, previewCanvas: tmp };
}

function calibrateLength(rawMm) {
  const measuredMm = rawMm + LENGTH_BIAS_MM;
  const u = STORE.currentUser();
  if (!u || !u.survey || !u.survey.usualShoeSizeMm) return Math.round(measuredMm * 10) / 10;
  const expected = u.survey.usualShoeSizeMm;
  const minMm = expected - SURVEY_SIZE_TOLERANCE_MM;
  const maxMm = expected + SURVEY_SIZE_TOLERANCE_MM;
  const calibratedMm = Math.min(maxMm, Math.max(minMm, measuredMm));
  return Math.round(calibratedMm * 10) / 10;
}
function recommendBrands(footLenMm) {
  const r5 = (n) => Math.round(n / 5) * 5;
  return {
    nike: r5(footLenMm + BRAND_OFFSETS.nike),
    adidas: r5(footLenMm + BRAND_OFFSETS.adidas),
    newbalance: r5(footLenMm + BRAND_OFFSETS.newbalance),
    converse: r5(footLenMm + BRAND_OFFSETS.converse),
  };
}

function classifyWidthType(lengthMm, widthMm) {
  const ratio = widthMm / Math.max(lengthMm, 1);
  if (ratio < 0.35) return "narrow";
  if (ratio < 0.39) return "medium";
  if (ratio < 0.43) return "wide";
  return "extraWide";
}

function getWidthTypeInfo(result) {
  const stored = result.widthType;
  const key = WIDTH_TYPE_INFO[stored]
    ? stored
    : classifyWidthType(result.leftFoot.lengthMm, result.leftFoot.widthMm);
  return { key, ...WIDTH_TYPE_INFO[key] };
}

function shouldExcludeBrandForWidth(brand, widthTypeKey) {
  return (widthTypeKey === "wide" || widthTypeKey === "extraWide") && brand.toLowerCase() === "adidas";
}

// ===== Capture flow =====
function stopLiveCamera() {
  if (state.camera.stream) state.camera.stream.getTracks().forEach(track => track.stop());
  if (state.camera.side) {
    const vf = $(`vf-${state.camera.side}`);
    const video = $(`vf-${state.camera.side}-video`);
    if (vf) vf.classList.remove("camera-live");
    if (video) video.srcObject = null;
  }
  state.camera.stream = null;
  state.camera.side = null;
}

function resetCaptureSession() {
  stopLiveCamera();
  state.frontFile = null;
  state.frontDataUrl = null;
  state.sideFile = null;
  state.sideDataUrl = null;
  ["front", "side"].forEach((side) => {
    const vf = $(`vf-${side}`);
    const img = $(`vf-${side}-img`);
    const input = $(`cap-${side}-input`);
    const canvas = $(`vf-${side}-canvas`);
    if (vf) vf.classList.remove("has-photo", "camera-live");
    if (img) img.removeAttribute("src");
    if (input) input.value = "";
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  });
}

function handleCameraScreen(name) {
  if (name === "capture-front") { startLiveCamera("front"); return; }
  if (name === "capture-side") { startLiveCamera("side"); return; }
  stopLiveCamera();
}

async function startLiveCamera(side) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  stopLiveCamera();
  const vf = $(`vf-${side}`);
  const video = $(`vf-${side}-video`);
  if (!vf || !video) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 1920 } },
      audio: false,
    });
    state.camera.stream = stream;
    state.camera.side = side;
    video.srcObject = stream;
    vf.classList.add("camera-live");
    await video.play();
  } catch (err) {
    console.warn(err);
    toast("카메라 권한을 허용해 주세요. 안 되면 파일 선택으로 촬영할 수 있어요.");
  }
}

function captureVideoStill(side) {
  const video = $(`vf-${side}-video`);
  const canvas = $(`vf-${side}-canvas`);
  if (!video || !canvas || video.readyState < 2) return false;
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 1920;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const file = new File([blob], `solemate-${side}-${Date.now()}.jpg`, { type: "image/jpeg" });
    useCapturedFile(side, file, URL.createObjectURL(blob));
  }, "image/jpeg", 0.92);
  return true;
}

function useCapturedFile(side, file, previewUrl) {
  const vf = $(`vf-${side}`);
  const img = $(`vf-${side}-img`);
  if (!vf || !img) return;
  img.src = previewUrl;
  vf.classList.add("has-photo");
  if (side === "front") {
    state.frontFile = file; state.frontDataUrl = previewUrl;
    toast("정면 사진 OK!");
    stopLiveCamera();
    setTimeout(() => showScreen("capture-side"), 700);
  } else {
    state.sideFile = file; state.sideDataUrl = previewUrl;
    toast("측면 사진 OK!");
    stopLiveCamera();
    setTimeout(() => startAnalysis(), 700);
  }
}

function bindCapture(side) {
  const inputEl = $(`cap-${side}-input`);
  const btnEl = $(`cap-${side}-btn`);
  const vf = $(`vf-${side}`);
  const img = $(`vf-${side}-img`);
  btnEl.addEventListener("click", () => {
    if (state.camera.side === side && captureVideoStill(side)) return;
    inputEl.value = "";
    inputEl.click();
  });
  inputEl.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      useCapturedFile(side, file, reader.result);
    };
    reader.readAsDataURL(file);
  });
}
async function startAnalysis() {
  if (!state.frontFile) { showScreen("capture-front"); return; }
  showScreen("analyzing");
  $("loading-fill").style.width = "0%";
  try {
    const r = await runPipeline(state.frontFile, (p, label) => {
      $("loading-fill").style.width = Math.round(p * 100) + "%";
      $("analyze-sub").textContent = label;
    });
    const calLen = calibrateLength(r.lengthMm);
    const brands = recommendBrands(calLen);
    const widthType = classifyWidthType(calLen, r.ballWidthMm);
    const result = {
      date: new Date().toISOString(),
      leftFoot:  { lengthMm: calLen, widthMm: r.ballWidthMm },
      rightFoot: { lengthMm: calLen, widthMm: r.ballWidthMm },
      archIndex: r.archIndex, archType: r.archType,
      widthType,
      recommendations: brands,
    };
    state.lastResult = result;
    const u = STORE.currentUser();
    if (u) STORE.updateCurrentUser({ results: (u.results || []).concat(result) });
    renderResult(result, r.previewCanvas);
    setTimeout(() => showScreen("result"), 300);
  } catch (err) {
    console.error(err);
    toast(err.message || "측정 실패. 다시 시도해 주세요.");
    showScreen("capture-front");
  }
}

/**
 * 결과 화면 렌더링.
 * previewCanvas == null 이면 (저장된 과거 결과 보여줄 때) 캔버스에 안내문만 표시.
 */
function renderResult(result, previewCanvas) {
  const canvas = $("result-canvas");
  const ctx = canvas.getContext("2d");
  const box = canvas.parentElement.getBoundingClientRect();
  const tw = Math.floor(box.width) || 360, th = Math.floor(box.height) || 270;
  canvas.width = tw; canvas.height = th;
  ctx.fillStyle = "#e8e3d3"; ctx.fillRect(0, 0, tw, th);
  if (previewCanvas) {
    const sc = Math.min(tw / previewCanvas.width, th / previewCanvas.height);
    const dw = previewCanvas.width * sc, dh = previewCanvas.height * sc;
    const dx = (tw - dw) / 2, dy = (th - dh) / 2;
    ctx.drawImage(previewCanvas, dx, dy, dw, dh);
  } else {
    ctx.fillStyle = "#a9a394";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("저장된 측정 결과", tw / 2, th / 2 - 8);
    ctx.fillText("(" + (result.date || "").slice(0, 10) + ")", tw / 2, th / 2 + 14);
  }
  $("r-left-len").textContent = result.leftFoot.lengthMm.toFixed(1);
  $("r-left-w").textContent   = result.leftFoot.widthMm.toFixed(1);
  $("r-right-len").textContent= result.rightFoot.lengthMm.toFixed(1);
  $("r-right-w").textContent  = result.rightFoot.widthMm.toFixed(1);
  const widthType = getWidthTypeInfo(result);
  $("r-width-type").textContent = widthType.label;
  $("r-width-desc").textContent = `${widthType.detail} · ${widthType.desc}`;
  $("r-foot-type").textContent= `${widthType.label} · ${FOOT_TYPE_LABEL[result.archType]}`;
  $("r-nike").textContent       = result.recommendations.nike + "mm";
  $("r-adidas").textContent     = shouldExcludeBrandForWidth("adidas", widthType.key) ? "추천 제외" : result.recommendations.adidas + "mm";
  $("r-newbalance").textContent = result.recommendations.newbalance + "mm";
  $("r-converse").textContent   = result.recommendations.converse + "mm";
}

const RECOMMEND_PRODUCTS = [
  { category: "running", brand: "NEW BALANCE", name: "880 v14", price: "₩159,000", match: 95, tag: "쿠셔닝", tone: "dark" },
  { category: "running", brand: "NIKE", name: "Air Zoom Pegasus 41", price: "₩129,000", match: 95, tag: "쿠셔닝", tone: "light" },
  { category: "training", brand: "ASICS", name: "Gel-Kayano 30", price: "₩179,000", match: 92, tag: "안정감", tone: "dark" },
  { category: "sneakers", brand: "CONVERSE", name: "Run Star Trainer", price: "₩109,000", match: 90, tag: "데일리", tone: "light" },
  { category: "running", brand: "HOKA", name: "Clifton 9 Wide", price: "₩189,000", match: 94, tag: "와이드핏", tone: "light" },
  { category: "running", brand: "BROOKS", name: "Ghost 16", price: "₩169,000", match: 93, tag: "충격흡수", tone: "dark" },
  { category: "running", brand: "SAUCONY", name: "Ride 17", price: "₩159,000", match: 91, tag: "반발감", tone: "light" },
  { category: "running", brand: "MIZUNO", name: "Wave Rider 28", price: "₩169,000", match: 90, tag: "통기성", tone: "dark" },
  { category: "sneakers", brand: "ADIDAS", name: "Samba OG", price: "₩139,000", match: 89, tag: "데일리", tone: "light" },
  { category: "sneakers", brand: "VANS", name: "Old Skool ComfyCush", price: "₩99,000", match: 88, tag: "편안함", tone: "dark" },
  { category: "sneakers", brand: "PUMA", name: "Palermo Leather", price: "₩119,000", match: 87, tag: "가벼움", tone: "light" },
  { category: "sneakers", brand: "REEBOK", name: "Club C 85", price: "₩109,000", match: 86, tag: "클래식", tone: "dark" },
  { category: "training", brand: "NIKE", name: "Metcon 9", price: "₩169,000", match: 91, tag: "지지력", tone: "dark" },
  { category: "training", brand: "ADIDAS", name: "Dropset 3", price: "₩149,000", match: 90, tag: "안정감", tone: "light" },
  { category: "training", brand: "UNDER ARMOUR", name: "Reign 6", price: "₩139,000", match: 88, tag: "접지력", tone: "dark" },
  { category: "training", brand: "ON", name: "Cloud X 4", price: "₩179,000", match: 87, tag: "경량", tone: "light" },
];

function shoeIllustration(tone) {
  const upper = tone === "light" ? "#e8e5dc" : "#2f302b";
  const accent = tone === "light" ? "#1f1f1d" : "#7e8278";
  const sole = tone === "light" ? "#f9f6ef" : "#e8e3d3";
  return `
    <svg viewBox="0 0 220 130" fill="none" aria-hidden="true">
      <path d="M26 81 C 48 74, 67 61, 87 42 C 96 33, 114 34, 122 48 L 135 72 C 151 78, 176 81, 202 79 C 207 92, 198 102, 177 105 L 53 105 C 35 104, 24 96, 26 81 Z" fill="${upper}"/>
      <path d="M58 76 C 79 73, 99 67, 120 59" stroke="${accent}" stroke-width="5" stroke-linecap="round"/>
      <path d="M84 49 L 111 75 M101 41 L 128 75" stroke="${accent}" stroke-width="4" stroke-linecap="round" opacity="0.75"/>
      <path d="M28 92 C 68 103, 142 103, 203 89 L 208 98 C 157 118, 67 119, 25 102 Z" fill="${sole}"/>
      <path d="M35 101 C 78 112, 152 112, 201 99" stroke="#686356" stroke-width="3" stroke-linecap="round" opacity="0.45"/>
    </svg>
  `;
}

function categoryLabel(category) {
  return { all: "전체", running: "러닝화", sneakers: "스니커즈", training: "운동화" }[category] || "전체";
}

function renderRecommendSummary(result, widthType, visibleCount) {
  const summary = $("recommend-summary");
  if (!summary) return;
  const footType = result && widthType ? `${widthType.label} · ${FOOT_TYPE_LABEL[result.archType]}` : "측정 결과 기반";
  const adidasNote = widthType && (widthType.key === "wide" || widthType.key === "extraWide")
    ? "<span>ADIDAS는 발볼 특성상 추천에서 제외했어요</span>"
    : "<span>실측값과 브랜드 핏을 같이 반영했어요</span>";
  summary.innerHTML = `
    <div>
      <strong>${footType}</strong>
      <p>${categoryLabel(state.recommendCategory)} ${visibleCount}개 추천</p>
    </div>
    ${adidasNote}
  `;
}

function renderRecommendBrandChips(products) {
  const chips = $("recommend-brand-chips");
  if (!chips) return;
  const brands = ["", ...Array.from(new Set(products.map((p) => p.brand)))];
  if (state.recommendBrand && !brands.includes(state.recommendBrand)) state.recommendBrand = "";
  chips.innerHTML = brands.map((brand) => `
    <button class="recommend-brand-chip${brand === state.recommendBrand ? " active" : ""}" type="button" data-brand="${brand}">
      ${brand || "전체"}
    </button>
  `).join("");
}

function renderShoeRecommendations(category = state.recommendCategory || "all") {
  const list = $("recommend-list");
  if (!list) return;
  state.recommendCategory = category;
  const result = state.lastResult || (STORE.currentUser()?.results || []).slice(-1)[0];
  const widthType = result ? getWidthTypeInfo(result) : null;
  const baseProducts = RECOMMEND_PRODUCTS.filter((p) => {
    if (category !== "all" && p.category !== category) return false;
    if (widthType && shouldExcludeBrandForWidth(p.brand, widthType.key)) return false;
    return true;
  });
  renderRecommendBrandChips(baseProducts);
  const keyword = (state.recommendSearch || "").trim().toLowerCase();
  const products = baseProducts.filter((p) => {
    if (state.recommendBrand && p.brand !== state.recommendBrand) return false;
    if (!keyword) return true;
    return `${p.brand} ${p.name} ${p.tag}`.toLowerCase().includes(keyword);
  });
  renderRecommendSummary(result, widthType, products.length);
  if (!products.length) {
    list.innerHTML = `
      <div class="recommend-empty">
        <strong>조건에 맞는 신발이 없어요</strong>
        <p>검색어를 줄이거나 다른 브랜드를 선택해보세요.</p>
      </div>
    `;
    return;
  }
  list.innerHTML = products.map((p) => `
    <button class="recommend-product" type="button" data-product-index="${RECOMMEND_PRODUCTS.indexOf(p)}">
      <div class="shoe-art">${shoeIllustration(p.tone)}</div>
      <div class="product-copy">
        <div class="product-brand">${p.brand}</div>
        <div class="product-name">${p.name}</div>
        <div class="product-price">${p.price}</div>
        <div class="product-tags"><span class="match-badge">${p.match}% 추천</span><span>|</span><span>${p.tag}</span></div>
        <div class="product-fit" aria-hidden="true"><div class="product-fit-fill" style="width:${p.match}%"></div></div>
      </div>
    </button>
  `).join("");
}

function loadLikedShoes() {
  return STORE.currentUser()?.likedShoes || [];
}

async function saveLikedShoes(ids) {
  const user = STORE.currentUser();
  if (!user) {
    toast("로그인이 필요해요");
    return false;
  }
  STORE.setCurrentUser({ ...user, likedShoes: ids });
  try {
    const fb = await getFirebase();
    await fb.updateDoc(fb.doc(fb.db, "users", user.uid), { likedShoes: ids });
    return true;
  } catch (error) {
    console.error(error);
    toast("좋아요 저장에 실패했어요. 네트워크를 확인해 주세요.");
    return false;
  }
}

function productLikeId(productIndex) {
  const product = RECOMMEND_PRODUCTS[productIndex];
  return product ? `${product.brand}:${product.name}` : "";
}

function isProductLiked(productIndex) {
  const id = productLikeId(productIndex);
  return Boolean(id && loadLikedShoes().includes(id));
}

function updateHeartButton(productIndex) {
  const btn = document.querySelector(".detail-heart");
  if (!btn) return;
  const liked = isProductLiked(productIndex);
  btn.classList.toggle("liked", liked);
  btn.textContent = liked ? "♥" : "♡";
  btn.setAttribute("aria-pressed", liked ? "true" : "false");
  btn.setAttribute("aria-label", liked ? "찜 해제" : "찜하기");
}

async function toggleCurrentShoeLike() {
  const productIndex = state.currentProductIndex;
  const id = productLikeId(productIndex);
  if (!id) return;
  if (!STORE.currentUser()) {
    toast("로그인이 필요해요");
    showScreen("login");
    return;
  }
  const liked = loadLikedShoes();
  const next = liked.includes(id) ? liked.filter((item) => item !== id) : liked.concat(id);
  const saved = await saveLikedShoes(next);
  if (!saved) return;
  updateHeartButton(productIndex);
  toast(next.includes(id) ? "좋아요에 추가했어요" : "좋아요를 해제했어요");
}

function getBrandSizeKey(brand) {
  const normalized = brand.toLowerCase();
  if (normalized.includes("new balance")) return "newbalance";
  if (normalized.includes("nike")) return "nike";
  if (normalized.includes("adidas")) return "adidas";
  if (normalized.includes("converse")) return "converse";
  return "nike";
}

function renderShoeDetail(productIndex) {
  const product = RECOMMEND_PRODUCTS[productIndex];
  const result = state.lastResult || (STORE.currentUser()?.results || []).slice(-1)[0];
  if (!product || !result) {
    toast("먼저 측정을 완료해 주세요");
    return false;
  }
  state.currentProductIndex = productIndex;
  const widthType = getWidthTypeInfo(result);
  const sizeKey = getBrandSizeKey(product.brand);
  const recommendedSize = result.recommendations[sizeKey] || result.recommendations.nike;
  $("detail-shoe-art").innerHTML = shoeIllustration(product.tone);
  $("detail-product-name").textContent = product.name;
  $("detail-product-price").textContent = product.price;
  $("detail-brand-name").textContent = product.brand;
  $("detail-size-name").textContent = `${recommendedSize}mm`;
  $("detail-size-mm").textContent = `${result.leftFoot.lengthMm.toFixed(1)}mm x ${result.leftFoot.widthMm.toFixed(1)}mm`;
  $("detail-feature").textContent = `${product.tag} 중심의 ${product.category === "running" ? "러닝화" : product.category === "training" ? "운동화" : "스니커즈"}입니다.`;
  $("detail-reason").textContent = `${widthType.label} 발볼과 ${FOOT_TYPE_LABEL[result.archType]} 특성을 고려했을 때 ${product.brand} ${product.name}의 착화 안정감이 잘 맞습니다.`;
  updateHeartButton(productIndex);
  return true;
}

const OUTFIT_RECOMMENDATIONS = [
  {
    title: "러닝 캐주얼",
    desc: "활동성이 좋은 가벼운 레이어드 착장입니다.",
    colors: { outer: "#b6c780", top: "#f7f1e8", bottom: "#2f302b" },
    items: [
      ["아우터", "라이트 윈드브레이커"],
      ["상의", "화이트 기능성 티셔츠"],
      ["하의", "블랙 테크 팬츠"],
      ["액세서리", "러닝 캡"],
    ],
    reason: "쿠셔닝 좋은 러닝화와 잘 맞고, 발이 편한 착화감을 해치지 않는 가벼운 실루엣입니다.",
  },
  {
    title: "데일리 미니멀",
    desc: "깔끔한 스니커즈와 잘 어울리는 차분한 착장입니다.",
    colors: { outer: "#d8d0bf", top: "#fffaf0", bottom: "#6b6655" },
    items: [
      ["아우터", "숏 코튼 재킷"],
      ["상의", "크림 니트"],
      ["하의", "스트레이트 데님"],
      ["액세서리", "미니 크로스백"],
    ],
    reason: "신발의 볼륨감을 과하게 키우지 않고 전체 비율을 안정적으로 정리해 줍니다.",
  },
  {
    title: "편안한 워킹룩",
    desc: "오래 걸어도 부담 없는 여유 있는 착장입니다.",
    colors: { outer: "#9caf60", top: "#e8e1cc", bottom: "#4a4537" },
    items: [
      ["아우터", "소프트 베스트"],
      ["상의", "코튼 후디"],
      ["하의", "테이퍼드 조거 팬츠"],
      ["액세서리", "삭스 포인트"],
    ],
    reason: "넓은 발볼이나 안정감이 필요한 발에도 편안하게 이어지는 부드러운 캐주얼 조합입니다.",
  },
];

OUTFIT_RECOMMENDATIONS.push(
  {
    title: "애슬레저 셋업",
    desc: "스웨트 셋업에 러닝화를 더한 깔끔한 운동 전후 착장입니다.",
    colors: { outer: "#8f9f58", top: "#f2f0e7", bottom: "#7b8360" },
    items: [
      ["아우터", "라이트 집업 재킷"],
      ["상의", "화이트 기능성 티셔츠"],
      ["하의", "세미 와이드 스웨트 팬츠"],
      ["액세서리", "미니 크로스백"],
    ],
    reason: "운동화의 활동적인 느낌을 살리면서도 상하의 톤을 차분하게 맞춰 일상에서도 부담 없이 입기 좋아요.",
  },
  {
    title: "시티 트래블룩",
    desc: "많이 걷는 날을 위한 가벼운 레이어드 스타일입니다.",
    colors: { outer: "#d6c8ad", top: "#ffffff", bottom: "#3f4542" },
    items: [
      ["아우터", "나일론 셔츠 재킷"],
      ["상의", "베이직 반팔 티셔츠"],
      ["하의", "카고 조거 팬츠"],
      ["액세서리", "볼캡과 백팩"],
    ],
    reason: "쿠션감 있는 추천 신발과 잘 맞고, 발이 오래 편해야 하는 여행 동선에 어울리는 실용적인 조합입니다.",
  },
  {
    title: "캠퍼스 캐주얼",
    desc: "청바지와 스니커즈 중심의 단정한 데일리 조합입니다.",
    colors: { outer: "#bfc98b", top: "#f9f4e9", bottom: "#4f6480" },
    items: [
      ["아우터", "코튼 셔츠"],
      ["상의", "크림 맨투맨"],
      ["하의", "스트레이트 데님"],
      ["액세서리", "캔버스 토트백"],
    ],
    reason: "신발이 너무 튀지 않게 데님과 밝은 상의를 맞춰 균형감 있게 보이고, 등교나 외출에 편합니다.",
  },
  {
    title: "주말 카페룩",
    desc: "부드러운 니트와 여유 있는 팬츠로 만든 편한 외출복입니다.",
    colors: { outer: "#e3d8c6", top: "#f7efd9", bottom: "#7a7465" },
    items: [
      ["아우터", "숏 가디건"],
      ["상의", "소프트 니트"],
      ["하의", "핀턱 와이드 팬츠"],
      ["액세서리", "스퀘어 숄더백"],
    ],
    reason: "추천 신발의 캐주얼함을 부드러운 소재로 눌러줘서 과하지 않고 따뜻한 인상을 줍니다.",
  },
  {
    title: "비 오는 날 워킹룩",
    desc: "젖어도 관리하기 쉬운 소재를 중심으로 맞춘 착장입니다.",
    colors: { outer: "#58605b", top: "#e8eadf", bottom: "#2f3430" },
    items: [
      ["아우터", "방수 윈드브레이커"],
      ["상의", "드라이 티셔츠"],
      ["하의", "블랙 테크 팬츠"],
      ["액세서리", "방수 파우치"],
    ],
    reason: "어두운 하의와 기능성 아우터가 신발의 실루엣을 안정적으로 받쳐주고, 날씨 변화에도 편합니다.",
  },
  {
    title: "올블랙 스포츠",
    desc: "검정 계열 신발에 잘 맞는 날렵한 스포츠 스타일입니다.",
    colors: { outer: "#252824", top: "#3a3d38", bottom: "#171917" },
    items: [
      ["아우터", "블랙 트랙 재킷"],
      ["상의", "차콜 티셔츠"],
      ["하의", "슬림 조거 팬츠"],
      ["액세서리", "블랙 스포츠 워치"],
    ],
    reason: "발볼이 넓어 보여도 전체 톤이 이어져 신발이 둔해 보이지 않고, 활동적인 이미지가 또렷해집니다.",
  },
  {
    title: "소프트 뉴트럴",
    desc: "밝은 운동화와 잘 어울리는 크림, 베이지 중심 착장입니다.",
    colors: { outer: "#d9c9ad", top: "#fff9ec", bottom: "#b7aa92" },
    items: [
      ["아우터", "베이지 블루종"],
      ["상의", "아이보리 티셔츠"],
      ["하의", "크림 코튼 팬츠"],
      ["액세서리", "브라운 미니백"],
    ],
    reason: "밝은 신발을 신을 때 발만 떠 보이지 않게 전체 톤을 부드럽게 이어주는 조합입니다.",
  },
  {
    title: "데님 스트릿",
    desc: "스니커즈의 볼륨감을 살리는 스트릿 캐주얼입니다.",
    colors: { outer: "#6b7890", top: "#f4f4ef", bottom: "#2e4058" },
    items: [
      ["아우터", "오버핏 데님 재킷"],
      ["상의", "그래픽 티셔츠"],
      ["하의", "와이드 데님"],
      ["액세서리", "비니 또는 볼캡"],
    ],
    reason: "볼륨 있는 신발과 와이드 데님이 자연스럽게 이어져 하체 비율이 안정적으로 보입니다.",
  },
  {
    title: "라이트 하이킹",
    desc: "산책과 가벼운 야외 활동에 어울리는 실용 착장입니다.",
    colors: { outer: "#a7b070", top: "#f0ead7", bottom: "#5d604f" },
    items: [
      ["아우터", "포켓 베스트"],
      ["상의", "흡습 티셔츠"],
      ["하의", "스트링 팬츠"],
      ["액세서리", "버킷햇"],
    ],
    reason: "안정감 있는 신발 추천과 맞춰 발목과 무릎 부담을 줄이는 가벼운 야외 스타일입니다.",
  }
);

function renderClothesRecommendations() {
  const list = $("clothes-list");
  if (!list) return;
  list.innerHTML = OUTFIT_RECOMMENDATIONS.map((outfit, index) => `
    <button class="clothes-card" type="button" data-outfit-index="${index}">
      <div class="clothes-swatch" style="background:linear-gradient(135deg, ${outfit.colors.outer}, ${outfit.colors.top} 50%, ${outfit.colors.bottom});"></div>
      <div>
        <h4>${outfit.title}</h4>
        <p>${outfit.items.map(([, value]) => value).slice(0, 3).join(", ")}</p>
      </div>
    </button>
  `).join("");
}

function renderOutfitDetail(index) {
  const outfit = OUTFIT_RECOMMENDATIONS[index] || OUTFIT_RECOMMENDATIONS[0];
  $("outfit-title").textContent = outfit.title;
  $("outfit-desc").textContent = outfit.desc;
  $("outfit-reason").textContent = outfit.reason;
  $("outfit-visual").innerHTML = `
    <div class="outfit-figure">
      <div class="outfit-head"></div>
      <div class="outfit-outer" style="background:${outfit.colors.outer}"></div>
      <div class="outfit-top" style="background:${outfit.colors.top}"></div>
      <div class="outfit-bottom" style="background:${outfit.colors.bottom}"></div>
      <div class="outfit-shoes"></div>
    </div>
  `;
  $("outfit-items").innerHTML = outfit.items.map(([label, value]) => `
    <div class="outfit-item"><span>${label}</span><span>${value}</span></div>
  `).join("");
}

// ===== My page =====
function renderMyPage() {
  const u = STORE.currentUser();
  const box = $("mp-content");
  if (!u) { box.innerHTML = "<div class='admin-empty'>로그인이 필요해요</div>"; return; }
  const s = u.survey || {};
  const last = (u.results || []).slice(-1)[0];
  const labels = { flat: "평발", bunion: "무지외반증", sole_pain: "발바닥 통증", achilles: "아킬레스건 통증", other: "기타", none: "없음" };
  const issues = (s.issues || []).map(v => labels[v] || v).join(", ") || "—";
  box.innerHTML =
    `<div class="mp-row"><span class="label">아이디</span><span class="value">${u.id}</span></div>` +
    `<div class="mp-row"><span class="label">이메일</span><span class="value">${u.email || "—"}</span></div>` +
    `<div class="mp-row"><span class="label">가입일</span><span class="value">${(u.createdAt || "").slice(0, 10)}</span></div>` +
    `<div class="mp-row"><span class="label">생년월일</span><span class="value">${s.birth || "—"}</span></div>` +
    `<div class="mp-row"><span class="label">성별</span><span class="value">${s.gender || "—"}</span></div>` +
    `<div class="mp-row"><span class="label">키 / 몸무게</span><span class="value">${s.heightCm || "—"}cm / ${s.weightKg || "—"}kg</span></div>` +
    `<div class="mp-row"><span class="label">평소 신발 사이즈</span><span class="value">${s.usualShoeSizeMm || "—"}mm</span></div>` +
    `<div class="mp-row"><span class="label">발 이슈</span><span class="value">${issues}</span></div>` +
    `<div class="mp-row"><span class="label">측정 횟수</span><span class="value">${(u.results || []).length}회</span></div>` +
    `<div class="mp-row"><span class="label">좋아요 신발</span><span class="value">${(u.likedShoes || []).length}개</span></div>` +
    (last ?
      `<div class="mp-row"><span class="label">마지막 측정</span><span class="value">${last.date.slice(0, 10)}</span></div>` +
      `<div class="mp-row"><span class="label">최근 발 길이</span><span class="value">${last.leftFoot.lengthMm.toFixed(1)}mm</span></div>` +
      `<div class="mp-row"><span class="label">최근 발 유형</span><span class="value">${FOOT_TYPE_LABEL[last.archType]}</span></div>`
    : "");
}

// ===== Admin =====
async function renderAdmin() {
  const box = $("admin-content");
  box.innerHTML = "<div class='admin-empty'>Firebase 사용자 목록을 불러오는 중이에요</div>";
  let users = STORE.loadUsers();
  try {
    const fb = await getFirebase();
    const snap = await fb.getDocs(fb.collection(fb.db, "users"));
    users = snap.docs.map((docSnap) => ({ uid: docSnap.id, ...docSnap.data() }));
    STORE.saveUsers(users);
  } catch (error) {
    console.error(error);
    box.innerHTML = "<div class='admin-empty'>Firebase 사용자 목록을 불러오지 못했어요</div>";
    return;
  }
  if (users.length === 0) { box.innerHTML = "<div class='admin-empty'>아직 가입한 사용자가 없어요</div>"; return; }
  box.innerHTML = users.map(u => {
    const s = u.survey || {};
    const last = (u.results || []).slice(-1)[0];
    return `<div class="admin-user-card">
      <h3>${u.id} <span class="small">${u.email || ""} · 가입 ${(u.createdAt || "").slice(0, 10)}</span></h3>
      <div class="data-grid">
        <div><b>생년월일</b> ${s.birth || "—"}</div>
        <div><b>성별</b> ${s.gender || "—"}</div>
        <div><b>키/몸무게</b> ${s.heightCm || "—"}cm / ${s.weightKg || "—"}kg</div>
        <div><b>신발</b> ${s.usualShoeSizeMm || "—"}mm</div>
        <div><b>발 이슈</b> ${(s.issues || []).join(",") || "—"}</div>
        <div><b>측정</b> ${(u.results || []).length}회</div>
        ${last ? `<div><b>최근 발길이</b> ${last.leftFoot.lengthMm.toFixed(1)}mm</div><div><b>최근 발유형</b> ${FOOT_TYPE_LABEL[last.archType]}</div>` : ""}
      </div>
    </div>`;
  }).join("");
}

// ===== Bind events =====
function bind() {
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-go]");
    if (t) {
      const dest = t.getAttribute("data-go");
      showScreen(dest);
      if (dest === "survey-1" || dest === "survey-2" || dest === "survey-3") prefillSurvey();
    }
  });
  $("su-check").addEventListener("click", checkIdDuplicate);
  $("su-send-code").addEventListener("click", sendVerifyCode);
  $("su-submit").addEventListener("click", trySignup);
  $("li-submit").addEventListener("click", () => tryLogin($("li-id").value.trim(), $("li-pw").value));
  $("li-forgot").addEventListener("click", () => toast("아이디 찾기는 가입 시 이메일로 안내됩니다 (데모)"));
  $("sv-done").addEventListener("click", saveSurveyAndNext);
  bindCapture("front"); bindCapture("side");
  $("r-save").addEventListener("click", () => {
    if (!state.lastResult) return;
    toast("결과가 내 기록에 저장됐어요");
  });
  const shopBtn = $("r-shop");
  if (shopBtn) {
    shopBtn.addEventListener("click", () => {
      const r = state.lastResult;
      if (!r) { toast("먼저 측정을 완료해 주세요"); return; }
      state.recommendCategory = "all";
      state.recommendBrand = "";
      state.recommendSearch = "";
      const searchInput = $("recommend-search");
      if (searchInput) searchInput.value = "";
      $$(".recommend-tab").forEach((t) => t.classList.toggle("active", t.dataset.category === "all"));
      renderShoeRecommendations("all");
      showScreen("shoe-recommendations");
    });
  }
  $$(".recommend-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".recommend-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      state.recommendBrand = "";
      renderShoeRecommendations(tab.dataset.category || "all");
    });
  });
  const recommendSearch = $("recommend-search");
  if (recommendSearch) {
    recommendSearch.addEventListener("input", () => {
      state.recommendSearch = recommendSearch.value;
      renderShoeRecommendations();
    });
  }
  const recommendBrandChips = $("recommend-brand-chips");
  if (recommendBrandChips) {
    recommendBrandChips.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-brand]");
      if (!chip) return;
      state.recommendBrand = chip.dataset.brand || "";
      renderShoeRecommendations();
    });
  }
  const recommendList = $("recommend-list");
  if (recommendList) {
    recommendList.addEventListener("click", (e) => {
      const item = e.target.closest("[data-product-index]");
      if (!item) return;
      if (renderShoeDetail(Number(item.dataset.productIndex))) showScreen("shoe-detail");
    });
  }
  const heartBtn = document.querySelector(".detail-heart");
  if (heartBtn) heartBtn.addEventListener("click", toggleCurrentShoeLike);
  renderClothesRecommendations();
  const clothesList = $("clothes-list");
  if (clothesList) {
    clothesList.addEventListener("click", (e) => {
      const card = e.target.closest("[data-outfit-index]");
      if (!card) return;
      renderOutfitDetail(Number(card.dataset.outfitIndex));
      showScreen("outfit-detail");
    });
  }
  $("go-mypage").addEventListener("click", () => {
    if (!STORE.currentUser()) { toast("로그인이 필요해요"); showScreen("login"); return; }
    showScreen("mypage"); renderMyPage();
  });
  $("mp-logout").addEventListener("click", logout);
  $("admin-logout").addEventListener("click", logout);
}

async function bootAuth() {
  const session = STORE.loadSession();
  if (session?.isAdmin) {
    showScreen("admin");
    renderAdmin();
    return;
  }
  try {
    const fb = await getFirebase();
    let first = true;
    fb.onAuthStateChanged(fb.auth, async (firebaseUser) => {
      try {
        if (firebaseUser) {
          const u = await loadFirebaseUser(firebaseUser);
          routeAfterLogin(u);
        } else {
          STORE.setCurrentUser(null);
          if (first) showScreen("start");
        }
      } catch (error) {
        console.error(error);
        STORE.setCurrentUser(null);
        showScreen("start");
        toast("Firebase 사용자 정보를 불러오지 못했어요.");
      } finally {
        first = false;
      }
    });
  } catch (error) {
    console.error(error);
    showScreen("start");
    toast("Firebase 초기화에 실패했어요. 인터넷 연결을 확인해 주세요.");
  }
}

// ===== Boot =====
document.addEventListener("DOMContentLoaded", () => {
  bind();
  bootAuth();
  loadOpenCV().catch(() => {});
});
