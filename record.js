// 수동 recording 모드 — API 응답과 스크린샷을 자동 페어링
// 사용법: node record.js <url> [출력명]
// 예시:   node record.js https://example.com my-session

const playwright = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const readline = require('readline');

const NOISE_PATTERNS = [
  /sentry\.io/,
  /google-analytics/,
  /googletagmanager/,
  /hotjar/,
  /amplitude/,
  /segment\.io/,
  /mixpanel/,
  /intercom/,
];

function isNoise(url) {
  return NOISE_PATTERNS.some(p => p.test(url));
}

function requestToCurl({ method, url, headers, postData }) {
  let curl = `curl -X ${method} '${url}'`;
  for (const [key, value] of Object.entries(headers)) {
    if (!['content-length', 'connection', 'host'].includes(key.toLowerCase())) {
      curl += ` \\\n  -H '${key}: ${value}'`;
    }
  }
  if (postData) {
    const contentType = headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      curl += ` \\\n  -d '${postData}'`;
    } else {
      curl += ` \\\n  --data '${postData}'`;
    }
  }
  return curl;
}

function waitForEnter() {
  const rl = readline.createInterface({ input: process.stdin });
  return new Promise(resolve => {
    console.log('\n브라우저에서 원하는 동작을 수행하세요.');
    console.log('완료되면 여기서 [Enter] 를 누르세요...\n');
    rl.once('line', () => { rl.close(); resolve(); });
  });
}

async function record() {
  const url = process.argv[2];
  const sessionName = process.argv[3] || `session-${Date.now()}`;

  if (!url) {
    console.error('사용법: node record.js <url> [출력명]');
    console.error('예시:   node record.js https://example.com my-session');
    process.exit(1);
  }

  const outputDir = path.join('./capture-results', sessionName);
  const snapshotsDir = path.join(outputDir, 'snapshots');
  await fs.mkdir(snapshotsDir, { recursive: true });

  console.log(`\n[Recording] ${sessionName}`);
  console.log(`URL: ${url}`);
  console.log(`결과 저장 위치: ${outputDir}`);

  const browser = await playwright.chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // request 객체를 key로 사용해서 request↔response를 정확히 매핑
  const pendingRequests = new Map();  // request → { pageUrl, method, url, headers, postData, timestamp }
  const completedEntries = [];        // 응답까지 완료된 요청 목록
  const snapshots = [];

  let currentPageUrl = url;
  let snapshotIndex = 0;
  let debounceTimer = null;
  let pendingForSnapshot = [];        // 스냅샷 찍을 때 포함할 entry 인덱스들

  const DEBOUNCE_MS = 800;

  // 페이지 이동 감지 (클라이언트 사이드 포함)
  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return;
    const newUrl = frame.url();
    if (newUrl === 'about:blank') return;
    if (newUrl !== currentPageUrl) {
      console.log(`  [navigate] ${newUrl}`);
      currentPageUrl = newUrl;
    }
  });

  page.on('request', request => {
    if (!['xhr', 'fetch'].includes(request.resourceType())) return;
    if (isNoise(request.url())) return;

    pendingRequests.set(request, {
      pageUrl: currentPageUrl,
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      postData: request.postData(),
      timestamp: new Date().toISOString(),
    });
  });

  page.on('response', async response => {
    const request = response.request();
    if (!['xhr', 'fetch'].includes(request.resourceType())) return;
    if (isNoise(response.url())) return;

    const reqData = pendingRequests.get(request);
    if (!reqData) return;
    pendingRequests.delete(request);

    let responseBody = null;
    try {
      const text = await response.text();
      responseBody = text.substring(0, 2000);
    } catch {
      // 무시
    }

    const entryIndex = completedEntries.length;
    completedEntries.push({
      ...reqData,
      response: { status: response.status(), body: responseBody },
      snapshotFile: null, // takeSnapshot 시점에 채워짐
    });

    pendingForSnapshot.push(entryIndex);
    scheduleSnapshot();
  });

  async function takeSnapshot() {
    if (pendingForSnapshot.length === 0) return;

    snapshotIndex++;
    const snapshotFile = `snapshot-${String(snapshotIndex).padStart(3, '0')}.png`;
    const snapshotPath = path.join(snapshotsDir, snapshotFile);

    try {
      await page.screenshot({ path: snapshotPath, fullPage: true });

      const capturedIndices = [...pendingForSnapshot];
      pendingForSnapshot = [];

      const relFile = `snapshots/${snapshotFile}`;
      snapshots.push({
        index: snapshotIndex,
        pageUrl: currentPageUrl,
        file: relFile,
        timestamp: new Date().toISOString(),
        entryCount: capturedIndices.length,
      });

      // 각 entry에 snapshotFile 연결
      for (const idx of capturedIndices) {
        completedEntries[idx].snapshotFile = relFile;
      }

      console.log(`  [snap-${String(snapshotIndex).padStart(3, '0')}] ${path.basename(currentPageUrl || url)} (요청 ${capturedIndices.length}개)`);
    } catch {
      // 페이지 닫힘 등 무시
    }
  }

  function scheduleSnapshot() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => takeSnapshot(), DEBOUNCE_MS);
  }

  let browserClosed = false;

  browser.on('disconnected', async () => {
    if (browserClosed) return;
    browserClosed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    await saveResults(null);
    process.exit(0);
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  await waitForEnter();

  if (browserClosed) return;
  browserClosed = true;

  if (debounceTimer) clearTimeout(debounceTimer);
  await takeSnapshot();

  const finalPath = path.join(outputDir, 'final.png');
  await page.screenshot({ path: finalPath, fullPage: true });
  console.log(`최종 스크린샷 저장: final.png`);

  await browser.close();
  await saveResults(finalPath);

  async function saveResults(finalScreenshotPath) {
    const requests = completedEntries.map((entry, i) => ({
      index: i + 1,
      pageUrl: entry.pageUrl,
      method: entry.method,
      url: entry.url,
      timestamp: entry.timestamp,
      snapshotFile: entry.snapshotFile,
      curl: requestToCurl(entry),
      response: entry.response,
    }));

    const jsonPath = path.join(outputDir, 'requests.json');
    await fs.writeFile(jsonPath, JSON.stringify({
      session: sessionName,
      startUrl: url,
      recordedAt: new Date().toISOString(),
      totalRequests: requests.length,
      totalSnapshots: snapshots.length,
      finalScreenshot: finalScreenshotPath ? 'final.png' : null,
      snapshots,
      requests,
    }, null, 2));
    console.log(`요청 데이터 저장: ${jsonPath}`);

    // curl 스크립트 — 페이지별 + 스냅샷별 섹션
    const curlPath = path.join(outputDir, 'requests.curl.sh');
    const lines = [
      '#!/bin/bash',
      `# Session: ${sessionName}`,
      `# Start URL: ${url}`,
      `# Recorded: ${new Date().toISOString()}`,
      '',
    ];

    let lastPageUrl = null;
    let lastSnapshotFile = null;

    for (const req of requests) {
      if (req.pageUrl !== lastPageUrl) {
        lines.push(`\n# ${'═'.repeat(60)}`);
        lines.push(`# Page: ${req.pageUrl}`);
        lines.push(`# ${'═'.repeat(60)}`);
        lastPageUrl = req.pageUrl;
        lastSnapshotFile = null;
      }
      if (req.snapshotFile !== lastSnapshotFile) {
        lines.push(`\n# snapshot: ${req.snapshotFile ?? '(없음)'}`);
        lastSnapshotFile = req.snapshotFile;
      }
      lines.push(`\n# [${req.index}] ${req.method} ${req.url}`);
      if (req.response) lines.push(`# status: ${req.response.status}`);
      lines.push(req.curl);
    }

    await fs.writeFile(curlPath, lines.join('\n'));
    await fs.chmod(curlPath, 0o755);
    console.log(`curl 스크립트 저장: ${curlPath}`);

    console.log(`\n=== 완료 ===`);
    console.log(`캡처된 요청: ${requests.length}개 (노이즈 제외)`);
    console.log(`스냅샷: ${snapshots.length}개`);
    console.log(`저장 위치: ${outputDir}`);
  }
}

record().catch(console.error);
