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
- Report p50 and p95 using nearest-rank percentiles, min/max, success/failure counts and all raw samples. Failed samples are listed, excluded from successful latency percentiles, and make the command exit nonzero. Startup is recorded separately. SHA-256 hashes identify the exact source files.
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

2026-11-13 · Windows 10.0.19045 · 12th Gen Intel(R) Core(TM) i5-12400F · Node v24.14.0 · 255 TTF files. Startup: 777.0 ms.

| Case | Success | p50, ms | p95, ms | Text bytes, p50 | PNG bytes, p50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| find_uncached | 20/20 | 110.3 | 136.7 | 445 | — |
| find_cached | 20/20 | 1.1 | 1.2 | 438 | — |
| tree_filtered | 20/20 | 196.2 | 226.6 | 85419 | — |
| table | 20/20 | 146.2 | 159.1 | 22247 | — |
| screenshot | 20/20 | 15.7 | 18.4 | 86 | 32302 |
| task_select_largest | 20/20 | 346.4 | 376.2 | — | — |

[Raw samples and source hashes / Сырые измерения и хеши исходников](benchmark-results.json). Hashes normalize text to LF; the worker BOM is preserved.

The full task succeeded in all 20 measured runs. The screenshot row measures capture only, not finding the largest file from an image. The filtered tree was larger and slower than the table; cached find is reported separately. These results describe this fixture on this machine, not all Windows apps.

Полная задача выполнена в 20 из 20 измерений. Строка screenshot — только захват, без поиска крупнейшего файла по картинке. Фильтрованное дерево оказалось больше и медленнее таблицы; поиск с кэшем показан отдельно. Это результаты конкретного стенда на этой машине.
