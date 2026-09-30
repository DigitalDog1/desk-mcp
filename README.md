# desk-mcp

MCP-сервер управления рабочим столом Windows. 19 инструментов, ноль внешних
зависимостей кроме Node и PowerShell 5.1, которые есть в системе по умолчанию.

Сделан потому, что встроенного computer-use у агента нет, а весь нужный набор —
снимок экрана, клик, ввод, фокус окна, чтение дерева UI — это буквально WinAPI.

## Установка в профиль

Уже прописан в `mcp.json`:

```json
{
  "mcp": {
    "desk-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Users\\DigitalJesus\\.minimax\\workspace\\desk-mcp\\server.mjs"],
      "enabled": true
    }
  }
}
```

## Устройство

```
server.mjs   MCP-сервер (Node, @modelcontextprotocol/sdk), stdio, 19 тулов
worker.ps1   long-running PowerShell: P/Invoke user32 + UIAutomationClient + MSAA
```

Воркер один на весь жизненный цикл сервера, а не процесс на вызов: PowerShell
стартует ~400 мс, `Add-Type` компилирует C# ещё дольше. Обмен — построчно,
ответы в base64: иначе кириллица ломается на кодовой странице консели.

## Инструменты

| Тул | Что делает |
|---|---|
| `computer_screenshot` | Снимок экрана или области. `scale`, `format` (png/jpeg) |
| `computer_screeninfo` | Виртуальный экран и мониторы |
| `computer_permissions` | Проверка UIA, буфера, прав — с конкретными проблемами |
| `computer_click` | Клик. `hoverFirst` для кнопок, живущих только под курсором |
| `computer_move` | Навести мышь |
| `computer_drag` | Перетащить (слайдеры, DnD) |
| `computer_scroll` | Колесо в точке |
| `computer_type` | Юникодный ввод через `SendInput` + `KEYEVENTF_UNICODE` |
| `computer_key` | Комбинации: `ctrl+c`, `alt+tab`, `f5`, `return` |
| `computer_windows` | Верхнеуровневые окна: заголовок, pid, класс, границы |
| `computer_focus` | Фокус окна с обходом отказа `SetForegroundWindow` |
| `computer_wait_window` | Дождаться окна, с таймаутом и внятной ошибкой |
| `computer_close_window` | Закрыть окно (или убить процесс) |
| `computer_launch` | Запустить программу |
| `computer_read_screen` | **Дерево UI**: роли, имена, id, границы. UIA + MSAA |
| `computer_element_at` | Что находится в точке — цепочка элементов до окна |
| `computer_clipboard_get` / `_set` | Буфер обмена |
| `computer_selftest` | Проверка канала целиком |

### Семантический слой (перенесён из встроенного computer-use)

| Тул | Что делает |
|---|---|
| `computer_find` | Находит элемент по имени/роли/`automationId`: границы, паттерны, **текущее значение**, `enabled`, `selected` |
| `computer_invoke` | Жмёт через UIA `InvokePattern` — **без захвата мыши и без перевода окна вперёд**; откат на клик, если паттерна нет |
| `computer_set_value` | Пишет значение через `ValuePattern`, без фокуса и без эмуляции клавиш |
| `computer_select_text` | Клик по полю + Ctrl+A |
| `computer_verify_state` | 1–8 предикатов: существует / `value_equals` / `enabled` / `selected` → `satisfied` / `unsatisfied` / `unknown` |
| `computer_window_set_frame` | `MoveWindow`: переместить/изменить размер, возвращает запрошенную и фактическую геометрию |
| `computer_active_window` | Какое окно в фокусе: pid, процесс, заголовок |

Проверено вживую на Edge:

```
set_value  → "https://example.com/проверка"   (кириллица держится)
find       → value: "https://store.steampowered.com/app/281990/Stellaris/"
verify     → satisfied
invoke     → via: InvokePattern, вкладка открылась БЕЗ захвата мыши
```

`find` не выдаёт одноразовый токен, как `computer_app_state`: вместо этого
элемент переищется по `automationId`/имени/роли при каждом действии. Токен
протухает при перерисовке дерева, а дескриптор — нет.

## Два бэкенда чтения UI, и зачем

`computer_read_screen` сначала пробует **UIA** (UI Automation), и если дерево
пустое — откатывается на **MSAA** (`oleacc.dll`).

Причина: Chromium-приложения (Discord, Chrome, VS Code, Slack) отдают
UIA-дерево **только** если запущены с `--force-renderer-accessibility`.
Без него окно выглядит пустым листом, хотя MSAA у них есть всегда.

`backend: "auto" | "uia" | "msaa"` — можно форсировать. В ответе всегда видно,
какой бэкенд сработал и на какой глубине.

Chromium заворачивает содержимое в 5 слоёв `PANEL` → `SCROLLPANE` → `CLIENT` →
`GROUPING` без имён. Поэтому безымянные прокладки разворачиваются (вместо
прокладки в дерево идут её дети), а если полезных узлов не нашлось, глубина
автоматически удваивается. На Discord это даёт «Назад», «Почту», «Серверы»,
«Приватные каналы» за ~230 мс.

## Ловушки, на которые уже наступили

Все воспроизведены на этой машине, Windows 11, PowerShell 5.1.

1. **`.ps1` обязан быть с BOM.** Без BOM PS 5.1 читает файл как ANSI и молча
   ломает разбор кириллицы.
2. **`KEYBDINPUT` — поля `ushort`, а не `uint`.** Объявишь `uint` — структура
   станет 32 байта вместо 24, `dwFlags` уезжает, и `SendInput` не падает, не
   ругается, не возвращает ошибку. Он молча ничего не делает.
3. **`SendKeys` не умеет кириллицу** и вообще ненадёжен. Только `SendInput`.
4. **В PowerShell тип называется `[uint16]`.** `[ushort]` — это C#-алиас, в PS
   такого типа нет; вызов падает с `InvalidOperationException`.
5. **Нельзя назвать C#-метод `Move` или `Wheel`.** PowerShell 5.1 отдаёт
   `RuntimeException: does not contain a method named 'Move'`, хотя
   `[DeskMcp].GetMethod("Move")` прекрасно его находит. Обойдено именами
   `MoveTo` и `ScrollWheel`.
6. **`OrderedDictionary` разворачивается при возврате из функции** — нужен
   `return , $node`, иначе в JSON вместо объекта приходит строка
   `System.Collections.Specialized.OrderedDictionary`.
7. **RCW теряет интерфейс при возврате в PowerShell.** `Accessibility.IAccessible`
   доходит как `System.__ComObject`, и приведение падает. Всю работу с COM
   держим внутри C#, наружу отдаём только готовые узлы.
8. **Компилятор `Add-Type` в PS 5.1 — это C# 5.** Никакой интерполяции `$"..."`.
9. **К `Add-Type` для MSAA нужен `-ReferencedAssemblies Accessibility`**, иначе
   `Accessibility.IAccessible` не резолвится.
10. **Кодировка обмена.** Ответы в base64. Иначе кириллица в JSON ломается.
11. **Пустой PNG и «канал сломан» выглядят одинаково** — отсюда `computer_selftest`.
12. **Блокнот не прокручивается ничем, кроме клика по полосе прокрутки.**
    `mouse_event(MOUSEEVENTF_WHEEL)` и `PageDown` он игнорирует.

## Ограничения Windows, которые не обойти

- **UIPI:** инъекция ввода блокируется в окна, запущенные с повышенной
  elevation. Это политика Windows, а не ошибка.
- **Буфер:** `Set-Clipboard -Path` кладёт в буфер **файл**, а не текст. Здесь
  используется только `-Value`.
- **Chromium без accessibility-флага** не отдаёт UIA — отсюда MSAA-фоллбэк.

## Что нашло независимое ревью и что исправлено

Ревьюер гонял сервер вживую (19 тулов, stdio, реальные окна) и нашёл 16 дефектов.
Четыре были блокирующими, все закрыты:

1. **`ConvertTo-Json -Depth 12` молча портил дерево UI.** Узел — это ~2 уровня
   вложенности, поэтому `-Depth 12` вмещал ~5 уровней дерева. Глубже PS
   подставлял строку `"System.Collections.Specialized.OrderedDictionary"`.
   Измерено было до 107 заглушек в ответе — модель получала правдоподобный
   JSON, где вместо кнопок имя .NET-типа. **Это подрывало ровно то, ради чего
   тул написан.** Поднято до 32, заглушек 0 при 181 именованном элементе.
2. **`selftest` захардкожен на «здоров»:** `sendInputOk = $true` литералом, а
   `SendInput` не вызывался вовсе (пустая строка даёт 0 событий). Теперь
   реально вводит пробную строку и сверяет счётчик.
3. **`type` врал при заблокированном вводе:** безусловный `ok = true` при
   `events: 0` из-за UIPI. Теперь бросает ошибку — как уже делал `key`.
4. **Смерть воркера была необратимой:** после `kill` дальнейшие вызовы вечно
   давали «Воркер не запущен», при том что MCP-сервер продолжал рекламировать
   все 19 тулов. Добавлен авто-рестарт (лимит 5) и обработчик `error` —
   без него падение `spawn` роняло Node с голым стектрейсом.

Из среднего закрыто: неверный список интерактивных ролей MSAA (не содержал
22/24/25/41/42/46 — настоящие кнопки, чекбоксы и ссылки выкидывались);
неэкранированный `-like` (фильтр `Report [Draft]` матчил `Report r`, а для
`close_window -Force` это «убить не то окно»); попытка GDI-утечки в
`Save-Screenshot` (закрыто через `try/finally`).

Что осознанно оставлено: воркер однопоточный, поэтому один очень долгий
вызов глушит очередь; `interactiveOnly` на MSAA фильтрует только листья,
а не контейнеры; MSAA-координаты в некоторых сборках Windows возвращаются
корректно, но в этой задаче не используются; защиты в глубину (allowlist
для `launch`, подтверждение `close_window -Force`) нет — экспозиция полного
контроля над десктопом by design, ровно как у macOS-референта.

## Ограничения, которые остались

- **UWP-окна** (например «Параметры») не отдают ни UIA-, ни MSAA-дерево.
- **`interactiveOnly` на MSAA** фильтрует листья, контейнеры остаются.
- **Медленный вызов блокирует очередь** (воркер однопоточный).

## Сравнение со встроенным computer-use (CUA Driver 0.22.1)

Проверено на одном и том же окне Edge, обе системы запускались раздельно.

**Что лучше у встроенного `computer_*`:**
- Одноразовые `element_token` прямо в наблюдении.
- Готовые предикаты `computer_verify_state` из коробки.
- `computer_window_set_frame`, `computer_app_list/activate` по AUMID,
  `computer_secondary_action` (нативные меню), `computer_select_text`.
- Скилл с жёсткими правилами observe→act→verify, который запрещает угадывать.

**Что лучше здесь:**
- `element_at` — обратное направление (координата → элемент); у них такого нет.
- Скриншот отдельным тулом: произвольный регион, `scale`, JPEG. У них только
  `computer_desktop_state`/`computer_app_state` и только primary display.
- MSAA-фоллбэк и автонаращивание глубины для Chromium.
- Автономность: свой MCP-сервер без `cua-driver.exe` и без привязки к хосту —
  значит работает в любом агенте, в Hermes, в чужом клиенте MCP.
- Нет одноразовых токенов: элемент переищется по `automationId`, поэтому
  протухание токена при перерисовке дерева невозможно.

Итог: это не замена, а разделённые слои. Их сила — семантика и верификация,
моя — пиксели, произвольные регионы и автономность. Семантический слой перенесён
выше, так что `desk-mcp` теперь закрывает обе задачи.

### Chromium через Chrome DevTools Protocol

| Тул | Что делает |
|---|---|
| `computer_browser_start` | Поднимает Chrome/Edge в debug-режиме с отдельным профилем и портом 9222 |
| `computer_browser_list` | Вкладки: заголовок, URL, id |
| `computer_browser_tree` | **Настоящий DOM**: интерактивные элементы с готовым CSS-селектором, текстом, role, value, checked, границами |
| `computer_browser_descendants` | Содержимое контейнера по селектору, до 200 потомков |
| `computer_browser_click` | Клик по селектору **с доказательством попадания** |
| `computer_browser_eval` | Произвольный JS в контексте страницы |

Зачем, если уже есть UIA и MSAA: обе для Chromium — костыль. UIA отдаёт обрезанное
дерево в безымянных `PANEL`, MSAA — медленнее и без селекторов. CDP даёт то, чего
не даёт ни один из них: готовый CSS-селектор и текст элемента.

Верификация клика двумя независимыми способами, потому что проба в
`window.__deskProbe` умирает вместе со страницей при переходе:

```
verified=true via=navigation   https://example.com/ -> https://www.iana.org/help/example-domains
verified=true via=probe        hit={"tag":"A","text":"ТестКнопка","trusted":true}
```

### Пиксели, окна, пачки

| Тул | Что делает |
|---|---|
| `computer_ocr` | **OCR через движок, встроенный в Windows** (`Windows.Media.Ocr`, есть ru/en). Читает текст прямо из пикселей там, где нет ни UIA, ни MSAA: игры, видео, GPU-контент. Ноль моделей. Возвращает строки и слова с границами — по границе слова можно кликнуть |
| `computer_screenshot` + `window` | Снимок конкретного окна через `PrintWindow` с `PW_RENDERFULLCONTENT` — работает даже если окно перекрыто или свёрнуто |
| `computer_batch` | До 50 инструментов за один вызов, с остановкой на первой ошибке и результатом по каждому шагу |
| `computer_bench` | Поднимает тестовое окно с контролами и логом событий — проверки не зависят от того, что открыто у пользователя |
| `computer_desktop` | Виртуальные рабочие столы: list / create / switch / close / move_window |

Замеры на этой машине: OCR области 1300×500 — 181 мс, всего экрана 2560×1440 — 248 мс и
81 строка. PrintWindow окна 811×708 — 60 мс.

### Что Windows не даёт

- **Виртуальные рабочие столы недоступны** на этой сборке (Win10 19045):
  `VirtualDesktopManager.dll` отсутствует, CLSID не зарегистрирован,
  `SM_DESKTOPSWITCHOVERDESKTOP = 0`. Инструмент `computer_desktop` на месте и
  заработает там, где сты поддерживаются, но здесь честно возвращает ошибку.
- **Окна, созданные процессами, запущенными агентом, не попадают на
  интерактивный десктоп.** `computer_bench` поднимает окно (лог говорит
  `visible=True`), но на экране его нет и UIA его не индексирует. Агент при
  этом сам находится в интерактивной станции `WinSta0\Default`. Поэтому
  в `smoke.mjs` стенд — мягкая проверка, а не провал: у человека в его сессии
  стенд работает.
- **Эксклюзивный полный экран** для скриншотов даёт чёрные кадры: нужен DXGI
  Desktop Duplication, как в `zavora-ai/computer-use-mcp` (у них это есть,
  в Rust NAPI-модуле).

## Сравнение с тем, что уже есть на GitHub

Ниша computer-use MCP на Windows не пустая, и там есть крупнее:

| Репозиторий | Тулов | Язык/платформа | Заметка |
|---|---|---|---|
| [CursorTouch/Windows-MCP](https://github.com/cursortouch/windows-mcp) | ~14 | Python, Windows 7–11 | дефолт для Windows, читает UIA-дерево |
| [zavora-ai/computer-use-mcp](https://github.com/zavora-ai/computer-use-mcp) | 58 | Rust NAPI, macOS+Windows+Linux | npm-установка, IUIAutomation напрямую |
| Cua Driver | — | кроссплатформ | background input, CLI + MCP + SDK |
| Peekaboo | 24 | macOS | самый глубокий macOS-набор |
| [computer-control-mcp](https://github.com/AB498/computer-control-mcp) | — | Python, PyAutoGUI + OCR | 70 МБ моделей при первом запуске |
| [winremote-mcp](https://github.com/dddabtc/winremote-mcp) | 40+ | Python, remote | управление удалёнными Windows |

**Чем этот отличается:** у Windows-MCP тоже есть `tree/ia2.py` — MSAA-фоллбэк
придуман не здесь, и врать об этом не надо. Реальные отличия:

1. **Три слоя чтения подряд.** UIA → MSAA → **CDP**. Для Chromium последний
   даёт настоящий DOM с селекторами; у Windows-MCP и computer-use-mcp читается
   только UIA, у computer-control-mcp — вообще пиксели плюс OCR.
2. **Верификация действий встроена.** `computer_verify_state` для нативных окон,
   проба + контроль URL для веб-страниц. У конкурентов клик считается успешным,
   если отправлен.
3. **Ноль бинарных зависимостей:** ни `uvx`/Python, ни Rust NAPI, ни 70 МБ OCR.
4. **37 тулов из коробки**, включая семантические (`find`/`invoke`/`set_value`) и
   CDP-режим.

## Что на GitHub не выкладывается, а выкладывается

Код оригинальный, зависимости MIT (`@modelcontextprotocol/sdk`, `zod`), лицензия
MIT. Идеи (MCP-обёртка + нативный хелпер) взяты из
[virajshoor/opencode-computer-use](https://github.com/virajshoor/opencode-computer-use),
конкретный код не копировался.

## Проверка

```powershell
cd C:\Users\DigitalJesus\.minimax\workspace\desk-mcp
node smoke.mjs
```

Ожидаемый хвост: `ИТОГ: 39 ок, 0 провалов`.

**В автопрогоне нет ни одного действия, которое двигает курсор.** Только чтение:
снимки, окна, дерево UI, OCR, буфер, CDP-чтение. Мышь и клавиатуру не трогаем
во время самопроверок — проверяются вручную.
