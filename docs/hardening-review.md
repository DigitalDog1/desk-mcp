# Hard-test review / Разбор хард-теста

2026-11-14 · desk-mcp 1.5.2 · baseline: f4fa67f1820ccd99cf83d99481de0c0135c71fb0.
Local environment: Windows 10.0.19045, PowerShell 5.1, Node 24.14.0. The supplied reports used Windows 11 with 150% scaling; this run does not establish compatibility with that exact environment.

| Report | Finding and disposition |
| --- | --- |
| N1 | Defender/AMSI block was not reproduced here. Worker exits now preserve diagnostics and classify a recognized antivirus block as SecurityBlocked. The classifier is tested with synthetic stderr; no claim that the reported detection is resolved. |
| N2 | Global cooldown was not reproduced. A protocol regression forces an unscoped timeout, then verifies another target is attempted and only the original key returns UIABlocked. |
| N3 | Table-limit finding was withdrawn in the supplied report. The fixture independently verifies 3 rows × 1 column from an 800-row ListView. |
| N4, N7 | Neighboring controls were found on the baseline 800-row fixture. Code review confirmed partial searches could be reported as missing targets. Search now visits shallow controls first and returns SearchIncomplete when traversal cannot establish absence. |
| N5 | Static inspection confirmed unscoped control mutations could reach a desktop-wide search. No baseline unscoped action was executed. Regression verifies rejection before dispatch; element mutations require an elementId or a window plus a selector. |
| N6 | Reproduced: normal click returned success at the requested point while the pointer stayed elsewhere and the fixture button received zero clicks. Fixed; independent button counter and pointer coordinates now match. |
| N8 | Plain background WinForms input worked on this baseline. False success was reproduced with a field rejecting non-digit input: reply ok:true, actual field empty. Addressed type/paste now check window and field focus, validate SendInput counts and compare the resulting value; rejected input returns InputNotVerified. Read-only fields are refused before input. Global computer_type reports verified:false. |
| N9 | Reproduced: focusing window B of one process left A foreground. Exact hwnd is now used and foreground ownership is checked. Related resize, close, virtual-desktop routing and OCR capture paths also use the selected hwnd. Resize and secondary-window close have independent fixture checks. |
| N10 | Full-read baseline reset was not reproduced. Regression checks auto → full → auto with the original token and requires a diff. |
| N11 | Native timeout was classified as NotSupported and could enter the PowerShell fallback. Timeout now propagates, terminates the abandoned worker and trips the matching breaker. A deliberately hung fixture must fail within 10 s with the server watchdog set to 15 s, then return UIABlocked. |
| N12 | Silent audit write failures were confirmed in code. An unusable requested log fails startup with AuditUnavailable; later write failures are printed to stderr. A real nonexistent-parent startup test and worker diagnostic test cover this. |
| N13 | The previous 120 s batch budget could outlive a client's deadline. Default is now 45 s with a configurable timeoutMs. A 200 ms test preserves the completed step and failing step, then verifies the next mutation never executes. Client cancellation is also propagated and tested. A client that already stopped waiting cannot receive partial results; choose a shorter server deadline. |

## Checks / Проверки

- 21 module and MCP protocol tests passed.
- 18 disposable-window regression checks passed.
- Smoke: 72 passed, 0 failed, 6 skipped. Skips concern unavailable live-window/demo features; positive control/table/input cases are exercised by the disposable fixture.
- Syntax, EN/RU docs parity, UTF-8 BOM and package checks passed.
- Benchmark: 20/20 successful measured runs in each of six cases, plus two warmups per case. [Raw samples and source hashes](benchmark-results.json).

Run the interactive checks with npm run test:hardening. The fixture opens two windows in one process, reports state through independent files, rejects selected input, and deliberately blocks its own UI thread. It moves the real cursor and uses the clipboard; only clipboard text is restored. Native input cannot eliminate the race between a focus check and another process taking focus, so inspect state after an interrupted action.

## По-русски

Воспроизведены неправильный обычный клик, выбор главного окна вместо указанного и ложный успех при отклонённом вводе. Исправлены адресация окон, проверки фокуса и результата ввода, обработка нативного тайм-аута, неполный поиск, ошибки журнала и остановка пакетов по дедлайну/отмене. Действия над элементом без явной цели запрещены.

Глобальная блокировка другого окна и сброс auto-базы после full здесь не подтвердились. Ошибку лимитов таблицы автор отчёта отозвал. Блокировка Defender в этой среде не воспроизведена: добавлена диагностика, но считать совместимость с той конфигурацией Windows 11 исправленной нельзя. Проверки фокуса уменьшают риск ошибочного ввода; они не делают системную клавиатуру атомарной.
