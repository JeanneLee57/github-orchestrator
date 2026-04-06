# github-orchestrator

GitHub 이슈 하나로 **계획 → 테스트 작성 → 구현 → 자가 수정 → 리뷰 → PR 생성**까지 전구간을 자동화하는 멀티 에이전트 TDD 파이프라인.

개별 레포와 독립적으로 존재하며, 여러 레포에서 발생하는 이슈를 중앙에서 수집·처리한다.

---

## 목차

- [전체 흐름](#전체-흐름)
- [아키텍처 설계](#아키텍처-설계)
  - [멀티 에이전트 오케스트레이션](#멀티-에이전트-오케스트레이션)
  - [컨텍스트 격리 전략](#컨텍스트-격리-전략)
  - [TDD 게이트](#tdd-게이트)
  - [Self-healing 루프](#self-healing-루프)
  - [관찰 가능성](#관찰-가능성)
- [파일 구조](#파일-구조)
- [에이전트 상세](#에이전트-상세)
- [GitHub Actions 워크플로우](#github-actions-워크플로우)
- [설정](#설정)
- [환경 변수 / Secrets](#환경-변수--secrets)
- [비용 예상](#비용-예상)

---

## 전체 흐름

```
[대상 레포] 이슈 생성 + auto-impl 라벨
       │
       ▼
[poll-issues.yml] cron 30분마다 폴링
  └─ fetch-issues.ts: Octokit으로 이슈 수집 → wip 라벨 추가
       │
       ▼  repository_dispatch
[implement-tdd.yml]
  └─ run-tdd.ts (오케스트레이터)
       │
       ├─ Phase 1: Planner ──────── Issue → 구조화된 구현 계획
       │
       ├─ Phase 2: TestWriter ───── 계획 → 실패하는 테스트 (RED)
       │              └── [TDD Gate] 테스트가 실제로 실패하는지 검증
       │
       ├─ Phase 3: Implementer ──── 계획 + 테스트 → 초기 구현
       │              └── [TDD Gate] 테스트 통과 여부 검증 (GREEN 시도)
       │
       ├─ Phase 4: Healer ────────── 실패 시 자가 수정 (최대 3회)
       │              ├── 실패 로그 + 이전 diff를 컨텍스트로 전달
       │              └── [TDD Gate] 매 iteration 후 GREEN 검증
       │
       ├─ Phase 5: Reviewer ──────── 최종 수용 기준 검증
       │
       └─ create-pr.ts: 대상 레포에 PR 생성 + 이슈 코멘트
```

---

## 아키텍처 설계

### 멀티 에이전트 오케스트레이션

단일 LLM 호출로 전체 구현을 처리하지 않고, **역할이 분리된 5개 에이전트**가 파이프라인을 구성한다.

각 에이전트는 독립적인 시스템 프롬프트와 명확히 정의된 입출력 인터페이스를 가진다.

```
Planner      → Plan (JSON)
TestWriter   → FileChange[] (테스트 파일)
Implementer  → FileChange[] (구현 파일)
Healer       → FileChange[] (수정 파일) + confidence
Reviewer     → ReviewResult (approved/issues/suggestions)
```

**역할 분리의 이유:**

1. **컨텍스트 오염 방지** — Implementer가 Planner의 중간 추론 과정을 보면 잘못된 전제를 이어받는다. 각 에이전트는 해당 단계에 필요한 정보만 받는다.
2. **모델 최적화** — 계획·구현·수정은 `claude-opus-4-6`(고비용·고품질), 리뷰는 `claude-sonnet-4-6`(저비용)으로 분리해 비용을 절감한다.
3. **단계별 검증** — 각 에이전트의 출력이 다음 단계 진입 전에 검증된다(TDD 게이트, 파일 존재 여부 등).
4. **재시도 단위 최소화** — 실패 시 전체를 재시작하지 않고 해당 에이전트만 재호출한다.

---

### 컨텍스트 격리 전략

`scripts/utils/context-builder.ts`가 각 에이전트에 전달되는 컨텍스트를 명시적으로 구성한다.

| 에이전트 | 보는 정보 | 보지 않는 정보 |
|---|---|---|
| Planner | 이슈 원문, 레포 파일 트리, 기존 테스트 패턴 | 이전 구현 시도, 실패 로그 |
| TestWriter | 계획(Plan), 기존 테스트 컨벤션, 수정 대상 소스 파일 | 구현 코드, 이전 시도 |
| Implementer | 계획, 실패 테스트 파일(스펙), 기존 소스 파일 | 이전 healing 시도 |
| Healer | 계획, 현재 구현, 실패 로그, **이전 iteration의 diff** | 다른 이슈의 컨텍스트 |
| Reviewer | 계획, 최종 테스트, 최종 구현, 테스트 결과 | 중간 과정의 모든 것 |

**핵심 설계 결정 — 이전 diff 전달:**

Healer에게 "무엇이 실패했는가"와 함께 "이전에 무엇을 시도했는가"를 동시에 전달한다.
diff 없이 실패 로그만 전달하면 동일한 수정을 반복하는 경향이 있다.

```typescript
// utils/git.ts
export function diffSinceLastCommit(cwd: string): string {
  const r = run("git diff HEAD~1 HEAD 2>/dev/null || git diff", cwd);
  return r.stdout;
}

// healer.ts — 이전 시도를 인지하고 다른 접근법을 강제
const context = buildHealerContext({
  ...
  previousDiff,   // 이전 iteration이 변경한 내용
  iteration,      // 몇 번째 시도인지
});
```

---

### TDD 게이트

파이프라인에 두 개의 명시적 검증 지점을 내장한다.

**RED 게이트** — TestWriter 직후

```typescript
const redResult = runTests(TEST_CMD, repoRoot);
assertTestsRed(redResult, "initial");
// 테스트가 실패해야 정상. 통과하면 경고 로그 (테스트가 새 동작을 검증하지 않을 수 있음)
```

**GREEN 게이트** — Implementer 직후, 그리고 각 Healer iteration 직후

```typescript
const testResult = runTests(TEST_CMD, repoRoot);
const passed = assertTestsGreen(testResult);
// 통과하면 다음 단계 진행. 실패하면 Healer로 넘어가거나 다음 iteration 진입
```

RED 게이트의 목적은 **false positive 차단**이다.
테스트가 구현 없이도 통과한다면 그 테스트는 아무것도 검증하지 않는 것이다.

---

### Self-healing 루프

```
Phase 3 (Implementer) → 테스트 실패
       │
       ▼
[Heal iteration 1]
  입력: 실패 로그 + 현재 구현 + 이전 diff (없음, 첫 번째)
  출력: 수정된 파일들
  → git checkpoint (다음 iteration의 "이전 diff" 기준점)
  → TDD 게이트 → 통과 시 종료
       │ 실패
       ▼
[Heal iteration 2]
  입력: 실패 로그 + 현재 구현 + iteration 1의 diff
  → Healer는 iteration 1이 무엇을 시도했는지 알고, 다른 접근법을 택한다
       │ 실패
       ▼
[Heal iteration 3]
  입력: 실패 로그 + 현재 구현 + iteration 2의 diff
       │
       ▼ (3회 초과 시 포기, 테스트 미통과 상태로 draft PR 생성)
```

각 iteration 전에 `checkBudget()`을 호출해 누적 비용이 `AI_BUDGET_LIMIT_USD`를 초과하면 즉시 중단한다.

---

### 관찰 가능성

`scripts/utils/logger.ts`가 모든 에이전트 호출을 추적한다.

**추적 항목:**
- 에이전트별 입력/출력 토큰
- 에이전트별 비용 (USD)
- 단계별 소요 시간 (ms)
- 단계별 성공/실패 상태

**출력:**
- 콘솔 실시간 로그
- `logs/issue-{N}.log` — 텍스트 로그
- `logs/issue-{N}-summary.json` — 구조화된 JSON 요약 (GitHub Actions artifact로 업로드)
- GitHub Step Summary — 워크플로우 실행 화면에 마크다운 테이블로 표시

```
ORCHESTRATOR SUMMARY
────────────────────────────────────────────────────────────
Issue:        JeanneLee57/my-repo#42
Branch:       auto-impl/issue-42
Tests passed: true
Iterations:   2
Total cost:   $0.1823
Total time:   94.3s

Phases:
  ✅ planning         (8201ms)
  ✅ test-writing     (12443ms) — 2 test files written, 5 failures confirmed
  ❌ implementation   (9821ms)  — 3 failures remain
  ✅ heal-iter-1      (11203ms) — Tests GREEN
  ✅ review           (3421ms)

Agent calls:
  planner/plan-generation:        $0.0312
  test-writer/tdd-red:            $0.0521
  implementer/tdd-green-initial:  $0.0483
  healer/self-healing-iter-1:     $0.0398
  reviewer/final-review:          $0.0109
```

---

## 파일 구조

```
github-orchestrator/
│
├── .github/workflows/
│   ├── poll-issues.yml        # cron 30분마다 이슈 폴링 → repository_dispatch
│   └── implement-tdd.yml      # 오케스트레이터 실행 → PR 생성
│
├── configs/
│   └── target-repos.json      # 모니터링 레포 목록 + 라벨 설정
│
├── scripts/
│   │
│   ├── agents/
│   │   ├── types.ts           # 공유 인터페이스 (Plan, FileChange, AgentCall 등)
│   │   ├── planner.ts         # Phase 1: Issue → Plan (claude-opus-4-6)
│   │   ├── test-writer.ts     # Phase 2: Plan → 실패 테스트 (claude-opus-4-6)
│   │   ├── implementer.ts     # Phase 3: Plan + 테스트 → 구현 (claude-opus-4-6)
│   │   ├── healer.ts          # Phase 4: 실패 + diff → 수정 (claude-opus-4-6)
│   │   └── reviewer.ts        # Phase 5: 최종 검증 (claude-sonnet-4-6)
│   │
│   ├── utils/
│   │   ├── context-builder.ts # 단계별 에이전트 컨텍스트 구성 (격리 보장)
│   │   ├── test-runner.ts     # 테스트 실행 + Jest 실패 파싱 + TDD 게이트
│   │   ├── git.ts             # clone/branch/checkpoint/diff/push
│   │   └── logger.ts          # 비용·토큰·시간 추적 + Step Summary 출력
│   │
│   ├── fetch-issues.ts        # 대상 레포에서 이슈 수집 (wip 라벨 처리)
│   ├── run-tdd.ts             # 메인 오케스트레이터 (5단계 파이프라인)
│   └── create-pr.ts           # 대상 레포에 PR 생성 + 이슈 코멘트
│
├── package.json
├── tsconfig.json
└── SETUP.md
```

---

## 에이전트 상세

### Phase 1 — Planner (`agents/planner.ts`)

**모델:** `claude-opus-4-6` + adaptive thinking  
**입력:** 이슈 원문, 레포 파일 트리, 기존 테스트 패턴  
**출력:** `Plan` (JSON)

```typescript
interface Plan {
  summary: string;              // 한 문장 요약
  filesToCreate: string[];      // 새로 만들 파일 경로
  filesToModify: string[];      // 수정할 파일 경로
  testStrategy: string;         // 테스트 접근법 설명
  acceptanceCriteria: string[]; // 검증 가능한 수용 기준 목록
  risks: string[];              // 잠재적 위험·모호성
}
```

Planner는 이슈의 요구사항을 분석해 후속 에이전트들이 공유하는 단 하나의 구조화된 계획을 만든다. 후속 에이전트들은 이슈 원문을 직접 읽지 않고 이 계획만을 기준으로 동작한다.

---

### Phase 2 — TestWriter (`agents/test-writer.ts`)

**모델:** `claude-opus-4-6` + adaptive thinking  
**입력:** Plan, 기존 테스트 컨벤션, 수정 대상 소스 파일  
**출력:** `FileChange[]` (테스트 파일)

구현이 존재하지 않기 때문에 실패할 수밖에 없는 테스트를 작성한다.
레포의 기존 테스트 파일 2~3개를 샘플로 참조해 네이밍 컨벤션, import 패턴, 테스트 구조를 맞춘다.

테스트 파일만 작성하고 구현 파일은 절대 작성하지 않도록 시스템 프롬프트에서 강제한다.

---

### Phase 3 — Implementer (`agents/implementer.ts`)

**모델:** `claude-opus-4-6` + adaptive thinking  
**입력:** Plan, 실패 테스트 파일(스펙), 기존 소스 파일  
**출력:** `FileChange[]` (구현 파일)

테스트를 "스펙"으로 간주한다. 테스트가 import하는 경로, 호출하는 함수 시그니처, assert하는 반환값을 기반으로 최소한의 구현을 작성한다.

테스트 파일을 수정하지 않도록 출력 파싱 단계에서 `.test.ts` / `.spec.ts` 파일을 필터링한다.

---

### Phase 4 — Healer (`agents/healer.ts`)

**모델:** `claude-opus-4-6` + adaptive thinking + `effort: "high"`  
**입력:** Plan, 현재 구현, 실패 로그, **이전 iteration의 git diff**  
**출력:** `FileChange[]` + `confidence: "high" | "medium" | "low"`

핵심 설계: 이전 diff를 함께 전달해 동일한 접근법을 반복하는 것을 방지한다.
`effort: "high"`로 설정해 디버깅 작업에 더 깊은 추론을 유도한다.

```typescript
// 매 iteration마다 git checkpoint를 생성
checkpoint(repoRoot, `fix: heal iteration ${i} for issue #${ISSUE_NUMBER}`);

// 다음 iteration에서 이 checkpoint와의 diff를 가져옴
const previousDiff = diffSinceLastCommit(repoRoot);
```

---

### Phase 5 — Reviewer (`agents/reviewer.ts`)

**모델:** `claude-sonnet-4-6` (코드 생성이 없으므로 저비용 모델)  
**입력:** Plan, 최종 테스트, 최종 구현, 테스트 결과  
**출력:** `ReviewResult` (approved, issues, suggestions, summary)

수용 기준 달성 여부, 명백한 버그, 보안 이슈, 유지보수성을 점검한다.
리뷰 결과는 PR description과 GitHub Step Summary에 포함되며, 테스트 미통과 시 PR을 draft 상태로 생성한다.

---

## GitHub Actions 워크플로우

### `poll-issues.yml`

```
트리거: cron(*/30 * * * *) | workflow_dispatch

1. fetch-issues.ts 실행
   - target-repos.json의 레포들을 순회
   - triggerLabel(auto-impl) 이슈 중 wipLabel, doneLabel이 없는 것만 선택
   - 선택된 이슈에 wipLabel 추가 (중복 처리 방지)
   - GitHub Output에 이슈 배열 출력

2. matrix strategy로 이슈별 repository_dispatch 이벤트 발생
   - max-parallel: 1 (레포 충돌 방지)
```

### `implement-tdd.yml`

```
트리거: repository_dispatch(implement-issue) | workflow_dispatch

1. 오케스트레이터 레포 체크아웃 + 의존성 설치
2. run-tdd.ts 실행 (5단계 파이프라인)
   - outputs: branch, tests_passed, review_approved, total_cost
3. create-pr.ts 실행
   - 대상 레포에 PR 생성
   - 테스트 미통과 시 draft PR
   - 이슈에 코멘트 + auto-impl-done 라벨
4. GitHub Step Summary에 실행 결과 출력
5. 실패 시: wip 라벨 제거 (재처리 허용) + 실패 코멘트
```

---

## 설정

### `configs/target-repos.json`

```json
{
  "repos": [
    {
      "owner": "JeanneLee57",
      "repo": "my-repo",
      "testCommand": "npm test",
      "installCommand": "npm install",
      "language": "typescript"
    }
  ],
  "triggerLabel": "auto-impl",
  "wipLabel": "wip",
  "doneLabel": "auto-impl-done"
}
```

| 필드 | 설명 |
|---|---|
| `testCommand` | 테스트 실행 명령어. `pnpm test`, `pytest`, `go test ./...` 등 |
| `installCommand` | 의존성 설치 명령어. `npm ci`, `pnpm install` 등 |
| `language` | 에이전트 시스템 프롬프트 및 코드 블록 파싱에 사용 |
| `triggerLabel` | 이 라벨이 붙은 이슈만 처리 |
| `wipLabel` | 처리 중임을 표시 (중복 실행 방지) |
| `doneLabel` | 처리 완료 표시 |

---

## 환경 변수 / Secrets

GitHub 레포 Settings → Secrets and variables → Actions 에 추가:

| Secret | 설명 |
|---|---|
| `CROSS_REPO_PAT` | Fine-grained PAT. 대상 레포에 `Contents/Issues/Pull requests: Read & Write`, 오케스트레이터 레포에 `Actions: Write` 권한 필요 |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) 에서 발급. Pay-as-you-go (최소 $5 충전) |

**선택적 환경 변수 (워크플로우에서 설정 가능):**

| 변수 | 기본값 | 설명 |
|---|---|---|
| `AI_BUDGET_LIMIT_USD` | `5.00` | 이슈 1개당 최대 AI 비용. 초과 시 즉시 중단 |

---

## 비용 예상

`claude-opus-4-6` 기준 ($5.00/1M input, $25.00/1M output):

| 단계 | 예상 비용 |
|---|---|
| Phase 1: Planner | ~$0.03 |
| Phase 2: TestWriter | ~$0.05 |
| Phase 3: Implementer | ~$0.05 |
| Phase 4: Healer (per iteration) | ~$0.04 |
| Phase 5: Reviewer | ~$0.01 (sonnet) |
| **이슈 1개 합계** | **$0.14 ~ $0.26** |

이슈 복잡도, 기존 코드베이스 크기, healing 횟수에 따라 달라진다.
`AI_BUDGET_LIMIT_USD=5.00`으로 runaway 비용을 차단한다.
