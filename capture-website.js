// 웹페이지 스크린샷 + 네트워크 요청 캡처 스크립트
// 사용법: node capture-website.js <config.json>

const playwright = require('playwright');
const fs = require('fs/promises');
const path = require('path');

// 요청을 curl 명령어로 변환 (이미 추출된 데이터 사용)
function requestToCurl(requestData) {
  const { method, url, headers, postData } = requestData;

  let curl = `curl -X ${method} '${url}'`;

  // 헤더 추가
  for (const [key, value] of Object.entries(headers)) {
    // 일부 자동 생성 헤더는 제외
    if (!['content-length', 'connection', 'host'].includes(key.toLowerCase())) {
      curl += ` \\\n  -H '${key}: ${value}'`;
    }
  }

  // POST 데이터 추가
  if (postData) {
    const contentType = headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      curl += ` \\\n  -H 'Content-Type: application/json' \\\n  -d '${postData}'`;
    } else {
      curl += ` \\\n  --data '${postData}'`;
    }
  }

  return curl;
}

// 단일 시나리오 실행
async function captureScenario(browser, scenario, outputDir) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();
  const requests = [];
  const responses = new Map();

  // 쿠키 설정 (있는 경우)
  if (scenario.cookies) {
    await context.addCookies(scenario.cookies);
  }

  // 요청 캡처
  page.on('request', request => {
    const resourceType = request.resourceType();
    // API 요청만 캡처 (이미지, CSS 등 제외)
    if (['xhr', 'fetch'].includes(resourceType)) {
      requests.push({
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        postData: request.postData(),
        timestamp: Date.now(),
      });
    }
  });

  // 응답 캡처
  page.on('response', async response => {
    const request = response.request();
    const resourceType = request.resourceType();

    if (['xhr', 'fetch'].includes(resourceType)) {
      try {
        const body = await response.text();
        responses.set(response.url(), {
          status: response.status(),
          headers: response.headers(),
          body: body,
        });
      } catch (e) {
        // 응답 본문을 읽을 수 없는 경우 무시
      }
    }
  });

  console.log(`\n[${scenario.name}] 시작...`);
  console.log(`URL: ${scenario.url}`);

  // 페이지 이동
  await page.goto(scenario.url, { waitUntil: 'networkidle', timeout: 30000 });

  // 추가 액션 실행 (클릭, 입력 등)
  if (scenario.actions) {
    for (const action of scenario.actions) {
      console.log(`  액션: ${action.type} ${action.selector || ''}`);

      switch (action.type) {
        case 'click':
          await page.click(action.selector);
          break;
        case 'fill':
          await page.fill(action.selector, action.value);
          break;
        case 'wait':
          await page.waitForTimeout(action.ms);
          break;
        case 'waitForSelector':
          await page.waitForSelector(action.selector);
          break;
      }

      // 액션 후 네트워크 안정화 대기
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    }
  }

  // 추가 대기
  await page.waitForTimeout(scenario.waitMs || 2000);

  // 스크린샷 저장
  const screenshotPath = path.join(outputDir, `${scenario.name}.png`);
  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
  });
  console.log(`  스크린샷 저장: ${screenshotPath}`);

  // 네트워크 요청을 curl로 변환
  const curlCommands = requests.map(req => {
    const response = responses.get(req.url);
    return {
      url: req.url,
      method: req.method,
      curl: requestToCurl(req),
      response: response ? {
        status: response.status,
        body: response.body.substring(0, 1000), // 처음 1000자만
      } : null,
    };
  });

  // 결과 저장
  const resultPath = path.join(outputDir, `${scenario.name}.json`);
  await fs.writeFile(resultPath, JSON.stringify({
    scenario: scenario.name,
    url: scenario.url,
    timestamp: new Date().toISOString(),
    requests: curlCommands,
  }, null, 2));
  console.log(`  네트워크 요청 저장: ${resultPath}`);

  // curl 명령어만 따로 저장
  const curlPath = path.join(outputDir, `${scenario.name}.curl.sh`);
  const curlScript = curlCommands.map((req, idx) =>
    `# ${idx + 1}. ${req.method} ${req.url}\n${req.curl}\n`
  ).join('\n\n');
  await fs.writeFile(curlPath, curlScript);
  console.log(`  curl 스크립트 저장: ${curlPath}`);

  await context.close();

  return {
    scenario: scenario.name,
    requestCount: requests.length,
    screenshotPath,
    resultPath,
    curlPath,
  };
}

// 메인 실행
async function main() {
  const configPath = process.argv[2] || './capture-config.json';

  // 설정 파일 읽기
  let config;
  try {
    const configContent = await fs.readFile(configPath, 'utf-8');
    config = JSON.parse(configContent);
  } catch (e) {
    console.error(`설정 파일을 읽을 수 없습니다: ${configPath}`);
    console.error('예시 설정 파일을 생성합니다: capture-config.example.json');

    const exampleConfig = {
      outputDir: './capture-results',
      headless: false,
      scenarios: [
        {
          name: 'login-page',
          url: 'https://dev-cgkr.colosseum.kr/login',
          waitMs: 2000,
        },
        {
          name: 'dashboard',
          url: 'https://dev-cgkr.colosseum.kr/dashboard',
          cookies: [
            {
              name: 'CSESSIONID',
              value: 'your-session-id',
              domain: 'dev-cgkr.colosseum.kr',
              path: '/',
            },
          ],
          actions: [
            { type: 'wait', ms: 1000 },
            { type: 'click', selector: '.some-button' },
            { type: 'waitForSelector', selector: '.result' },
          ],
          waitMs: 3000,
        },
      ],
    };

    await fs.writeFile('capture-config.example.json', JSON.stringify(exampleConfig, null, 2));
    process.exit(1);
  }

  // 출력 디렉토리 생성
  const outputDir = config.outputDir || './capture-results';
  await fs.mkdir(outputDir, { recursive: true });

  // 브라우저 실행
  const browser = await playwright.chromium.launch({
    headless: config.headless !== false, // 기본값 true
  });

  const results = [];

  // 모든 시나리오 실행
  for (const scenario of config.scenarios) {
    try {
      const result = await captureScenario(browser, scenario, outputDir);
      results.push({ ...result, success: true });
    } catch (error) {
      console.error(`[${scenario.name}] 실패:`, error.message);
      results.push({
        scenario: scenario.name,
        success: false,
        error: error.message,
      });
    }
  }

  await browser.close();

  // 최종 결과 요약
  console.log('\n=== 실행 결과 요약 ===');
  results.forEach(result => {
    if (result.success) {
      console.log(`✅ ${result.scenario}: ${result.requestCount}개 요청 캡처`);
    } else {
      console.log(`❌ ${result.scenario}: ${result.error}`);
    }
  });

  // 요약 파일 저장
  const summaryPath = path.join(outputDir, '_summary.json');
  await fs.writeFile(summaryPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    totalScenarios: results.length,
    successful: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results,
  }, null, 2));
  console.log(`\n요약 파일: ${summaryPath}`);
}

main().catch(console.error);
