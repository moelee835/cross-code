# Cross Code 세션 간 메시징 구현 계획

대상은 같은 로컬 관리형 서버에 연결된 동일 프로젝트의 TUI 세션이다. 개발은 `moelee835/cross-code`의 `dev`에서 진행한다. 아래 작업의 완료 기준은 `session_messaging` 기능을 켠 배포 바이너리에서 열린 세션 조회, 전송, 수신 모델 실행 및 결과 반환을 두 개의 TUI로 재현하는 것이다. [설계와 분석](cross-session-messaging.md)

## 수용 기준

1. A가 B에 요청을 보내면 서버는 요청을 저장하고 `requestID`를 반환한다. 테스트에서 B의 모델 응답을 보류한 상태에서도 A의 다음 도구 호출, 현재 턴 종료, 새 사용자 프롬프트에 대한 응답이 차례로 완료된다. 결과 조회도 한 번의 읽기로 반환된다.
2. B는 유휴 상태면 본문으로 턴을 시작한다. B가 모델 또는 도구를 실행 중이면 기존 inbox 순서와 사용자 `steer` 우선순위에 따라 요청을 처리한다.
3. B가 완료하면 결과가 A의 inbox에 같은 `requestID`로 한 번 들어간다. A가 유휴 상태면 자동으로 결과를 처리한다. A가 다른 작업을 실행 중이면 그 작업을 마친 뒤 결과를 처리한다. 먼저 보낸 요청보다 늦게 보낸 요청이 먼저 완료되더라도 각 결과는 원래 ID로 조회된다.
4. 재시도와 서버 재시작 뒤에도 요청 및 각 결과 통지는 한 건씩 유지된다. 요청과 무관한 사용자 입력이 B의 모델 응답에 섞인 경우 A에는 `needs_reply`만 전달한다. B가 명시적으로 제출한 답변을 같은 요청에 연결한다.
5. 허용된 열린 세션만 목록에 나타난다. 여러 창이 한 세션을 열면 한 번 표시하고, 마지막 창이 닫히거나 만료되면 목록에서 제거한다. 권한 없는 발신자는 세션이나 요청 내용을 조회할 수 없다.

## 작업 순서

| 작업 | 예상 변경 범위 | 완료 증거 |
| --- | --- | --- |
| 0. 기준 환경 준비 | `dev`의 기준 커밋을 기록한다. 로컬 OpenCode와 다른 임시 XDG 디렉터리와 관리형 서버 포트를 사용한다. `package.json`의 Bun `1.4.4`와 `bun.lock`으로 의존성을 설치한다. | 기존 core 세션 테스트와 관리형 서비스 시작·종료가 통과하고, 동일 서버에 붙은 TUI 두 개의 세션 ID를 확보한다. 현재 로컬에서 확인한 Bun은 `1.3.11`이다. |
| 1. 비동기 접수와 inbox 연결 | `packages/schema/src/session-messaging.ts`에 요청 상태와 입력·결과 타입을 추가한다. `packages/core/src/session/messaging/`에 저장소와 호스트 스코프 전달 작업을 추가한다. 기존 `SessionInbox`, `Session.synthetic`, `SessionExecution.wake`에 연결한다. | 실제 DB와 `TestLLM`을 사용하는 Core 테스트에서 B의 첫 모델 입력이 본문을 포함한다. B의 응답을 보류한 동안 A의 후속 작업을 완료하고, 중복 전송에도 B의 입력은 한 건이다. |
| 2. 결과 확정과 재시작 복구 | `session/runner/step.ts`, `session/runner/llm.ts`, `session/projector.ts`, `session/execution.ts`, `session/execution/restart.ts`에서 요청 상태를 실제 입력·모델·종료 경계에 연결한다. 결과의 durable outbox와 재전달을 추가한다. | 한 busy period 안에서 B가 A와 C의 요청을 둘 다 처리해도 각각 올바른 결과를 받는다. 어느 커밋 경계에서 서버가 종료되어도 이후 결과가 정확히 한 번 전달된다. |
| 3. 접근 정책과 공개 진입점 | Core에 세션 참여 설정과 서버 임대를 추가한다. `packages/protocol/src/groups/session-messaging.ts`, `packages/server/src/handlers/session-messaging.ts`를 API에 등록하고 SDK를 생성한다. `packages/core/src/tool/plugin/`과 `plugin/internal.ts`에 내장 도구를 추가한다. | 권한과 수명 검증을 통과한 발신자만 조회·전송한다. 서버 통합 테스트에서 HTTP `202`가 B의 입력 승격보다 먼저 완료될 수 있음을 확인한다. 기능을 끈 상태에서 기존 세션 API와 실행 테스트가 통과한다. |
| 4. CLI와 TUI 연결 | CLI의 `commands/commands.ts`, `src/index.ts` 및 기존 `session` 명령 아래에 핸들러를 붙인다. TUI의 `context/client.tsx`, `context/session-tabs.tsx`, `app.tsx`에서 임대와 재연결을 다룬다. 메시지 기록에 발신처와 결과를 표시한다. | 열린 탭과 현재 세션이 등록되고 닫힌 탭과 더미 ID가 제외된다. 임대 갱신과 응답 처리 중에도 입력창에서 새 프롬프트를 보낼 수 있다. 실제 TUI 두 개로 수용 기준 1~3을 재현한다. |
| 5. 빌드와 프리릴리스 | `packages/cli/script/build.ts`, `packages/util/src/global.ts`, `packages/cli/src/services/service-config.ts`의 바이너리·상태 경로·서버 등록을 격리한다. `updater.ts`의 상류 업데이트 경로를 Cross Code 프리릴리스에서 비활성화하고, 저장소 전용 배포 작업으로 바이너리와 체크섬을 만든다. | macOS arm64와 Linux x64의 CLI를 빌드한다. 설치한 바이너리가 기존 OpenCode와 공존한다. GitHub Release `cross-code-v0.1.0-alpha.1`의 자산과 SHA-256을 확인하고 배포 빌드에서 두 TUI 왕복을 재현한다. |

작업 1의 첫 통합 테스트에서는 테스트용 도구가 실제 Core `send`를 호출한다. 테스트는 전송 접수와 B의 실행을 각각 제어한다. 작업 2에서 최종 출력과 영속 결과를 함께 커밋할 수 있음을 검증한 뒤 공개 API를 연결한다. 내장 도구 등록 후 같은 비동기 시나리오를 실제 도구로 반복한다. CLI와 TUI는 생성된 SDK를 사용한다. 작업 4와 별개로 패키징을 준비할 수 있으며 배포는 수용 기준 통과 후 진행한다.

## 1~2. Core 구현 상세

### 상태와 저장 위치

| 레코드 | 키와 저장 값 | 쓰는 지점 |
| --- | --- | --- |
| 요청 | 기본 키 `requestID`. `(senderSessionID, idempotencyKey)` 유일 인덱스. 원본 본문, 대상 `SessionID`, 고정 요청 `inboxID`, 상태, 전달 sequence, 결과 코드, 최종 assistant 메시지 ID, 공유 텍스트를 저장한다. `recipientSessionID`와 상태를 인덱싱한다. | `send`가 접수한다. 동일 키와 동일 payload는 저장된 값을 반환한다. 동일 키에 대상 또는 본문이 다르면 `409`를 반환한다. |
| 결과 통지 | `(requestID, kind)` 유일 키. 고정 통지 `inboxID`, 통지 종류, 배달 상태를 저장한다. `needs_reply`와 후속 확정 답변은 다른 종류다. | 요청 상태를 바꾸는 트랜잭션에서 통지를 같이 넣는다. 결과 통지용 `inboxID`로 중복을 제거한다. |
| 열린 클라이언트 임대 | 프로세스 메모리의 `leaseID`, 클라이언트가 실제로 연 루트 세션 ID 집합, 서버 시계 기준 만료 시각. | TUI가 등록하고 열려 있는 세션 전체 집합을 갱신한다. 서버는 만료를 조회 및 전송에 즉시 반영한다. |

SQL 정의를 Core 스키마 등록에 연결하고 `packages/core`에서 `bun run migration --name session_messaging` 및 `bun run migration --check`로 생성물과 검증을 관리한다. 기존 DB에 행을 추가하는 마이그레이션과 빈 DB 초기화를 모두 검증한다. 협업 기록은 로컬 호스트 관리 상태로 유지하고, import·fork가 기존 대화 내역을 복사할 때 발송 권한이나 새 전달 작업이 생기지 않게 한다. [마이그레이션 도구](../../packages/core/script/migration.ts) · [세션 이동 및 가져오기](../../packages/core/src/session/transfer.ts)

### 트랜잭션과 실행 연결

1. `send`는 대상의 주소와 정책을 검증한 뒤 요청을 `accepted`로 저장하고 반환한다. 내장 도구는 `context.sessionID`를 발신자로 쓰고, 동일 도구 호출 재시도 키는 `context.messageID`와 `context.id`로 만든다. HTTP·CLI는 호출자가 제공하거나 CLI가 생성한 명시적 키를 사용한다. worker는 서버 스코프에서 접수 신호를 받고, 시작 시 영속 행도 순회한다. [도구 호출 컨텍스트](../../packages/core/src/tool.ts#L365)
2. worker는 고정 `inboxID`를 이용해 `Session.synthetic({ delivery: "queue", resume: false })`를 호출한다. `InboxEnqueued` 투영이 `accepted → queued`를 기록한 뒤 worker가 `SessionExecution.wake`를 요청한다. `InboxDelivered` 투영은 본문을 기록하는 트랜잭션에서 전달 sequence와 `running`을 확정한다. 협업 입력과 통지 두 종류를 각각의 기존 inbox ID로 식별한다. 발신 메타데이터는 Core가 만든다. [등록 및 실행 예약](../../packages/core/src/session/synthetic.ts) · [Inbox 투영](../../packages/core/src/session/projector.ts#L1011)
3. 러너에서 요청별 최종 응답을 결정한다. 계속 실행해야 하는 도구 응답, 길이 제한에 따른 추가 생성, 재시도는 현재 요청에 계속 귀속시킨다. 최종 단계의 정상 종료와 `needsContinuation` 판정을 확인한 경우에만 `Step.Ended`의 트랜잭션에 연결해 완료 상태와 통지를 기록한다. `Bus`의 `commit` 콜백은 투영 이후 같은 트랜잭션에서 실행되므로, 그 시점에 완료된 `assistantMessageID`와 일반 텍스트를 읽을 수 있다. 후속 입력 승격 전에 커밋됨을 먼저 증명한다. 트랜잭션에는 SQL과 투영만 포함하고 A를 깨우는 일은 커밋 뒤에 한다. [단계 정산](../../packages/core/src/session/runner/step.ts#L289) · [러너의 continuation 처리](../../packages/core/src/session/runner/llm.ts#L327) · [Bus 커밋](../../packages/core/src/bus.ts#L398)
4. 수신 요청이 열린 동안 별개의 사용자 입력 또는 독립된 협업 입력이 승격되면 현재 요청을 `needs_reply` 대상이라고 투영한다. 요청과 무관한 모델 텍스트를 결과 outbox에 쓰지 않는다. 정산 후 `session_message_reply`는 원래 수신 세션에서만 가능하고, 확정 응답은 새 통지 ID를 사용한다. 사용자 중단과 모델 실패는 해당 시점에 승격된 요청만 정산한다. `shutdown` 중단은 기존 execution claim 복구 대상으로 유지한다.
5. 결과 worker는 A가 다시 접수 가능한 상태인지 확인한 뒤 결과를 `queue`로 등록하고 `wake`한다. A가 바쁘면 등록된 결과는 다음 입력 경계까지 inbox에 머문다. A가 닫혀 있는 동안의 결과는 교환 기록에서 조회할 수 있고, A의 첫 유효 임대 등록으로 전달을 다시 시도한다. 수신 요청은 접수 후 B의 탭이 닫혀도 해당 `SessionID`로 처리한다. 결과 알림 자체에는 자동 답장이 연결되지 않는다. 연쇄 요청 상한은 모델 인자가 아닌 서버가 추적한 요청·통지 ID로 계산한다.
6. `SessionRestart`와 조정해 기존 claim의 복구 횟수를 기록한 다음 미처리 전달을 kick한다. `accepted`는 입장부터 재시도한다. `queued`의 실제 inbox가 남아 있고 기존 claim 복구가 해당 실행을 소유하지 않을 때 wake를 다시 예약한다. `running`은 기존 claim 경로로 이어가고, 복구 한도를 소진하면 `failed`로 정산한다. 결과 확정 후에만 outbox를 재전달한다. `InboxCancelled`와 revert·archive·delete가 삭제하는 대상은 같은 전이에서 종결하거나 보류한다. 기능 해제와 권한 철회는 등록 및 모델 승격 시점에서 검사한다. 덮어쓰거나 취소된 inbox ID는 재등록하지 않는다. [시작 복구](../../packages/core/src/session/execution/restart.ts) · [호스트 부팅](../../packages/server/src/process.ts#L268)

Layer는 DB와 `Bus`를 쓰는 저장소와 `Session`·`SessionExecution`을 쓰는 호스트 전달 작업의 의존 방향을 유지한다. 러너와 투영은 DB 연산 또는 작은 저장 경계만 호출한다. 서버 라우트와 내장 도구는 같은 Core 정책을 거친다. 열린 세션의 임대 수명은 Core의 실행 claim과 별개다.

## 3~4. API, 도구 및 클라이언트

| 작업 | 실험 API 경로 | 동작 |
| --- | --- | --- |
| 참여 | `PUT /api/experimental/session-messaging/sessions/:sessionID/participation` | 세션별 수신 허용을 저장한다. 초기 기본값은 꺼짐이다. TUI에서 참여 여부를 명시적으로 바꾼다. |
| 임대 | `POST /api/experimental/session-messaging/leases` 및 `PUT`, `DELETE /api/experimental/session-messaging/leases/:leaseID` | 등록·갱신·해제한다. 갱신은 현재 열린 전체 세션 집합을 치환한다. heartbeat 10초, 만료 30초를 초기값으로 검증한다. 재시작으로 임대가 사라지면 클라이언트가 새로 등록한다. |
| 조회 | `GET /api/experimental/session-messaging/sessions/:sessionID/peers` | 발신 세션이 접근할 수 있는 열린 대상 ID, 제목, 실행 상태를 반환한다. |
| 접수 | `POST /api/experimental/session-messaging/sessions/:sessionID/requests` | 본문, 상대 ID, 재시도 키를 받고 `202`로 `requestID`와 접수 상태를 반환한다. 같은 키의 재시도는 기존 레코드의 상태를 반환한다. |
| 결과 | `GET /api/experimental/session-messaging/sessions/:sessionID/requests/:requestID` | 원래 참가자에게 현재 스냅샷을 반환한다. |
| 명시 답변 | `POST /api/experimental/session-messaging/sessions/:sessionID/requests/:requestID/reply` | `needs_reply`인 요청의 수신 세션이 공유할 본문을 확정한다. 같은 답변 재시도에는 기존 결과를 반환한다. |

- 자격이 있는 서비스는 인증을 사용하는 로컬 관리형 프로세스 중 loopback에 바인딩되고 원격 터널이 꺼진 경우다. 이 자격은 CLI의 서비스 모드와 런타임 옵션에서 정한다. HTTP·CLI에서 발신 세션을 지정하는 주체는 이 서버 자격 증명을 가진 로컬 사용자다. 모델 도구의 발신 세션은 호출 컨텍스트에서 정한다. 서버의 참여 정책은 opt-in-only 플래그 `session_messaging`, 송수신 세션 참여, 실제 세션의 프로젝트와 Location을 검사한다. `ProjectID.global`의 공통 ID는 물리적으로 같은 canonical Location일 때만 허용한다. 일반 worktree는 저장된 프로젝트 ID로 연결한다. 수신 메시지로 시작한 도구 실행에는 해당 수신 세션의 권한을 적용한다. [서버 시작 옵션](../../packages/cli/src/server-process.ts#L92) · [프로젝트 해석](../../packages/core/src/project.ts#L361)
- 내장 도구는 `session_peers`, `session_message_send`, `session_message_result`, `session_message_reply` 네 가지다. 참여를 켜는 작업은 사용자가 CLI 또는 TUI에서 한다. 이름과 JSON 출력을 고정하고 기존 `Tool.Service` 변환으로 등록한다. 도구 메시지는 접수된 요청 ID와 계속 처리할 수 있는 상태를 표시한다. SDK 생성은 `packages/client`에서 `bun run generate`로 수행한다. [도구 등록 예제](../../packages/core/src/tool/plugin/session-search.ts) · [Protocol 규칙](../../AGENTS.md)
- CLI는 기존 단수 `session` 명령 그룹을 사용한다. 초기 명령은 `cross-code session peers --from <sessionID>`, `cross-code session send --from <sessionID> --to <sessionID> --text <text>`, `cross-code session result --from <sessionID> <requestID>`, `cross-code session messaging --session <sessionID> --enable|--disable`이다. 명령은 등록된 관리형 서버를 조회하고 전송 또는 결과의 한 번의 호출을 반환한다. 자동화 확인용 `--json`을 제공한다. [기존 명령 등록](../../packages/cli/src/commands/commands.ts#L467)
- TUI는 한 클라이언트 임대로 현재 세션과 열린 루트 탭을 보고한다. 탭 선택과 닫기, 다른 창의 사용, 서버 재연결을 구분한다. `server.connected` 이후 현재 클라이언트가 관측한 집합을 다시 보내며, 종료 시 정리 요청은 세션이나 서버 종료를 지연시키지 않는다. 전송과 결과 상태 갱신은 composer 입력과 별개로 처리한다. [클라이언트 연결](../../packages/tui/src/context/client.tsx) · [탭과 현재 세션](../../packages/tui/src/context/session-tabs.tsx#L190)

## 수용 테스트와 배포 확인

| 검증 경계 | 실행 시나리오 | 기대 결과 |
| --- | --- | --- |
| 발신자 독립 실행 | 실제 내장 도구로 A→B 전송. `TestLLM.gate()`로 B를 정지시킨 상태에서 A의 다음 도구 사용과 후속 사용자 입력을 완료한다. | B의 게이트를 열기 전에 A의 출력 스텝과 사용자 응답 완료가 확인된다. B 완료 뒤 결과는 별도 실행 또는 기존 실행 뒤의 queued 입력으로 도착한다. |
| 요청별 귀속 | A→B, C→B를 연속 등록하고, 별도 케이스에서는 B 실행 중 사람의 `steer`를 넣는다. A→B와 A→C의 완료 순서도 뒤집는다. | 각 결과가 원래 요청과 발신자에게 간다. 섞인 작업에는 `needs_reply` 상태만 전달된다. B의 명시 답변 재시도가 결과를 중복 생성하지 않는다. |
| 장애·재시도 | 접수 직후, inbox 커밋 직후, 최종 단계·결과 커밋 직후, 결과 inbox 커밋 직후에 실제 임시 DB를 다시 열어 복구한다. | 각각 전송 또는 통지를 이어가고 이미 승격된 입력을 재등록하지 않는다. 복구 한도 소진, 사용자 중단, 권한 철회, 기존 inbox 취소에서 상태가 일치한다. |
| 정책과 임대 | 같은 세션의 두 창, 강제 종료 후 만료, 재접속, 서로 다른 프로젝트, 권한 변경 및 비참가자의 결과 조회를 실행한다. | 닫힌 세션의 결과는 나중에 도착한다. 목록은 현재 참여 가능 세션만 반환하고, 참가자 범위와 실행 권한이 유지된다. |
| 기존 동작 | 기능을 끈 상태와 켠 상태 모두에서 수동 입력, 큐 순서, `steer`, revert, 자식 에이전트 복구 및 세션 import를 검증한다. | 기존 세션의 실행과 데이터가 정상 작동한다. |

- Core는 `session-prompt`, `session-runner`, `session-execution`, `session-run-coordinator` 테스트와 새 `session-messaging` 통합 테스트를 패키지 디렉터리에서 실행한다. 실시간 타이머 대신 `TestLLM` 게이트, Effect `Deferred`, 임대 테스트용 시계를 사용한다. Server는 실제 `HttpApi`를, TUI는 실제 renderer와 두 클라이언트를 검증한다. 테스트 작성 전 저장소의 unit/TUI 테스트 지침을 읽는다. [Core 테스트 지침](../../.opencode/skills/unit-tests/SKILL.md) · [TUI 테스트 지침](../../.opencode/skills/tui-tests/SKILL.md)
- 마이그레이션 체크, SDK 생성 후 diff, `bun run check`, 패키지 테스트를 마치면 아티팩트를 빌드한다. 배포 검증은 설치된 Cross Code로 관리 서비스를 시작하고 동일 프로젝트의 TUI 두 개에서 수용 기준 1~3을 반복한다. 다른 설정과 상태 경로를 쓰는 OpenCode도 옆에서 정상 실행되는지 확인한다. 릴리스에 기능 활성화, 지원 OS, 체크섬 확인, 이전 바이너리로 되돌리는 절차를 기록한다.

구현 착수 시 가장 먼저 실패를 드러낼 테스트는 B의 결과가 영속화되기 전 A의 후속 사용자 프롬프트가 끝나는 테스트와, B에 등록한 두 요청의 완료 메시지 ID가 서로 다른지 확인하는 테스트다. 현재 문서는 소스 연결 지점과 검증 절차까지 확정한 계획이다.
