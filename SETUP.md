# GitHub Orchestrator - Setup Guide

## 1. Personal Access Token (Fine-grained PAT) 발급

GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens

**Required permissions per target repo:**
- `Contents`: Read and Write (브랜치 생성, 코드 푸시)
- `Issues`: Read and Write (라벨 추가, 코멘트)
- `Pull requests`: Read and Write (PR 생성)
- `Metadata`: Read

**또한 orchestrator 레포 자체에도:**
- `Contents`: Read
- `Actions`: Write (workflow dispatch)

## 2. 이 레포에 Secrets 추가

GitHub 레포 → Settings → Secrets and variables → Actions

```
CROSS_REPO_PAT   = <발급한 Fine-grained PAT>
ANTHROPIC_API_KEY = <Anthropic API 키>
```

## 3. target-repos.json 수정

```json
{
  "repos": [
    {
      "owner": "YOUR_GITHUB_USERNAME",
      "repo": "your-target-repo",
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

## 4. 사용법

### 자동 (cron)
이 레포를 GitHub에 push하면 30분마다 자동으로 폴링합니다.

### 수동 트리거
1. 대상 레포에서 이슈 생성
2. 이슈에 `auto-impl` 라벨 추가
3. poll-issues 워크플로우가 감지 → implement-tdd 워크플로우 자동 실행
4. PR이 대상 레포에 생성됨

### 직접 트리거 (테스트용)
GitHub Actions → "Implement Issue via TDD" → Run workflow
→ 입력값 채워서 실행

## 5. 파이프라인 흐름

```
[cron: 30분마다]
    ↓
poll-issues.yml
    └─ fetch-issues.ts (대상 레포들 스캔)
        └─ auto-impl 라벨 있는 이슈 발견
            └─ wip 라벨 추가
            └─ repository_dispatch 이벤트 발생
                ↓
        implement-tdd.yml
            └─ run-tdd.ts
                └─ 대상 레포 clone
                └─ 브랜치 생성 (auto-impl/issue-N)
                └─ Claude → 실패하는 테스트 작성
                └─ 테스트 실행 (실패 확인)
                └─ Claude → 테스트 통과하는 구현 작성 (최대 3회)
                └─ 브랜치 push
            └─ create-pr.ts
                └─ 대상 레포에 PR 생성
                └─ 이슈에 코멘트 추가
                └─ wip → auto-impl-done 라벨 교체
```

## 6. 대상 레포에 필요한 것

- 테스트 명령어가 `npm test` 형태로 실행 가능해야 함
- 테스트 파일 위치를 Claude가 추론할 수 있도록 기존 테스트 파일이 있으면 좋음

## 7. 비용 예상

이슈 1개당:
- Claude API (claude-opus-4-6): 약 $0.05~0.20 (이슈 복잡도에 따라)
- GitHub Actions: 무료 티어에서 약 5~15분 사용
