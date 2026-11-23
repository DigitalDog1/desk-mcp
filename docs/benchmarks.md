# Benchmarks / Бенчмарки

Run from an unlocked interactive Windows desktop / запуск в разблокированной сессии Windows:

~~~powershell
npm run bench
~~~

The harness opens its own Font Catalog window and closes that process on exit. It does not move the cursor, type into the active window or change the clipboard. Selftest briefly presses Shift. Font names and sizes come from the current machine; no filename or row count is hardcoded.

Стенд сам открывает и закрывает окно Font Catalog. Курсор не двигается, ввод в активное окно и буфер обмена не используются. Selftest кратко нажимает Shift. Имена и размеры файлов берутся с текущей машины.

## Method / Методика

- Two warmups, then 20 measured repetitions per case. Set BENCH_REPEAT to 5–100 to change this.
- Reading cases rotate order: uncached find (wait 1250 ms before the timed call, exceeding the 1200 ms cache TTL), cached find (prime the same query immediately before the timed call), filtered UI tree, full table, PNG screenshot. Record elapsed MCP-call time, UTF-8 text bytes and actual image bytes/dimensions. A screenshot is capture only; no model reads it.
- Every table result must match every TTF filename and byte size from an independent filesystem oracle.
- Completed task: read the table, compute the largest file from those rows, select it and press Select Font. The GUI click handler writes a result file; the harness checks it against the independently computed maximum. Reset happens outside the task timer. Three MCP calls, plus independent file verification.
- Report p50 and p95 using nearest-rank percentiles, the sample median, min/max, success/failure counts and all raw samples. For even sample counts, the median averages the two middle values; nearest-rank p50 selects the lower one. Failed samples are listed, excluded from successful latency percentiles, and make the command exit nonzero. Startup is recorded separately. SHA-256 hashes identify the exact source files.
- No LLM, fabricated reasoning delay, token pricing formula, simulated visual scanning or competitor comparison. These are local tool and scripted task measurements, not agent-quality measurements.

Два прогрева и 20 измерений. Порядок чтений чередуется. Таблица сверяется с файловой системой целиком; завершение задачи — по файлу, который записывает обработчик кнопки в GUI. Ошибки не скрываются и дают ненулевой код выхода. Размер ответа считается в реальных байтах, а не в придуманных токенах. Скриншот измеряет только захват, без распознавания моделью.

## Reproduce / Повторить

~~~powershell
$env:BENCH_REPEAT = '20'
$env:BENCH_OUTPUT = 'benchmark-results.json'
npm run bench
~~~

Close any other Font Catalog fixtures. Do not interact with the benchmark window during a run. Unset DESK_DRY_RUN, DESK_DISABLE_TOOLS and DESK_ALLOW_TITLES. The default output is benchmark-results.json; commit a deliberately reviewed result, not arbitrary desktop data.

Закройте другие экземпляры Font Catalog и не трогайте окно стенда во время прогона. Отключите DESK_DRY_RUN, DESK_DISABLE_TOOLS и DESK_ALLOW_TITLES. Результат по умолчанию — benchmark-results.json.

Historical one-off agent observations remain in benchmark-tasks.md for context. The previous bench-fonts script used simulated screenshot scanning and a fixed LLM delay; its projected speedups are withdrawn. bench:full remains an exploratory live-window reading report, not a task benchmark.

Прежние наблюдения сохранены в benchmark-tasks.md как история. Прогнозы ускорения из старого bench-fonts с симуляцией скриншотного агента отозваны. bench:full остаётся обзором стоимости чтения живых окон, а не бенчмарком завершённых задач.

## Recorded run / Результат прогона

2026-11-14 · desk-mcp 1.5.2 · Windows 10.0.19045 · 12th Gen Intel(R) Core(TM) i5-12400F · Node v24.14.0 · 255 TTF files. Startup: 814.0 ms.

| Case | Success | p50, ms | p95, ms | Text bytes, p50 | PNG bytes, p50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| find_uncached | 20/20 | 109.6 | 129.9 | 468 | — |
| find_cached | 20/20 | 1.0 | 1.2 | 461 | — |
| tree_filtered | 20/20 | 203.7 | 222.0 | 85419 | — |
| table | 20/20 | 108.9 | 115.4 | 22268 | — |
| screenshot | 20/20 | 15.0 | 17.5 | 86 | 32302 |
| task_select_largest | 20/20 | 259.0 | 291.7 | — | — |

[Raw samples and source hashes / Сырые измерения и хеши исходников](benchmark-results.json). Hashes normalize text to LF; the worker BOM is preserved.

The full task succeeded in all 20 measured runs. The screenshot row measures capture only, not finding the largest file from an image. The filtered tree was larger and slower than the table; cached find is reported separately. These results describe this fixture on this machine, not all Windows apps.

Полная задача выполнена в 20 из 20 измерений. Строка screenshot — только захват, без поиска крупнейшего файла по картинке. Фильтрованное дерево оказалось больше и медленнее таблицы; поиск с кэшем показан отдельно. Это результаты конкретного стенда на этой машине.

## Addressed input / Адресный ввод

Run `npm run bench:input` from an unlocked interactive Windows session. The harness opens disposable windows, changes their focus and clipboard text, and verifies the actual text committed by the fixture. The harness aborts before input if its strict clipboard-text backup fails. Clipboard text is restored; other clipboard formats are not preserved.

~~~powershell
$env:BENCH_REPEAT = '20'
$env:BENCH_BASELINE_ROOT = 'C:/tools/desk-mcp-baseline'
$env:BENCH_OUTPUT = 'benchmark-input-results.json'
npm run bench:input
~~~

Install dependencies in both checkouts first. Omit `BENCH_BASELINE_ROOT` for a standalone candidate run. Two worker sessions are kept separate, including their element references. After two warmups, the harness alternates implementations and rotates four cases: `type` and `paste`, addressed by window/selector or by `elementId`. Activating the other window and resolving references happen outside the timed call. Each sample uses fresh text containing Cyrillic and an emoji.

MCP-call latency is measured separately from the independent fixture-state check. A sample must retain the full returned element description and match the fixture's value, foreground HWND and unchanged unrelated window. Failed samples remain in the report and fail the command. Successful latency summaries report the sample median separately from nearest-rank p50/p95; with an even number of samples, a gap between the two middle values can make median and p50 differ substantially. Startup, raw samples, environment and source hashes are recorded. The pull-request Windows job runs the same harness against the base and candidate checkouts on one runner and uploads its report; no fixed speedup threshold substitutes for correctness.

Both worker processes share the Windows clipboard. The first interleaved comparison observed an extra delay of about five seconds on paste calls following a paste by the other worker, in both implementations. This is an observed association; its internal cause was not traced. [Raw report from that run](https://github.com/DigitalDog1/desk-mcp/actions/runs/45219229630/artifacts/14841145689). Inspect the raw sample sequence when comparing paste results: mixed distributions of repeated-writer and changed-writer calls do not establish a general single-worker paste speedup.

The native input optimization removes unused metadata collection: the ordinary successful `type` path constructs two complete descriptions instead of seven, and nonempty `paste` constructs two instead of eight. These are code-path counts, not measured speedup ratios. Verification now uses a 1500 ms monotonic settling window, so faster polls do not reduce it to ten cheap attempts. This policy can report rejected input later, but can also miss a later application commit that ten expensive probes previously allowed on a slow provider. An in-flight UIA call remains subject to the native/server deadlines.

Для сравнения версий установите зависимости в обоих клонах и задайте `BENCH_BASELINE_ROOT`; без него измеряется только текущая версия. После двух прогревов чередуются версии и четыре сценария: `type`/`paste` по селектору и по `elementId`. Перед каждым вызовом активно другое тестовое окно; подготовка выполняется вне таймера. Проверяются полные метаданные ответа и независимо записанное приложением состояние. Ошибки сохраняются в отчёте и дают ненулевой код выхода. Время MCP-вызова отделено от ожидания независимой проверки; отчёт содержит сырые результаты, медиану, p50/p95, сведения о системе и хеши исходников. p50/p95 вычисляются методом nearest-rank. При чётном числе измерений медиана усредняет два центральных значения, а p50 выбирает меньшее из них; при большом разрыве между ними результаты заметно различаются.

Оба воркера используют общий буфер обмена Windows. В первом чередующемся сравнении вставки после другого воркера получали дополнительную задержку около пяти секунд в обеих версиях. Это наблюдаемая связь; внутренняя причина не была установлена трассировкой. Для `paste` нужно смотреть последовательность сырых измерений: смесь вызовов после того же и после другого воркера не подтверждает общий коэффициент ускорения вставки в обычной сессии с одним воркером.

Два полных описания элемента вместо семи-восьми — количество операций в коде, а не обещанный коэффициент ускорения. Для вывода о скорости нужен фактический отчёт. Явное окно ожидания 1500 мс может увеличить время отказа; на медленном провайдере оно также может закончиться раньше прежних десяти дорогих попыток и не дождаться более позднего изменения значения. Бенчмарк меняет фокус своих окон и общий буфер обмена. Если не удалось прочитать текст для резервной копии, ввод не начинается. В конце восстанавливается текст буфера, остальные форматы не сохраняются.
